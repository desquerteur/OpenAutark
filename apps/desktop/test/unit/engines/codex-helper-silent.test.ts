// Plan step 10 (B-074): a Codex helper turn (no tools, structured output) whose model sends nothing for HELPER_SILENT_MS after turn/start
// answered is cut through the turn's own abort path and ends as a timeout – the call's own failure, so no account cools (accounts/failure.ts)
// and the subconscious's other brain goes on. The app-server's echo of the turn's input (its userMessage item, the raw input items) is no
// sign of the model; the first item, delta or token usage is, and an answer that comes late but inside the limit is kept. Agent turns are
// never cut this way.

import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { HELPER_SILENT_MS } from '../../../src/runtime/engines/codex/turn.ts';
import { accountFailure } from '../../../src/runtime/accounts/failure.ts';
import { fakeSpawn, fakeFinder, testSupervisor, turnInput, tick, type FakeChild } from './fakes.ts';

afterEach(() => mock.timers.reset());

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await tick();
}

/** An app-server whose turns start and echo their input, then send only what the test sends (`say`); turn/interrupt ends the turn. */
function appServer() {
  const requests: any[] = [];
  let child: FakeChild | undefined;
  const { spawn } = fakeSpawn((call) => {
    child = call.child;
    call.child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      const threadId = msg.params?.threadId;
      switch (msg.method) {
        case 'initialize': call.child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': call.child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } }); break;
        case 'thread/unsubscribe': call.child.send({ id: msg.id, result: { status: 'unsubscribed' } }); break;
        case 'turn/start':
          call.child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          call.child.send({ method: 'turn/started', params: { threadId, turn: { id: 'turn_1' } } });
          call.child.send({ method: 'item/started', params: { threadId, turnId: 'turn_1', item: { id: 'u1', type: 'userMessage', content: [] } } });
          call.child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'u1', type: 'userMessage', content: [] } } });
          call.child.send({ method: 'rawResponseItem/completed', params: { threadId, turnId: 'turn_1', item: { type: 'configuration_update', reasoning: { effort: 'low' } } } });
          break;
        case 'turn/interrupt':
          call.child.send({ id: msg.id, result: {} });
          call.child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'interrupted' } } });
          break;
        default: if (msg.id !== undefined) call.child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  const say = (method: string, params: Record<string, unknown>) => child!.send({ method, params: { threadId: 'thr_1', turnId: 'turn_1', ...params } });
  const answer = (text: string) => {
    say('item/started', { item: { id: 'm1', type: 'agentMessage', text: '' } });
    say('item/agentMessage/delta', { itemId: 'm1', delta: text });
    say('item/completed', { item: { id: 'm1', type: 'agentMessage', text } });
    say('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 6761, outputTokens: 49, totalTokens: 6810 } } });
    say('turn/completed', { turn: { id: 'turn_1', status: 'completed' } });
  };
  const interrupts = () => requests.filter((r) => r.method === 'turn/interrupt').length;
  const started = () => requests.some((r) => r.method === 'turn/start');
  return { spawn, requests, say, answer, interrupts, started };
}

const engineOf = (spawn: ReturnType<typeof fakeSpawn>['spawn']) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });
const helperInput = () => turnInput({ runId: 'run_h', agentId: 'system', tools: [], outputSchema: { type: 'object' } }).input;

test('a helper turn the model never answers is cut after HELPER_SILENT_MS: a timeout, no account failure; the input echo is no sign', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer();
  const engine = engineOf(fake.spawn);
  const running = engine.run(helperInput());
  await until(fake.started);
  await until(() => false); // turn/start answered, the echo of the input handled
  mock.timers.tick(HELPER_SILENT_MS - 1);
  await until(() => fake.interrupts() > 0);
  assert.equal(fake.interrupts(), 0, 'not before the limit');
  mock.timers.tick(1);
  await until(() => fake.interrupts() > 0);
  assert.equal(fake.interrupts(), 1, 'cut through the turn\'s abort path (turn/interrupt)');
  const result = await running;
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.code, 'timeout');
  assert.match(result.error?.message ?? '', /sent nothing for 90 s/);
  assert.equal(accountFailure(result), undefined, 'the call\'s own failure: no account cools, the other brain can go on');
  mock.timers.reset();
  await engine.dispose();
});

test('a helper turn that answers late but inside the limit keeps its answer and is not cut', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer();
  const engine = engineOf(fake.spawn);
  const running = engine.run(helperInput());
  await until(fake.started);
  await until(() => false);
  mock.timers.tick(HELPER_SILENT_MS - 2_000); // like n2 c2 (62.0 s) and q1 (61.8 s) under a 60 s cut: the answer comes 2 s before the limit
  await until(() => false);
  fake.answer('{"why":"nothing to do","tool":"done","args":"{}"}');
  const result = await running;
  assert.equal(result.stop, 'done');
  assert.deepEqual(result.structured, { why: 'nothing to do', tool: 'done', args: '{}' });
  mock.timers.tick(HELPER_SILENT_MS);
  await until(() => false);
  assert.equal(fake.interrupts(), 0);
  mock.timers.reset();
  await engine.dispose();
});

test('the model\'s first sign ends the watch: a helper turn that then works longer than the limit is not cut', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer();
  const engine = engineOf(fake.spawn);
  const running = engine.run(helperInput());
  await until(fake.started);
  await until(() => false);
  mock.timers.tick(1_000);
  fake.say('item/started', { item: { id: 'r1', type: 'reasoning', summary: [] } });
  await until(() => false);
  mock.timers.tick(2 * HELPER_SILENT_MS);
  await until(() => false);
  assert.equal(fake.interrupts(), 0);
  fake.answer('{"ok":true}');
  const result = await running;
  assert.equal(result.stop, 'done');
  mock.timers.reset();
  await engine.dispose();
});

test('an agent turn (tools offered) is never cut by the helper watch', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fake = appServer();
  const engine = engineOf(fake.spawn);
  const running = engine.run(turnInput({ runId: 'run_a', outputSchema: { type: 'object' } }).input);
  await until(fake.started);
  await until(() => false);
  mock.timers.tick(2 * HELPER_SILENT_MS);
  await until(() => false);
  assert.equal(fake.interrupts(), 0);
  fake.answer('{"ok":true}');
  assert.equal((await running).stop, 'done');
  mock.timers.reset();
  await engine.dispose();
});
