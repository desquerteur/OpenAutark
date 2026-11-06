// B-057 S12 – a cold Codex account gets ONE app-server when several turns (split parts) start at once: CodexEngine's
// server() shares the setup in flight. Before, it awaited the executable lookup before the server entered the pool, so
// concurrent first turns each started a process. A slow fake finder makes the race certain; prewarm and a turn share
// the one server too. Owns: these assertions only. Never: real processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import type { Executable, ExecutableFinder } from '../../../src/runtime/accounts/executables.ts';
import { account, fakeSpawn, testSupervisor, turnInput } from './fakes.ts';

function appServer() {
  let threads = 0;
  let turns = 0;
  const { spawn, calls } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/unsubscribe': child.send({ id: msg.id, result: { status: 'unsubscribed' } }); break;
        case 'turn/start': {
          const threadId = msg.params.threadId;
          const turnId = `turn_${++turns}`;
          child.send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId, turnId, item: { id: `m_${turnId}`, type: 'agentMessage', text: 'done' } } });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
          break;
        }
        default: if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, calls };
}

/** A finder that answers after `ms` – the window in which concurrent first turns raced. */
function slowFinder(ms: number) {
  const seen = { finds: 0 };
  const finder = {
    find: async () => {
      seen.finds++;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { command: '/bin/codex', prefixArgs: [], path: '/bin/codex' } as unknown as Executable;
    },
    clear: () => {},
  } as unknown as ExecutableFinder;
  return { finder, seen };
}

test('three turns starting at once on a cold account share one app-server start', async () => {
  const fake = appServer();
  const { finder, seen } = slowFinder(20);
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder, cwd: '/engine-cwd', version: '0.2.0' });
  const results = await Promise.all([1, 2, 3].map((idx) => engine.run(turnInput({ runId: `run_${idx}` }).input)));
  assert.deepEqual(results.map((result) => result.stop), ['done', 'done', 'done']);
  assert.equal(fake.calls.length, 1, 'one app-server process');
  assert.equal(seen.finds, 1, 'one executable lookup');
  assert.equal(engine.warm(account()), true);
  await engine.dispose();
});

test('a prewarm and a turn starting together share the server; a later turn reuses it', async () => {
  const fake = appServer();
  const { finder, seen } = slowFinder(20);
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder, cwd: '/engine-cwd', version: '0.2.0' });
  const [, turn] = await Promise.all([engine.prewarm(account()), engine.run(turnInput({ runId: 'run_a' }).input)]);
  assert.equal(turn.stop, 'done');
  assert.equal((await engine.run(turnInput({ runId: 'run_b' }).input)).stop, 'done');
  assert.equal(fake.calls.length, 1);
  assert.equal(seen.finds, 1);
  await engine.dispose();
});

test('a failed setup is not kept: the next call looks for Codex again', async () => {
  const fake = appServer();
  let present = false;
  const finder = {
    find: async () => (present ? ({ command: '/bin/codex', prefixArgs: [], path: '/bin/codex' } as unknown as Executable) : null),
    clear: () => {},
  } as unknown as ExecutableFinder;
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder, cwd: '/engine-cwd', version: '0.2.0' });
  const [first, second] = await Promise.all([engine.run(turnInput({ runId: 'run_1' }).input), engine.run(turnInput({ runId: 'run_2' }).input)]);
  assert.equal(first.stop, 'error');
  assert.equal(second.stop, 'error');
  assert.equal(fake.calls.length, 0);
  present = true;
  assert.equal((await engine.run(turnInput({ runId: 'run_3' }).input)).stop, 'done');
  assert.equal(fake.calls.length, 1);
  await engine.dispose();
});
