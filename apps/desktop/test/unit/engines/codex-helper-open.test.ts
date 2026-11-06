// B-074 (n2 c1, 04.11.2026): a helper call whose thread/start the app-server never answered ended as 'unavailable' ("Codex could not open the
// session."), accounts/failure.ts read that as an overload of the only account, and the subconscious's other brain failed 48 ms later on "Every
// account … limited right now". A helper thread that does not open in time is now the call's own failure (a timeout): no account cools and the
// next call runs.
// B-075 (live 04.11.2026, Jonas): the same happened to an AGENT thread – Autark's own app-server, started cold on the owner's large ~/.codex,
// opened the thread ~65 s after thread/start; at 60 s the turn had failed as 'unavailable', the Codex account cooled 5 minutes and every other
// chat failed with "limited" (Claude's weekly window was used up). Now every thread open (start or resume, agent or helper) waits 120 s
// (helper-thread.ts THREAD_OPEN_MS) and a timeout is the turn's own: no account cools, the chat's redelivery retries it. The turn's own
// signal still ends the open at once (a Stop; a helper call's shorter time limit, e.g. a phone call's talker).
// A refused helper thread and a real overload keep their account consequence.

import { afterEach, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { THREAD_OPEN_MS } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { accountFailure, recordAccountFailure } from '../../../src/runtime/accounts/failure.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { EngineRegistry } from '../../../src/runtime/contracts.ts';
import type { EngineModel, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { account, setup } from '../models/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { fakeSpawn, fakeFinder, testSupervisor, turnInput, tick } from './fakes.ts';

afterEach(() => mock.timers.reset());
const TEMP = tempDir('wf-helper-open-');
after(() => TEMP.cleanup());

const OPENS = new Set(['thread/start', 'thread/resume']);

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await tick();
}

/** An app-server that never answers thread/start or thread/resume (`refuse`: answers thread/start with an error instead). */
function appServer(refuse = false) {
  const requests: any[] = [];
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start' && refuse) child.send({ id: msg.id, error: { code: -32602, message: 'invalid thread settings' } });
      else if (!OPENS.has(msg.method) && msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  const engine = new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });
  return { engine, opens: () => requests.filter((r) => OPENS.has(r.method)).length };
}

/** Runs one turn while its thread open stays unanswered: still waiting after the old 60 s, ended at THREAD_OPEN_MS. */
async function unopened(input: unknown): Promise<EngineTurnResult> {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer();
  let ended = false;
  const running = fake.engine.run(input as never).finally(() => { ended = true; });
  await until(() => fake.opens() > 0);
  mock.timers.tick(60_000);
  await tick();
  assert.equal(ended, false, 'a cold server still has time to open the thread after 60 s');
  mock.timers.tick(THREAD_OPEN_MS - 60_000);
  const result = await running;
  mock.timers.reset();
  await fake.engine.dispose();
  return result;
}

/** What recordAccountFailure does to the account: [failure, cooled]. */
function recorded(result: EngineTurnResult): [string | undefined, boolean] {
  let cooled = false;
  const accounts = { get: () => undefined, markLimited: () => { cooled = true; }, markUnavailable: () => { cooled = true; return true; } };
  const failure = recordAccountFailure({ accounts: accounts as never, clock: { now: () => 0 } as never }, account('acc_codex', 'codex'), 'gpt-6.1-sol', result);
  return [failure, cooled];
}

const TIMED_OUT = ['timeout', 'Codex did not open the session in time.'];

test('the open limit is 120 s', () => {
  assert.equal(THREAD_OPEN_MS, 120_000);
});

test('a helper thread the app-server does not open in time is the call\'s own timeout, no account failure', async () => {
  const result = await unopened(turnInput({ runId: 'run_h', agentId: 'system', tools: [], outputSchema: { type: 'object' } }).input);
  assert.equal(result.stop, 'error');
  assert.deepEqual([result.error?.code, result.error?.message], TIMED_OUT);
  assert.equal(accountFailure(result), undefined);
});

test('B-075: an agent thread whose thread/start times out is the turn\'s own timeout – the account is not cooled', async () => {
  const result = await unopened(turnInput({ runId: 'run_a' }).input);
  assert.equal(result.stop, 'error');
  assert.deepEqual([result.error?.code, result.error?.message], TIMED_OUT);
  assert.deepEqual(recorded(result), [undefined, false], 'no overload, no cooling: other chats keep routing to Codex');
});

