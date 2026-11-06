// B-049 F7 – the Codex side of the cache-friendly garden rebuild over a scripted app-server: every agent turn's
// result names its Codex turn id; rebuild() with `revert` keeps the bound thread (resumed lean when this process has
// not loaded it), sends thread/revert before the recorded turn and injects only the tail – no thread/start; the next
// turn gets the context block (the thread keeps the instructions it opened with); a refused revert throws with the
// thread untouched; a failed injection after the cut ends the thread at its next turn (rebase); a thread open in
// another folder is never reverted.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import type { EngineRebuildInput, RebuildItem } from '../../../src/runtime/engines/types.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

interface Options { refuseRevert?: boolean; refuseInject?: boolean }

function appServer(options: Options = {}) {
  const requests: any[] = [];
  let threads = 0;
  let turns = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.164.0 (Windows)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } }); break;
        case 'thread/revert':
          if (options.refuseRevert) child.send({ id: msg.id, error: { code: -32600, message: 'thread/revert requires a paginated thread' } });
          else child.send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
          break;
        case 'thread/inject_items':
          if (options.refuseInject) child.send({ id: msg.id, error: { code: -32600, message: 'items[0] is not a valid response item' } });
          else child.send({ id: msg.id, result: {} });
          break;
        case 'turn/start': {
          const id = `turn_${++turns}`;
          child.send({ id: msg.id, result: { turn: { id, status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId: msg.params.threadId, turnId: id, item: { id: `m${turns}`, type: 'agentMessage', text: 'ok' } } });
          child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id, status: 'completed' } } });
          break;
        }
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
const TAIL: RebuildItem[] = [
  { itemId: 't7', kind: 't', role: 'tool', text: 'short', call: { own: true, name: 'shell', args: { command: 'npm test' }, callId: 'c7', output: 'short {"compacted":"t7"}' } },
  { itemId: 'a8', kind: 'a', role: 'assistant', text: 'Tests pass.' },
];

function revertInput(ref: string, patch: Partial<EngineRebuildInput> = {}): EngineRebuildInput {
  const { input } = turnInput();
  return {
    runId: 'run_9', agentId: 'ag_1', account: account(), model: 'gpt-test', cwd: '/work', items: TAIL, tools: input.tools, toolNames: ['tasks.create'],
    system: { stable: 'STABLE', volatile: 'VOLATILE' }, generation: 3, probe: { version: 'v', ok: true, verify: 'accepted', at: 1 },
    revert: { ref, beforeTurn: 'turn_2' }, ...patch,
  };
}

test('an agent turn names its Codex turn id in the result; a helper turn has no session', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  const first = await e.run(turnInput({ runId: 'run_1' }).input);
  assert.deepEqual(first.session, { ref: 'thr_1', generation: 1, turn: 'turn_1' });
  const second = await e.run(turnInput({ runId: 'run_2', session: { ref: 'thr_1', generation: 1 } }).input);
  assert.deepEqual(second.session, { ref: 'thr_1', generation: 1, turn: 'turn_2' });
  const helper = await e.run(turnInput({ runId: 'run_h', tools: [], system: { stable: 'Decide.', volatile: '' } }).input);
  assert.equal(helper.session, undefined);
  await e.dispose();
});

test('revert on a loaded thread: thread/revert before the turn, the tail injected, no new thread; the next turn gets the context block', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ runId: 'run_1' }).input);
  await e.run(turnInput({ runId: 'run_2', session: { ref: 'thr_1', generation: 1 } }).input);
  const result = await e.rebuild(revertInput('thr_1'));
  assert.deepEqual(result, { ref: 'thr_1', generation: 3, items: 3 }, 'a native shell call replays as exec_command + its output, plus the answer');
  assert.deepEqual(fake.sent('thread/revert').map((r) => r.params), [{ threadId: 'thr_1', beforeTurnId: 'turn_2' }]);
  assert.equal(fake.sent('thread/start').length, 1, 'only the first turn started a thread');
  assert.equal(fake.sent('thread/resume').length, 0, 'loaded: no resume');
  const inject = fake.sent('thread/inject_items');
  assert.equal(inject.length, 1);
  assert.equal(inject[0].params.threadId, 'thr_1');
  // B-049 neutral mapping: Codex's own shell call goes back in as its exec_command function_call with the output.
  assert.deepEqual(inject[0].params.items.map((item: any) => item.type), ['function_call', 'function_call_output', 'message']);
  assert.equal(inject[0].params.items[0].name, 'exec_command');
  assert.equal(JSON.parse(inject[0].params.items[0].arguments).cmd, 'npm test');
  const order = fake.requests.map((r) => r.method);
  assert.ok(order.indexOf('thread/revert') < order.indexOf('thread/inject_items'), 'cut first, then the tail');

  const next = await e.run(turnInput({ runId: 'run_3', session: { ref: 'thr_1', generation: 3 } }).input);
  assert.equal(next.stop, 'done');
  assert.equal(fake.sent('turn/start').at(-1).params.input[0].text, '<workforce-context>\nVOLATILE\n</workforce-context>', 'not fresh: the volatile block travels');
  await e.dispose();
});

test('revert on a thread this process has not loaded resumes it lean first', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.rebuild(revertInput('thr_old'));
  const resume = fake.sent('thread/resume');
  assert.equal(resume.length, 1);
  assert.equal(resume[0].params.threadId, 'thr_old');
  assert.equal(resume[0].params.config.web_search, 'live', 'lean like every agent thread (E1: its own live search)');
  assert.equal(resume[0].params.sandbox, 'read-only', 'the isolation stays');
  const order = fake.requests.map((r) => r.method);
  assert.ok(order.indexOf('thread/resume') < order.indexOf('thread/revert'));
  await e.run(turnInput({ runId: 'run_3', session: { ref: 'thr_old', generation: 3 } }).input);
  assert.equal(fake.sent('thread/resume').length, 1, 'the reverted thread stays loaded');
  await e.dispose();
});

test('a refused revert throws with the thread untouched; a failed tail after the cut ends the thread at its next turn', async () => {
  const refused = appServer({ refuseRevert: true });
  const e = engineOf(refused.spawn);
  await e.run(turnInput({ runId: 'run_1' }).input);
  await assert.rejects(e.rebuild(revertInput('thr_1')), /thread\/revert refused/);
  assert.equal(refused.sent('thread/inject_items').length, 0);
  assert.equal((await e.run(turnInput({ runId: 'run_2', session: { ref: 'thr_1', generation: 1 } }).input)).stop, 'done', 'the thread goes on as it was');
  await e.dispose();

  const broken = appServer({ refuseInject: true });
  const b = engineOf(broken.spawn);
  await b.run(turnInput({ runId: 'run_1' }).input);
  await assert.rejects(b.rebuild(revertInput('thr_1')), /inject_items refused/);
  const next = await b.run(turnInput({ runId: 'run_2', session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(next.stop, 'error');
  assert.equal(next.error?.details?.rebase, true, 'cut without its tail: renewed, never continued');
  assert.equal(broken.sent('turn/start').length, 1, 'no turn on the cut thread');
  const again = await b.run(turnInput({ runId: 'run_3', session: { ref: 'thr_1', generation: 1 } }).input);
  assert.equal(again.stop, 'done', 'reported once');
  await b.dispose();
});

test('a thread open in another folder is never reverted', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ runId: 'run_1', cwd: '/other' }).input);
  await assert.rejects(e.rebuild(revertInput('thr_1')), /another folder/);
  assert.equal(fake.sent('thread/revert').length, 0);
  await e.dispose();
});
