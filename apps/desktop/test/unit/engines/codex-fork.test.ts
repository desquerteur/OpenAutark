// B-057 C – the Codex native fork of a split over a scripted app-server: fork() sends thread/fork for the parent thread
// (through the recorded turn when given, the worker's folder and model, lean config with the isolation, excludeTurns;
// never ephemeral, never attached to the source, no instructions or dynamic tools – the fork keeps the parent's), loads
// the new thread with that folder and leaves it un-fresh: its first turn resumes nothing and gets the <workforce-context>
// block and (H1) the app note; the parent thread is never touched; a server that refuses the lean settings forks with today's, a refusal or a
// missing id throws, a fork without a known folder is refused before any request.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { forkParams } from '../../../src/runtime/engines/codex/fork.ts';
import type { EngineForkInput } from '../../../src/runtime/engines/types.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

interface Options { refuseLean?: boolean; refuseFork?: boolean; noId?: boolean }

function appServer(options: Options = {}) {
  const requests: any[] = [];
  let threads = 0;
  let forks = 0;
  let turns = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.165.0 (Windows)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: msg.params.threadId } } }); break;
        case 'thread/fork':
          if (options.refuseFork) child.send({ id: msg.id, error: { code: -32600, message: 'thread not found' } });
          else if (options.refuseLean && msg.params.config?.include_environment_context === false) child.send({ id: msg.id, error: { code: -32600, message: 'unknown config key' } });
          else child.send({ id: msg.id, result: { thread: options.noId ? {} : { id: `thr_fork_${++forks}`, forkedFromId: msg.params.threadId }, cwd: msg.params.cwd, model: msg.params.model ?? 'gpt-test' } });
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
const forkInput = (patch: Partial<EngineForkInput> = {}): EngineForkInput => ({ runId: 'run_w1', agentId: 'ag_1', account: account(), parentRef: 'thr_1', cwd: '/work', model: 'gpt-cheap', ...patch });

test('codex says it can fork', () => {
  const fake = appServer();
  assert.equal(engineOf(fake.spawn).caps.fork, true);
});

test('fork: thread/fork of the parent through its turn, lean and isolated, not ephemeral; the first turn of the fork gets the context block', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  const parent = await e.run(turnInput({ runId: 'run_p1' }).input);
  assert.deepEqual(parent.session, { ref: 'thr_1', generation: 1, turn: 'turn_1' });

  const forked = await e.fork(forkInput({ cwd: '/work', lastTurn: 'turn_1' }));
  assert.deepEqual(forked, { ref: 'thr_fork_1', generation: 1 });
  const [fork] = fake.sent('thread/fork');
  assert.equal(fork.params.threadId, 'thr_1');
  assert.equal(fork.params.lastTurnId, 'turn_1', 'through the turn that split');
  assert.equal(fork.params.cwd, '/work');
  assert.equal(fork.params.model, 'gpt-cheap', "the worker's model");
  assert.equal(fork.params.excludeTurns, true, 'the answer stays small');
  assert.equal(fork.params.config.include_environment_context, false, 'lean like every agent thread');
  assert.equal(fork.params.config.web_search, 'live', "with Codex's own live web search (E1)");
  assert.equal(fork.params.config.project_doc_max_bytes, 0, 'the isolation stays');
  assert.equal(fork.params.sandbox, 'read-only');
  assert.equal(fork.params.approvalPolicy, 'never');
  for (const key of ['ephemeral', 'attachToSource', 'dynamicTools', 'baseInstructions', 'developerInstructions', 'experimentalRawEvents', 'beforeTurnId']) {
    assert.equal(key in fork.params, false, `no ${key}`);
  }

  const worker = await e.run(turnInput({ runId: 'run_w1', session: { ref: 'thr_fork_1', generation: 1 }, system: { stable: 'STABLE', volatile: 'You are split #2 of 3.' }, input: [{ type: 'text', text: 'Your part: count the files.' }] }).input);
  assert.equal(worker.stop, 'done');
  assert.deepEqual(worker.session, { ref: 'thr_fork_1', generation: 1, turn: 'turn_2' });
  assert.equal(fake.sent('thread/resume').length, 0, 'loaded by the fork: no resume');
  assert.equal(fake.sent('thread/start').length, 1, "only the parent's first turn started a thread");
  const start = fake.sent('turn/start').at(-1);
  assert.equal(start.params.threadId, 'thr_fork_1');
  assert.equal(start.params.input[0].text, '<workforce-context>\nYou are split #2 of 3.\n</workforce-context>', "the split's identity travels as the context block");
  assert.match(start.params.input[1].text, /^App note: /, "H1: Codex's own note comes again after the parent's history – the app note after it");
  assert.equal(start.params.input[2].text, 'Your part: count the files.');
  const touched = fake.requests.filter((r) => r.params?.threadId === 'thr_1').map((r) => r.method);
  assert.deepEqual(touched, ['turn/start', 'thread/fork'], 'the parent thread got its own turn and the fork request only');
  await e.dispose();
});