test('B-075: an agent thread whose thread/resume times out is a timeout too, not a renewal and not an account failure', async () => {
  const result = await unopened(turnInput({ runId: 'run_r', session: { ref: 'thr_old', generation: 1 } }).input);
  assert.deepEqual([result.error?.code, result.error?.message], TIMED_OUT);
  assert.equal(result.error?.details?.rebase, undefined, 'the thread is not given up: the retry resumes it on the warm server');
  assert.deepEqual(recorded(result), [undefined, false]);
});

test('B-075: the turn\'s signal ends the open at once (a helper call\'s time limit, a Stop) – interrupted, no account failure, no wait for THREAD_OPEN_MS', async () => {
  const fake = appServer();
  const controller = new AbortController();
  const running = fake.engine.run(turnInput({ runId: 'run_t', agentId: 'system', tools: [], outputSchema: { type: 'object' }, signal: controller.signal }).input);
  await until(() => fake.opens() > 0);
  controller.abort();
  const result = await running;
  assert.deepEqual([result.stop, result.error?.code], ['interrupted', 'cancelled']);
  assert.equal(accountFailure(result), undefined);

  const stopped = new AbortController();
  stopped.abort();
  const before = fake.opens();
  const early = await fake.engine.run(turnInput({ runId: 'run_s', signal: stopped.signal }).input);
  assert.equal(early.stop, 'interrupted');
  assert.equal(fake.opens(), before, 'stopped before the open: no thread is opened');
  await fake.engine.dispose();
});

test('unchanged: a refused helper thread stays an account failure', async () => {
  const fake = appServer(true);
  const refused = await fake.engine.run(turnInput({ runId: 'run_h', agentId: 'system', tools: [], outputSchema: { type: 'object' } }).input);
  await fake.engine.dispose();
  assert.equal(fake.opens(), 2, 'the lean helper thread, then the plain one');
  assert.deepEqual([refused.error?.code, refused.error?.message], ['unavailable', 'Codex could not open the session.']);
  assert.equal(accountFailure(refused), 'overload');
});

test('through the runner, on the only account: the timed-out call fails alone and the next call (the other brain) runs; a real overload still cools', async () => {
  const LUNA: EngineModel = { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high'] };
  const world = async (first: EngineTurnResult) => {
    const h = setup();
    h.accounts.upsert(account('acc_codex', 'codex'), false);
    h.engine('codex').lists.set('codex', [LUNA]);
    await h.catalog.refresh({ force: true });
    let calls = 0;
    const engines = { get: () => ({ run: async () => (++calls === 1 ? first : { text: '{"ok":true}', stop: 'done', structured: { ok: true } }) }) } as unknown as EngineRegistry;
    const runner = createEngineRunner({ engines, router: h.router, accounts: h.accounts, catalog: h.catalog, paths: { temp: TEMP.dir }, clock: h.clock });
    return { h, runner, calls: () => calls };
  };
  const timedOut = await world({ text: '', stop: 'error', error: { code: 'timeout', message: 'Codex did not open the session in time.' } });
  await assert.rejects(timedOut.runner({ purpose: 'subconscious', system: 'S', prompt: 'P', schema: { type: 'object' } }), /did not open the session in time/);
  assert.equal(timedOut.h.accounts.get('acc_codex')?.state, 'ok', 'the account does not cool');
  const next = await timedOut.runner({ purpose: 'subconscious', system: 'S', prompt: 'P', schema: { type: 'object' }, effort: 'medium' });
  assert.deepEqual(next.structured, { ok: true });
  assert.equal(timedOut.calls(), 2);

  const overload = await world({ text: '', stop: 'error', error: { code: 'unavailable', message: 'OpenAI is overloaded right now.' } });
  await assert.rejects(overload.runner({ purpose: 'subconscious', system: 'S', prompt: 'P', schema: { type: 'object' } }));
  assert.equal(overload.h.accounts.get('acc_codex')?.state, 'cooling', 'a real overload cools the account as before');
  await assert.rejects(overload.runner({ purpose: 'subconscious', system: 'S', prompt: 'P', schema: { type: 'object' } }), /limited right now/);
  assert.equal(overload.calls(), 1);
});
