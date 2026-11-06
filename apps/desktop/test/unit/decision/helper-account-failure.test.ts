// Audit 23.10. (runtime gaps): a helper call (decision, verifier, compaction, subconscious …) that fails
// because of its account records that on the account like an agent turn (accounts/failure.ts): a signed-out
// plan → needs_login with one sign-in to-do, a missing CLI → error, overload → short cooling, a limit →
// cooling with the provider's hint; limits the engine reports during the call are kept. So the router and
// the next helper call skip that account instead of spending a failing attempt on it first. One failover,
// within one time limit for both attempts; no other account (or a cut call) → the first attempt's error.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { account, setup } from '../models/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { EngineRegistry } from '../../../src/runtime/contracts.ts';
import type { EngineModel, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';

const HAIKU: EngineModel = { model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'] };
const LUNA: EngineModel = { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high'] };
const MINUTE = 60_000;
const TEMP = tempDir('wf-helper-fail-');
after(() => TEMP.cleanup());

const unavailable = (message: string): EngineTurnResult => ({ text: '', stop: 'error', error: { code: 'unavailable', message } });
type Script = (input: EngineTurnInput, call: number) => Promise<EngineTurnResult | undefined> | EngineTurnResult | undefined;

/** A Claude Code plan and (unless `single`) a Codex plan; `script` answers each engine call (undefined: a normal answer). */
async function world(script: Script, options: { single?: boolean; timeoutMs?: number } = {}) {
  const h = setup();
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.engine('claude').lists.set('claude', [HAIKU]);
  if (!options.single) {
    h.accounts.upsert(account('acc_codex', 'codex'), false);
    h.engine('codex').lists.set('codex', [LUNA]);
  }
  await h.catalog.refresh({ force: true });
  const runs: EngineTurnInput[] = [];
  const engines = {
    get: () => ({ run: async (input: EngineTurnInput) => {
      runs.push(input);
      return (await script(input, runs.length)) ?? { text: '{"ok":true}', stop: 'done', structured: { ok: true } };
    } }),
  } as unknown as EngineRegistry;
  const notes: Array<{ kind: string; title: string }> = [];
  const runner = createEngineRunner({
    engines, router: h.router, accounts: h.accounts, catalog: h.catalog, paths: { temp: TEMP.dir }, clock: h.clock,
    notifications: { notify: (note) => { notes.push(note); } }, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const other = (id: string) => (id === 'acc_claude' ? 'acc_codex' : 'acc_claude');
  return { h, runner, runs, notes, other };
}

test("code 'unavailable', signed out: the plan gets needs_login and one sign-in to-do, the call goes once to the other account, the next call skips it", async () => {
  const w = await world((_input, call) => (call === 1 ? unavailable('Claude Code is not signed in for this account.') : undefined));
  const out = await w.runner({ purpose: 'decision', system: 'Decide.', prompt: 'Is 7 prime?', schema: { type: 'object' } });
  const first = w.runs[0].account.id;
  assert.equal(w.runs.length, 2, 'one failover');
  assert.equal(w.runs[1].account.id, w.other(first));
  assert.deepEqual(out.structured, { ok: true });
  assert.equal(w.h.accounts.get(first)?.state, 'needs_login', 'recorded like an agent turn');
  assert.deepEqual(w.notes.map((note) => [note.kind, note.title]), [['todo', `Sign in to ${first}`]]);

  await w.runner({ purpose: 'verify', system: 'Check.', prompt: 'Done?' });
  assert.equal(w.runs.length, 3, 'no failing first attempt on the signed-out plan');
  assert.equal(w.runs[2].account.id, w.other(first));
  assert.equal(w.notes.length, 1, 'no second to-do');
});

test("code 'unavailable', overload or missing CLI: a short cooling or error (no sign-in to-do); a limit cools with the provider's hint and keeps the reported limits", async () => {
  const overload = await world((_input, call) => (call === 1 ? unavailable('The provider is overloaded. Retry later.') : undefined));
  await overload.runner({ purpose: 'compact', system: 'Summarize.', prompt: 'Old lines …' });
  const cooled = overload.h.accounts.get(overload.runs[0].account.id)!;
  assert.deepEqual([cooled.state, cooled.coolingUntil], ['cooling', overload.h.clock.now() + 5 * MINUTE]);
  assert.equal(overload.notes.length, 0);

  const missing = await world((_input, call) => (call === 1 ? unavailable('Claude Code is not installed.') : undefined));
  await missing.runner({ purpose: 'compact', system: 'Summarize.', prompt: 'Old lines …' });
  assert.equal(missing.h.accounts.get(missing.runs[0].account.id)?.state, 'error');
  assert.equal(missing.notes.length, 0);

  const limits = { windows: [], readAt: 1 };
  const limited = await world((input, call) => {
    if (call !== 1) return undefined;
    input.onEvent({ type: 'limits', limits });
    return { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.', retryAfterMs: 120 * MINUTE } };
  });
  await limited.runner({ purpose: 'compact', system: 'Summarize.', prompt: 'Old lines …' });
  const used = limited.h.accounts.get(limited.runs[0].account.id)!;
  assert.deepEqual([used.state, used.coolingUntil], ['cooling', limited.h.clock.now() + 120 * MINUTE], 'the retry hint');
  assert.deepEqual(used.limits, limits, "the 'limits' event is kept");
  assert.equal(limited.runs.length, 2);
});

test('no other account: the original error is thrown, and the next call does not start a failing attempt', async () => {
  const w = await world(() => unavailable('Claude Code is not signed in for this account.'), { single: true });
  await assert.rejects(w.runner({ purpose: 'compact', system: 'S', prompt: 'P' }), /not signed in for this account/);
  assert.equal(w.runs.length, 1, 'nothing to fail over to');
  assert.equal(w.h.accounts.get('acc_claude')?.state, 'needs_login');
  await assert.rejects(w.runner({ purpose: 'compact', system: 'S', prompt: 'P' }), (error: Error) => !/not signed in for this account/.test(error.message));
  assert.equal(w.runs.length, 1, 'the router keeps the signed-out plan away');
});

test('a model error is no account failure: nothing recorded, no failover', async () => {
  const w = await world((_input, call) => (call === 1 ? { text: '', stop: 'error', error: { code: 'internal', message: 'The model could not complete this turn.' } } : undefined));
  await assert.rejects(w.runner({ purpose: 'compact', system: 'S', prompt: 'P' }), /could not complete/);
  assert.equal(w.runs.length, 1);
  assert.equal(w.h.accounts.get(w.runs[0].account.id)?.state, 'ok');
});

test('signal aborted during the first attempt: no second attempt (the failure is still recorded)', async () => {
  const controller = new AbortController();
  const w = await world((_input, call) => {
    if (call !== 1) return undefined;
    controller.abort();
    return unavailable('The Codex connection closed.');
  });
  await assert.rejects(w.runner({ purpose: 'decision', system: 'D', prompt: 'P', signal: controller.signal }), /connection closed/);
  assert.equal(w.runs.length, 1, 'no failover after the caller stopped');
  assert.ok(w.runs[0].signal?.aborted, "the caller's signal reaches the engine");
  assert.equal(w.h.accounts.get(w.runs[0].account.id)?.state, 'cooling');
});

test('one time limit covers both attempts: the failover gets the same signal, and none starts once the limit passed', async () => {
  const shared = await world((_input, call) => (call === 1 ? unavailable('The provider is overloaded. Retry later.') : undefined));
  await shared.runner({ purpose: 'compact', system: 'S', prompt: 'P' });
  assert.equal(shared.runs.length, 2);
  assert.equal(shared.runs[1].signal, shared.runs[0].signal, 'not a fresh time limit for the second attempt');

  const slow = await world(async (input, call) => {
    if (call !== 1) return undefined;
    await new Promise((resolve) => input.signal?.addEventListener('abort', resolve, { once: true }));
    return unavailable('Codex is not installed or could not start.'); // a CLI that started too slowly
  }, { timeoutMs: 30 });
  await assert.rejects(slow.runner({ purpose: 'compact', system: 'S', prompt: 'P' }), /could not start/);
  assert.equal(slow.runs.length, 1, 'the time limit is used up: no second attempt');
});
