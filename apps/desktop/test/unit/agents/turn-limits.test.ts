// Turn consequences for the account (PR1): every limit cools the account – also after tool calls,
// where no failover runs – with the provider's retry hint or a default; a limit that only used up
// the model's own window (weekly-opus) keeps the account for other models; 'not signed in' sets
// needs_login with one notification on a Codex/Claude Code plan and lets the next plan run; a CLI
// confirmed missing sets error; overload, connection trouble, a CLI that could not start and a
// rejected API key only get a short cooling. Uses the real AccountService and a router stub that
// asks it for candidates the way the real router does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { accountFailure } from '../../../src/runtime/accounts/failure.ts';
import { AccountServiceImpl, type AccountServiceDeps } from '../../../src/runtime/accounts/service.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { EngineId, ProviderId } from '../../../src/shared/model/providers.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { account } from '../models/harness.ts';
import { setup, type Script } from './fixture.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const LIMIT: EngineTurnResult = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };
const unavailable = (message: string): EngineTurnResult => ({ text: '', stop: 'error', error: { code: 'unavailable', message } });
const withTool: (result: EngineTurnResult) => Script = (result) => async (input) => {
  input.onEvent({ type: 'tool_start', callId: 'toolu_1', name: 'tasks.create', args: {}, own: false });
  input.onEvent({ type: 'tool_end', callId: 'toolu_1', ok: true, summary: 'created' });
  return result;
};

