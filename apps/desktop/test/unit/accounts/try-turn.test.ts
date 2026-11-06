// B-051 L6: accounts.try runs ONE tool-less, session-less helper turn on exactly that account with the
// cheapest model the catalog lists for it (else the engine's own list), and answers ok with the time and
// model, or a plain reason: missing, signed_out (the account goes to needs_login), plan, limit (cooling, with
// the reset time when known) or error. Never a routing change, never another account.
// Owns: nothing in production. Never runs a real engine (a scripted engine registry).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { lightEffort, limitMessage, tryAccount, TRY_INPUT, TRY_SYSTEM, type TryDeps } from '../../../src/runtime/accounts/try-turn.ts';
import { CLAUDE_FREE_PLAN } from '../../../src/runtime/accounts/cli.ts';
import { postJson, turnError } from '../../../src/runtime/engines/http/common.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { Account, AccountLimits, EngineId, ModelInfo } from '../../../src/shared/model/providers.ts';
import type { EngineModel, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';

const TEMP = path.resolve('fake-data', 'tmp');
const HOUR = 3_600_000;

function acct(id: string, patch: Partial<Account> = {}): Account {
  return { id, provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1, ...patch };
}

function model(id: string, patch: Partial<ModelInfo> = {}): ModelInfo {
  const [provider, name] = id.split(':') as [ModelInfo['provider'], string];
  return { id, provider, model: name, name, engine: provider as EngineId, efforts: ['low', 'medium', 'high'], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [], ...patch };
}

interface RigOptions {
  accounts?: Account[];
  models?: ModelInfo[];
  listed?: EngineModel[] | Error;
  run?: (input: EngineTurnInput, clock: ManualClock) => Promise<EngineTurnResult>;
  timeoutMs?: number;
}

function rig(options: RigOptions = {}) {
  const accounts = new Map((options.accounts ?? [acct('acc_a')]).map((a) => [a.id, a]));
  const marks: unknown[][] = [];
  const notes: unknown[] = [];
  const runs: EngineTurnInput[] = [];
  const engines: EngineId[] = [];
  const folders: string[] = [];
  const clock = new ManualClock(Date.UTC(2026, 9, 28, 10, 0, 0));
  const deps: TryDeps = {
    engines: {
      get: (id: EngineId) => {
        engines.push(id);
        return {
          id, listModels: async () => { if (options.listed instanceof Error) throw options.listed; return options.listed ?? []; },
          run: async (input: EngineTurnInput) => { runs.push(input); return (options.run ?? (async () => ({ text: 'OK', stop: 'done' as const })))(input, clock); },
        } as never;
      },
    },
    catalog: { list: () => options.models ?? [] },
    accounts: {
      get: (id) => accounts.get(id),
      markLimited: (id, until) => { marks.push(['limited', id, until - clock.now()]); const a = accounts.get(id); if (a) accounts.set(id, { ...a, state: 'cooling', coolingUntil: until }); },
      markUnavailable: (id, state) => { marks.push(['unavailable', id, state]); const a = accounts.get(id); if (!a || a.state === state) return false; accounts.set(id, { ...a, state }); return true; },
      updateLimits: (id, limits: AccountLimits) => { marks.push(['limits', id, limits.windows.length]); },
    },
    paths: { temp: TEMP },
    clock,
    notifications: { notify: (input: unknown) => { notes.push(input); return input as never; } },
    mkdir: async (dir) => { folders.push(dir); },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  return { deps, accounts, marks, notes, runs, engines, folders, clock };
}

const unavailable = (message: string): EngineTurnResult => ({ text: '', stop: 'error', error: { code: 'unavailable', message } });

test('gateway 403 is model access, not a rejected key; another model on the same account still works', async () => {
  let status = 403;
  const r = rig({
    accounts: [acct('acc_k', { provider: 'compatible', auth: 'api_key', label: 'Gateway' })],
    models: [model('compatible:restricted', { engine: 'compatible', accounts: ['acc_k'] })],
    run: async (input) => {
      try {
        await postJson(async () => new Response(status === 403 ? 'RestrictedModelsError secret-provider-body' : 'OK', { status }),
          'https://gateway.example/v1/chat/completions', {}, {}, input.signal);
        return { text: 'OK', stop: 'done' };
      } catch (error) { return { text: '', ...turnError(error, input.signal) }; }
    },
  });
  const result = await tryAccount(r.deps, 'acc_k');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'error');
  assert.match(result.message, /denied access to this model or request \(HTTP 403\)/);
  assert.doesNotMatch(result.message, /secret-provider-body|RestrictedModelsError/);
  assert.deepEqual(r.marks, [], 'no account-wide cooling or sign-out for a model restriction');
  assert.deepEqual(r.notes, []);
  assert.equal(r.accounts.get('acc_k')?.state, 'ok');
  r.deps.catalog.list = () => [model('compatible:allowed', { engine: 'compatible', accounts: ['acc_k'] })];
  status = 200;
  assert.deepEqual(await tryAccount(r.deps, 'acc_k'), { ok: true, ms: 0, model: 'compatible:allowed' });
  status = 401;
  assert.deepEqual(await tryAccount(r.deps, 'acc_k'), { ok: false, reason: 'signed_out', message: 'The API key was not accepted' });
});

test('ok: one helper turn on exactly that account with its cheapest chat model; any answer counts with its time', async () => {
  const r = rig({
    accounts: [acct('acc_a'), acct('acc_b')],
    models: [
      model('codex:gpt-big', { relCost: 0.8, accounts: ['acc_a'] }),
      model('codex:gpt-mini', { relCost: 0.1, accounts: ['acc_a', 'acc_b'], tier: 'small' }),
      model('codex:gpt-other', { relCost: 0.01, accounts: ['acc_b'] }), // another account's
      model('codex:gpt-listen', { relCost: 0, accounts: ['acc_a'], functions: ['stt'] }), // a media specialist
      model('codex:gpt-decide', { relCost: 0, accounts: ['acc_a'], strengths: { 'cheap-chat': -1, decision: 0.8 } }), // a decision specialist
    ],
    run: async (input, clock) => { input.onEvent({ type: 'limits', limits: { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 3 }], readAt: 1 } } as never); clock.advance(2_100); return { text: ' Ok. ', stop: 'done' }; },
  });
  assert.deepEqual(await tryAccount(r.deps, 'acc_a'), { ok: true, ms: 2_100, model: 'codex:gpt-mini' });
  assert.equal(r.runs.length, 1);
  const [run] = r.runs;
  assert.deepEqual([run.account.id, run.model, run.effort, run.tools, run.session], ['acc_a', 'gpt-mini', 'low', [], undefined]);
  assert.deepEqual([run.system, run.input], [{ stable: TRY_SYSTEM, volatile: '' }, [{ type: 'text', text: TRY_INPUT }]]);
  assert.deepEqual([TRY_SYSTEM, TRY_INPUT], ['I am a connection check.', 'Reply with the single word OK.']);
  assert.equal(run.cwd, path.join(TEMP, 'helper'));
  assert.deepEqual(r.folders, [path.join(TEMP, 'helper')]);
  assert.equal((await run.callTool('files.read', {}, 'c1')).isError, true);
  assert.deepEqual(r.engines, ['codex']);
  assert.deepEqual(r.marks, [['limits', 'acc_a', 1]], 'only the reported limits are kept');
});