test('fork without a recorded turn copies the whole thread; without a given folder it takes the folder the parent is open in', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ runId: 'run_p1', cwd: '/proj' }).input);
  await e.fork(forkInput({ cwd: undefined, lastTurn: undefined }));
  const [fork] = fake.sent('thread/fork');
  assert.equal('lastTurnId' in fork.params, false);
  assert.equal(fork.params.cwd, '/proj');
  const worker = await e.run(turnInput({ runId: 'run_w1', session: { ref: 'thr_fork_1', generation: 1 }, cwd: '/proj' }).input);
  assert.equal(worker.stop, 'done', 'the fork runs in its folder');
  await e.dispose();
});

test('unload: a released fork leaves the running app-server (thread/unsubscribe) once; a thread not loaded here sends nothing', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ runId: 'run_p1', cwd: '/proj' }).input);
  const forked = await e.fork(forkInput({ cwd: '/proj', lastTurn: 'turn_1' }));
  await e.unload(account(), forked.ref);
  await e.unload(account(), forked.ref); // already unloaded
  await e.unload(account(), 'thr_unknown');
  assert.deepEqual(fake.sent('thread/unsubscribe').map((request) => request.params.threadId), [forked.ref]);
  // Live test L3: the split's background terminals end with it – cleaned before the unsubscribe (a refusal is ignored).
  assert.deepEqual(fake.sent('thread/backgroundTerminals/clean').map((request) => request.params.threadId), [forked.ref]);
  const order = fake.requests.map((request) => request.method).filter((method) => method === 'thread/backgroundTerminals/clean' || method === 'thread/unsubscribe');
  assert.deepEqual(order, ['thread/backgroundTerminals/clean', 'thread/unsubscribe']);
  const resumed = await e.run(turnInput({ runId: 'run_w1', session: { ref: forked.ref, generation: 1 }, cwd: '/proj' }).input);
  assert.equal(resumed.stop, 'done', 'a later turn loads it again');
  assert.equal(fake.sent('thread/resume').at(-1)?.params.threadId, forked.ref);
  await e.dispose();
  await e.unload(account(), forked.ref); // no server: nothing to unload, nothing started
  assert.equal(fake.sent('thread/unsubscribe').length, 1);
});

test('a fork in another folder (a worktree) runs there; a turn of it in another folder renews quietly', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await e.run(turnInput({ runId: 'run_p1', cwd: '/proj' }).input);
  await e.fork(forkInput({ cwd: '/proj/.worktrees/wf-split-1' }));
  assert.equal(fake.sent('thread/fork')[0].params.cwd, '/proj/.worktrees/wf-split-1');
  const wrong = await e.run(turnInput({ runId: 'run_w1', session: { ref: 'thr_fork_1', generation: 1 }, cwd: '/proj' }).input);
  assert.equal(wrong.error?.details?.folder, true);
  await e.dispose();
});

test('a server that refuses the lean settings forks with today\'s settings (remembered); a refusal or no id throws', async () => {
  const lean = appServer({ refuseLean: true });
  const e = engineOf(lean.spawn);
  const forked = await e.fork(forkInput());
  assert.equal(forked.ref, 'thr_fork_1');
  const forks = lean.sent('thread/fork');
  assert.equal(forks.length, 2);
  assert.equal(forks[1].params.config.web_search, undefined, "today's settings");
  assert.equal(forks[1].params.sandbox, 'read-only', 'the isolation stays');
  await e.fork(forkInput({ runId: 'run_w2' }));
  assert.equal(lean.sent('thread/fork').length, 3, 'remembered: no lean attempt again');
  await e.dispose();

  const refused = appServer({ refuseFork: true });
  const r = engineOf(refused.spawn);
  await assert.rejects(r.fork(forkInput()), /thread not found/);
  await r.dispose();

  const empty = appServer({ noId: true });
  const n = engineOf(empty.spawn);
  await assert.rejects(n.fork(forkInput()), /did not fork/);
  await n.dispose();
});

test('a fork whose folder is unknown is refused before any thread request', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  await assert.rejects(e.fork(forkInput({ cwd: undefined, parentRef: 'thr_elsewhere' })), /folder/);
  assert.equal(fake.sent('thread/fork').length, 0);
  await e.dispose();
});

test('forkParams: never sends instructions, tools, ephemeral or a turn it was not given', () => {
  const params = forkParams({ parentRef: 'thr_9' }, { cwd: '/w', model: 'm', baseInstructions: 'B', developerInstructions: 'D', dynamicTools: [], ephemeral: true, sandbox: 'read-only' });
  assert.deepEqual(params, { cwd: '/w', model: 'm', sandbox: 'read-only', threadId: 'thr_9', excludeTurns: true });
});
