// Codex background commands (live tests L3 and C4, 31.10.2026) over a scripted app-server. They are the agents' own:
// a single Stop only interrupts the turn (nothing listed, terminated or cleaned). The emergency stop (stopBackground)
// cleans every loaded thread of a running server and never starts or restarts one – neither does a split's unload. A
// thread nobody resumes leaves with its background commands (dropThread: B-047 D1 renewal, a helper thread; a deleted
// thread is cleaned before thread/delete). A turn stopped before turn/start makes no model call.
// Owns: nothing in production. Never starts a real binary (scripted app-server over fakes.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, tick, turnInput } from './fakes.ts';

/** A scripted app-server; a turn listed in `wait` stays open until it is interrupted. */
function appServer(options: { wait?: number[] } = {}) {
  const requests: any[] = [];
  let threads = 0;
  let turns = 0;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      if (msg.id === undefined) return;
      const threadId = msg.params?.threadId;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'workforce/0.165.0 (Windows)' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/resume': child.send({ id: msg.id, result: { thread: { id: threadId } } }); break;
        case 'turn/start': {
          const n = ++turns;
          child.send({ id: msg.id, result: { turn: { id: `turn_${n}`, status: 'inProgress' } } });
          child.send({ method: 'item/started', params: { threadId, turnId: `turn_${n}`, item: { type: 'commandExecution', id: `c${n}`, processId: `p${n}`, command: 'Start-Sleep 300', cwd: '/work', status: 'inProgress' } } });
          if (options.wait?.includes(n)) { started(); break; }
          child.send({ method: 'turn/completed', params: { threadId, turn: { id: `turn_${n}`, status: 'completed' } } });
          break;
        }
        case 'turn/interrupt':
          child.send({ id: msg.id, result: {} });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id: msg.params.turnId, status: 'interrupted' } } });
          break;
        case 'thread/backgroundTerminals/clean': case 'thread/unsubscribe': case 'thread/delete': child.send({ id: msg.id, result: {} }); break;
        default: child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, calls, requests, waiting, sent: (method: string) => requests.filter((r) => r.method === method) };
}

const engineOf = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/engine-cwd', version: '0.2.0', realpath: async (dir) => dir });
const stopped = () => new WorkforceError('cancelled', 'stopped', { details: { stopKind: 'human' } });
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const terminalCalls = (fake: { requests: any[] }) => fake.requests.filter((r) => String(r.method).startsWith('thread/backgroundTerminals/'));

test('a single Stop only interrupts the turn: its background commands stay the agent\'s own', async () => {
  const fake = appServer({ wait: [1] });
  const e = engineOf(fake.spawn);
  const controller = new AbortController();
  const running = e.run(turnInput({ signal: controller.signal }).input);
  await fake.waiting;
  await tick();
  controller.abort(stopped());
  assert.equal((await running).stop, 'interrupted');
  assert.equal(fake.sent('turn/interrupt').length, 1);
  await settle();
  assert.deepEqual(terminalCalls(fake), []);
  await e.dispose();
});

test('the emergency stop cleans every loaded thread of a running server; a crashed server is neither restarted for it nor for a split\'s unload', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  const one = await e.run(turnInput({ runId: 'run_a', cwd: '/a' }).input);
  const two = await e.run(turnInput({ runId: 'run_b', cwd: '/b' }).input);
  assert.equal(await e.stopBackground(), 2);
  assert.deepEqual(fake.sent('thread/backgroundTerminals/clean').map((r) => r.params.threadId).sort(), [one.session!.ref, two.session!.ref].sort());
  const spawned = fake.calls.length;
  fake.calls[0].child.exit(1); // the app-server ended on its own (a crash): its server object stays, not running
  await settle();
  (e as unknown as { loaded: Map<string, Map<string, string>> }).loaded.set(account().id, new Map([['thr_x', '/a']]));
  assert.equal(await e.stopBackground(), 0);
  await e.unload(account(), 'thr_x');
  assert.equal(fake.calls.length, spawned, 'no process started for the stop or the unload');
  assert.equal(fake.sent('thread/backgroundTerminals/clean').length, 2);
  await e.dispose();
});

test('a thread nobody resumes leaves with its background commands: a helper thread, a deleted thread', async () => {
  const order = (fake: { requests: any[] }, methods: string[]) => fake.requests.map((r) => r.method).filter((m) => methods.includes(m));
  // A helper turn (no tools, no hub, no session): its ephemeral thread is cleaned and left.
  const helper = appServer();
  const h = engineOf(helper.spawn);
  await h.run(turnInput({ runId: 'run_h', tools: [] }).input);
  await settle();
  assert.deepEqual(order(helper, ['thread/backgroundTerminals/clean', 'thread/unsubscribe']), ['thread/backgroundTerminals/clean', 'thread/unsubscribe']);
  await h.dispose();
  // A deleted thread still loaded here is cleaned before thread/delete; one not loaded is deleted without it.
  const del = appServer();
  const x = engineOf(del.spawn);
  const kept = await x.run(turnInput({ runId: 'run_d' }).input);
  assert.equal(await x.deleteSession(account(), kept.session!.ref), 'deleted');
  assert.equal(await x.deleteSession(account(), 'thr_elsewhere'), 'deleted');
  assert.deepEqual(order(del, ['thread/backgroundTerminals/clean', 'thread/delete']), ['thread/backgroundTerminals/clean', 'thread/delete', 'thread/delete']);
  await x.dispose();
});

test('a turn stopped before turn/start (e.g. the emergency stop during a cold start) makes no model call', async () => {
  const fake = appServer();
  const e = engineOf(fake.spawn);
  const controller = new AbortController();
  controller.abort(stopped());
  const result = await e.run(turnInput({ signal: controller.signal }).input);
  assert.equal(result.stop, 'interrupted');
  assert.equal(fake.sent('turn/start').length, 0);
  await e.dispose();
});