test('a fresh sign-in the catalog has not listed yet: the cheapest of the models its engine lists for it; none → a plain error', async () => {
  const claude = acct('acc_c', { provider: 'claude', label: 'Personal' });
  const r = rig({
    accounts: [claude],
    models: [model('claude:claude-big', { engine: 'claude', relCost: 0.9 }), model('claude:claude-small', { engine: 'claude', relCost: 0.1, efforts: [] })],
    listed: [{ model: 'claude-secret', name: 'x', efforts: [], hidden: true }, { model: 'claude-big', name: 'Big', efforts: ['low'] }, { model: 'claude-small', name: 'Small', efforts: [] }],
  });
  assert.deepEqual(await tryAccount(r.deps, 'acc_c'), { ok: true, ms: 0, model: 'claude:claude-small' });
  assert.deepEqual([r.runs[0].model, r.runs[0].effort], ['claude-small', 'low']);

  const none = rig({ accounts: [claude], listed: new Error('Claude Code did not answer the model list.') });
  assert.deepEqual(await tryAccount(none.deps, 'acc_c'), { ok: false, reason: 'error', message: 'No model of Claude Code is known yet – try again in a moment.' });
  assert.equal(none.runs.length, 0);
});

test('limit: the account cools down and the answer names the reset time when it is known', async () => {
  const hinted = rig({ models: [model('codex:gpt-mini', { accounts: ['acc_a'] })], run: async () => ({ text: '', stop: 'limit', error: { code: 'rate_limited', message: 'Usage limit reached.', retryAfterMs: 2 * HOUR } }) });
  const at = new Date(hinted.clock.now() + 2 * HOUR).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.deepEqual(await tryAccount(hinted.deps, 'acc_a'), { ok: false, reason: 'limit', message: `Plan limit reached – free again at ${at}` });
  assert.deepEqual(hinted.marks, [['limited', 'acc_a', 2 * HOUR]]);
  assert.equal(hinted.accounts.get('acc_a')?.state, 'cooling');

  const clock = new ManualClock(Date.UTC(2026, 9, 28, 10, 0, 0));
  const windows = (resetsAt: number) => ({ get: () => acct('acc_a', { limits: { readAt: 1, windows: [{ name: '5h', windowMinutes: 300, usedPercent: 40, resetsAt: resetsAt - HOUR }, { name: 'weekly', windowMinutes: 10_080, usedPercent: 100, resetsAt }] } }) }) as never;
  const weekly = clock.now() + 3 * 24 * HOUR;
  const day = new Date(weekly).toLocaleDateString('en-GB', { weekday: 'short' });
  assert.equal(limitMessage({ accounts: windows(weekly), clock }, 'acc_a', {}), `Plan limit reached – free again on ${day} ${new Date(weekly).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
  assert.equal(limitMessage({ accounts: { get: () => acct('acc_a') } as never, clock }, 'acc_a', {}), 'Plan limit reached', 'unknown reset: no time');
});

test('signed_out: "Sign-in needed" and the plan goes to needs_login with the one sign-in to-do', async () => {
  const r = rig({ models: [model('codex:gpt-mini', { accounts: ['acc_a'] })], run: async () => unavailable('Codex is not signed in. Sign in again.') });
  assert.deepEqual(await tryAccount(r.deps, 'acc_a'), { ok: false, reason: 'signed_out', message: 'Sign-in needed' });
  assert.deepEqual(r.marks, [['unavailable', 'acc_a', 'needs_login']]);
  assert.equal(r.notes.length, 1, 'the sign-in to-do once');
  // A rejected API key is no sign-in.
  const key = rig({ accounts: [acct('acc_k', { provider: 'openai', auth: 'api_key', label: 'Work' })], models: [model('openai:gpt-mini', { accounts: ['acc_k'] })], run: async () => unavailable('The API key was rejected (401).') });
  assert.deepEqual(await tryAccount(key.deps, 'acc_k'), { ok: false, reason: 'signed_out', message: 'The API key was not accepted' });
});

test('missing: "… is not installed" (the account goes to error); Codex that could not start says so', async () => {
  const claude = rig({ accounts: [acct('acc_c', { provider: 'claude', label: 'Mine' })], models: [model('claude:claude-small', { engine: 'claude', accounts: ['acc_c'] })], run: async () => unavailable('Claude Code is not installed.') });
  assert.deepEqual(await tryAccount(claude.deps, 'acc_c'), { ok: false, reason: 'missing', message: 'Claude Code is not installed.' });
  assert.deepEqual(claude.marks, [['unavailable', 'acc_c', 'error']]);
  const codex = rig({ models: [model('codex:gpt-mini', { accounts: ['acc_a'] })], run: async () => unavailable('Codex is not installed or could not start.') });
  assert.deepEqual(await tryAccount(codex.deps, 'acc_a'), { ok: false, reason: 'missing', message: 'Codex is not installed or could not start.' });
});

test('plan: a plan text marks the account error; a Claude Free account is answered without a turn', async () => {
  const r = rig({ models: [model('codex:gpt-mini', { accounts: ['acc_a'] })], run: async () => unavailable('Your plan does not include Codex.\nUpgrade to Plus at chatgpt.com.') });
  assert.deepEqual(await tryAccount(r.deps, 'acc_a'), { ok: false, reason: 'plan', message: 'Your plan does not include Codex.' });
  assert.deepEqual(r.marks, [['unavailable', 'acc_a', 'error']], 'no cooling for a plan that cannot run it');

  const free = rig({ accounts: [acct('acc_f', { provider: 'claude', state: 'error', plan: 'free' })], models: [model('claude:claude-small', { engine: 'claude', accounts: ['acc_f'] })] });
  assert.deepEqual(await tryAccount(free.deps, 'acc_f'), { ok: false, reason: 'plan', message: CLAUDE_FREE_PLAN });
  assert.equal(free.runs.length, 0);

  const plus = rig({ models: [model('codex:gpt-mini', { accounts: ['acc_a'] })], run: async () => unavailable('Upgrade to Plus to use Codex.') });
  assert.equal((await tryAccount(plus.deps, 'acc_a') as { reason?: string }).reason, 'plan');
});

test('review B-051: "upgrade to the latest version" is a CLI update, never a plan – no plan text, the account is not marked error', async () => {
  const update = "The 'gpt-mini' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
  const codex = rig({ models: [model('codex:gpt-mini', { accounts: ['acc_a'] })], run: async () => ({ text: '', stop: 'error', error: { code: 'internal', message: update } }) });
  assert.deepEqual(await tryAccount(codex.deps, 'acc_a'), { ok: false, reason: 'error', message: update });
  assert.deepEqual(codex.marks, [], 'the account stays as it was');
  const claude = rig({ accounts: [acct('acc_c', { provider: 'claude', plan: 'pro' })], models: [model('claude:claude-small', { engine: 'claude', accounts: ['acc_c'] })], run: async () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'Please upgrade to the latest version of Claude Code.' } }) });
  const answer = await tryAccount(claude.deps, 'acc_c');
  assert.deepEqual(answer, { ok: false, reason: 'error', message: 'Please upgrade to the latest version of Claude Code.' }, 'a Pro user is never told to buy Pro or Max');
  assert.deepEqual(claude.marks, []);
});

test('error: no account, a switched-off one, an engine that throws, an empty answer, a plain failure, the time limit', async () => {
  const r = rig();
  assert.deepEqual(await tryAccount(r.deps, 'acc_none'), { ok: false, reason: 'error', message: 'This account does not exist.' });
  const off = rig({ accounts: [acct('acc_a', { enabled: false, state: 'disabled' })], models: [model('codex:gpt-mini', { accounts: ['acc_a'] })] });
  assert.deepEqual(await tryAccount(off.deps, 'acc_a'), { ok: false, reason: 'error', message: 'This account is switched off.' });
  assert.equal(off.runs.length, 0);

  const models = [model('codex:gpt-mini', { accounts: ['acc_a'] })];
  const throws = rig({ models, run: async () => { throw new Error('secret internals at C:\\x'); } });
  assert.deepEqual(await tryAccount(throws.deps, 'acc_a'), { ok: false, reason: 'error', message: 'The test turn could not start.' });
  const empty = rig({ models, run: async () => ({ text: '  ', stop: 'done' }) });
  assert.deepEqual(await tryAccount(empty.deps, 'acc_a'), { ok: false, reason: 'error', message: 'Codex answered with nothing – try again in a moment.' });
  const plain = rig({ models, run: async () => ({ text: '', stop: 'error', error: { code: 'internal', message: 'The model refused the request.\n  at stack' } }) });
  assert.deepEqual(await tryAccount(plain.deps, 'acc_a'), { ok: false, reason: 'error', message: 'The model refused the request.' });
  assert.deepEqual(plain.marks, [], 'a failure of the turn, not of the account');

  const slow = rig({ models, timeoutMs: 30, run: (input) => new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({ text: '', stop: 'interrupted' }))) });
  assert.deepEqual(await tryAccount(slow.deps, 'acc_a'), { ok: false, reason: 'error', message: 'Codex did not answer within 1 s – try again in a moment.' });
});

test('lightEffort: low when offered, else the lightest offered, else the model default', () => {
  assert.equal(lightEffort(['none', 'low', 'high']), 'low');
  assert.equal(lightEffort(['medium', 'high']), 'medium');
  assert.equal(lightEffort(['none']), 'none');
  assert.equal(lightEffort([], 'high'), 'high');
  assert.equal(lightEffort([]), 'low');
});