/** Two Claude Code plans (or two accounts of `provider`): acc_1 is used first, acc_2 is the second one (rotation on by default). */
function limitSetup(options: { rotation?: boolean; provider?: ProviderId & EngineId } = {}) {
  const provider = options.provider ?? 'claude';
  const h = setup();
  const unused = () => { throw new Error('not used in this test'); };
  const service = new AccountServiceImpl({
    db: h.db, bus: h.bus, clock: h.clock, paths: { accounts: 'accounts' }, engines: unused,
    finder: {} as AccountServiceDeps['finder'], supervisor: {} as AccountServiceDeps['supervisor'], secrets: {} as AccountServiceDeps['secrets'],
  });
  const now = h.clock.now();
  const repo = new AccountRepo(h.db);
  repo.save(account('acc_1', provider, { label: provider === 'claude' ? 'Claude Code' : provider, createdAt: now }));
  repo.save(account('acc_2', provider, { label: provider === 'claude' ? 'Claude Code 2' : `${provider} 2`, priority: 1, rotation: options.rotation ?? true, createdAt: now + 1 }));

  const calls: string[] = [];
  const scripts: Record<string, Script> = {};
  const state: { model: string; pin?: string } = { model: OPUS };
  h.state.script = (input) => { calls.push(input.account.id); return (scripts[input.account.id] ?? (async () => ({ text: 'Done.', stop: 'done' })))(input); };
  Object.assign(h.services, {
    accounts: service,
    router: {
      route: async (request: RouteRequest) => {
        const pick = state.pin ?? service.candidates(provider, state.model).find((item) => !request.exclude?.includes(item.id))?.id;
        if (!pick) throw new WorkforceError('unavailable', 'Every account that can run a suitable model is limited right now.');
        return { ...h.route, modelId: `${provider}:${state.model}`, accountId: pick };
      },
    },
  });
  let runs = 0;
  const run = () => new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++runs}` }));
  const failovers = () => h.items.filter((item) => item.kind === 'note' && (item.data as { failover?: unknown }).failover)
    .map((item) => (item.data as { failover: { fromAccount: string; toAccount: string; reason: string } }).failover);
  const todos = () => h.notified.filter((item) => item.kind === 'todo'); // not the chat's reply notifications
  return { ...h, service, calls, scripts, state, run, failovers, todos, now };
}

test('a limit after a tool call leaves the account cooling, so the next turn runs on the backup plan', async () => {
  const h = limitSetup();
  h.scripts.acc_1 = withTool(LIMIT);
  await h.run();
  assert.deepEqual(h.calls, ['acc_1'], 'no failover once a tool ran');
  const cooled = h.service.get('acc_1')!;
  assert.equal(cooled.state, 'cooling');
  assert.equal(cooled.coolingUntil, h.now + 15 * MINUTE, 'default limit cooling');

  // The ownership retry / next turn does not land on the used-up plan again.
  h.calls.length = 0;
  const next = await h.run();
  assert.equal(next.status, 'done');
  assert.deepEqual(h.calls, ['acc_2']);

  // Once the cooling ended the plan is used first again.
  h.clock.advance(15 * MINUTE);
  h.calls.length = 0;
  await h.run();
  assert.deepEqual(h.calls, ['acc_1']);
});

test('a limit before any tool call cools the account with the provider hint and fails over to the backup', async () => {
  const h = limitSetup();
  h.scripts.acc_1 = async () => ({ ...LIMIT, error: { ...LIMIT.error!, retryAfterMs: 2 * HOUR } });
  const outcome = await h.run();
  assert.equal(outcome.status, 'done');
  assert.deepEqual(h.calls, ['acc_1', 'acc_2']);
  assert.deepEqual(h.failovers(), [{ from: `claude:${OPUS}`, fromAccount: 'acc_1', to: `claude:${OPUS}`, toAccount: 'acc_2', reason: 'limit' }]);
  assert.equal(h.service.get('acc_1')!.coolingUntil, h.now + 2 * HOUR);
  assert.equal(h.service.get('acc_2')!.state, 'ok');

  // A reset "now" (retry hint 0) still waits a minute, so retries never spin on a used-up plan.
  const zero = limitSetup();
  zero.scripts.acc_1 = withTool({ ...LIMIT, error: { ...LIMIT.error!, retryAfterMs: 0 } });
  await zero.run();
  assert.equal(zero.service.get('acc_1')!.coolingUntil, zero.now + MINUTE);
});

test('rotation off: with the primary cooling no plan of that provider runs', async () => {
  const h = limitSetup({ rotation: false });
  h.scripts.acc_1 = async () => LIMIT;
  await h.run();
  assert.deepEqual(h.calls, ['acc_1'], 'the second plan is not used automatically');
  assert.equal(h.service.get('acc_1')!.state, 'cooling');
  const next = await h.run();
  assert.equal(next.status, 'failed');
  assert.match(next.error ?? '', /limited right now/);
  assert.deepEqual(h.calls, ['acc_1']);
});

test('a limit on the model window (weekly-opus) keeps the account for other models', async () => {
  const h = limitSetup();
  h.scripts.acc_1 = async (input) => {
    if (input.model !== OPUS) return { text: 'Done.', stop: 'done' };
    // Claude reports the rejected window first (rate_limit_event → limits), then the turn ends with a limit.
    input.onEvent({ type: 'limits', limits: { windows: [{ name: 'weekly-opus', windowMinutes: 10080, usedPercent: 100, resetsAt: h.now + DAY }], readAt: h.now } });
    return LIMIT;
  };
  await h.run();
  assert.deepEqual(h.calls, ['acc_1', 'acc_2'], 'this opus turn moves to the backup');
  const kept = h.service.get('acc_1')!;
  assert.equal(kept.state, 'ok');
  assert.equal(kept.coolingUntil, undefined);
  assert.deepEqual(h.service.candidates('claude', OPUS).map((item) => item.id), ['acc_2']);
  assert.deepEqual(h.service.candidates('claude', SONNET).map((item) => item.id), ['acc_1', 'acc_2']);

  // A sonnet turn runs on the first plan again.
  h.calls.length = 0;
  h.state.model = SONNET;
  await h.run();
  assert.deepEqual(h.calls, ['acc_1']);
});

test("'not signed in' sets needs_login with one notification (not cooling); the next plan runs without rotation", async () => {
  const h = limitSetup({ rotation: false });
  h.scripts.acc_1 = async () => unavailable('Claude Code is not signed in for this account.');
  const outcome = await h.run();
  assert.equal(outcome.status, 'done');
  assert.deepEqual(h.calls, ['acc_1', 'acc_2'], 'the signed-out primary does not shut out the second plan');
  assert.deepEqual(h.failovers().map((item) => item.reason), ['unavailable']);
  const signedOut = h.service.get('acc_1')!;
  assert.equal(signedOut.state, 'needs_login');
  assert.equal(signedOut.coolingUntil, undefined, 'no "Limit reached" chip');
  assert.deepEqual(h.todos().map((item) => item.title), ['Sign in to Claude Code']);

  // Later turns stay on the second plan; a repeated sign-in failure does not notify again.
  h.calls.length = 0;
  await h.run();
  assert.deepEqual(h.calls, ['acc_2']);
  h.state.pin = 'acc_1';
  await h.run();
  assert.equal(h.todos().length, 1);
});

test('a CLI confirmed missing sets error without cooling; overload or a lost connection only cools briefly', async () => {
  const missing = limitSetup();
  missing.scripts.acc_1 = async () => unavailable('Claude Code is not installed.');
  await missing.run();
  assert.deepEqual(missing.calls, ['acc_1', 'acc_2']);
  assert.equal(missing.service.get('acc_1')!.state, 'error');
  assert.equal(missing.service.get('acc_1')!.coolingUntil, undefined);
  assert.equal(missing.todos().length, 0);

  const overload = limitSetup();
  overload.scripts.acc_1 = withTool(unavailable('The provider is overloaded. Retry later.'));
  await overload.run();
  assert.deepEqual(overload.calls, ['acc_1']);
  assert.equal(overload.service.get('acc_1')!.state, 'cooling');
  assert.equal(overload.service.get('acc_1')!.coolingUntil, overload.now + 5 * MINUTE);
  overload.clock.advance(5 * MINUTE);
  overload.calls.length = 0;
  await overload.run();
  assert.deepEqual(overload.calls, ['acc_1'], 'back after the short cooling');
});

test('a Codex plan that could not start (slow or crashed app-server) only cools briefly, it is not marked missing', async () => {
  const h = limitSetup({ provider: 'codex' });
  h.state.model = 'gpt-5-codex';
  h.scripts.acc_1 = async () => unavailable('Codex is not installed or could not start.');
  const outcome = await h.run();
  assert.equal(outcome.status, 'done');
  assert.deepEqual(h.calls, ['acc_1', 'acc_2'], 'this turn moves to the second plan');
  const failed = h.service.get('acc_1')!;
  assert.equal(failed.state, 'cooling', 'no lasting error state that only a Rescan would clear');
  assert.equal(failed.coolingUntil, h.now + 5 * MINUTE);
  assert.equal(h.todos().length, 0);

  h.clock.advance(5 * MINUTE);
  h.calls.length = 0;
  delete h.scripts.acc_1; // the app-server starts now
  await h.run();
  assert.deepEqual(h.calls, ['acc_1'], 'tried first again after the short cooling');
});

test('a rejected or missing API key only cools briefly: no needs_login and no sign-in notification without a sign-in flow', async () => {
  for (const message of ['The provider rejected this connection. Reconnect in Settings.', 'Add an API key for this connection.']) {
    const h = limitSetup({ provider: 'anthropic' });
    h.state.model = 'claude-sonnet-5';
    h.scripts.acc_1 = async () => unavailable(message);
    const outcome = await h.run();
    assert.equal(outcome.status, 'done', message);
    assert.deepEqual(h.calls, ['acc_1', 'acc_2'], message);
    const rejected = h.service.get('acc_1')!;
    assert.equal(rejected.state, 'cooling', message);
    assert.equal(rejected.coolingUntil, h.now + 5 * MINUTE, message);
    assert.equal(h.todos().length, 0, message);

    // A 403 can concern one model only: the key is tried again after the cooling.
    h.clock.advance(5 * MINUTE);
    h.calls.length = 0;
    delete h.scripts.acc_1;
    await h.run();
    assert.deepEqual(h.calls, ['acc_1'], message);
  }
});

test('accountFailure classifies the engines’ own messages', () => {
  const cases: Array<[EngineTurnResult, ReturnType<typeof accountFailure>]> = [
    [LIMIT, 'limit'],
    [{ text: '', stop: 'error', error: { code: 'rate_limited', message: 'Too many requests.' } }, 'limit'],
    [unavailable('Claude Code is not signed in for this account.'), 'signed_out'],
    [unavailable('Codex is not signed in for this account.'), 'signed_out'],
    [unavailable('The provider rejected this connection. Reconnect in Settings.'), 'signed_out'],
    [unavailable('Add an API key for this connection.'), 'signed_out'],
    [unavailable('Claude Code is not installed.'), 'missing'],
    [unavailable('Codex is not installed or could not start.'), 'overload'],
    [unavailable('The provider is overloaded. Retry later.'), 'overload'],
    [unavailable('The Codex connection closed.'), 'overload'],
    [unavailable('Could not reach the model. Check the connection before retrying.'), 'overload'],
    [{ text: '', stop: 'error', error: { code: 'internal', message: 'The model could not complete this turn.' } }, undefined],
    [{ text: '', stop: 'error', error: { code: 'timeout', message: 'The engine did not respond in time.' } }, undefined],
    [{ text: '', stop: 'interrupted' }, undefined],
    [{ text: 'Hi', stop: 'done' }, undefined],
  ];
  for (const [result, expected] of cases) assert.equal(accountFailure(result), expected, result.error?.message ?? result.stop);
});
