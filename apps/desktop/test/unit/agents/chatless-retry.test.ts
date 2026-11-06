// B-054 failure retry (agents/dispatch-runs.ts retryAt): a failed or crashed run with neither chat nor task (a mail, a
// connector event) has nowhere else to keep its note, so its wakes go back to the queue with backoff – due in
// 2^attempts minutes, capped at 30, the attempts the queue counts on each claim. A run with a chat or
// a task, a done run and a stopped run settle as before.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryAt, RunningTurns } from '../../../src/runtime/agents/dispatch-runs.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import type { LiveStatus } from '../../../src/runtime/agents/dispatch-live.ts';
import type { TurnOutcome, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { RuntimeServices, Wake } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';

const MIN = 60_000;
const NOW = 1_000_000;
const MAIL = { source: 'app:box', label: 'New mail in me@example.test' };

function wake(id: string, patch: Partial<Wake> = {}): Wake {
  return { id, agentId: 'ag_tom', reason: 'event', dueAt: 10, createdAt: 10, attempts: 1, origin: MAIL, note: 'New mail', ...patch };
}

function rig(execute: (request: TurnRequest) => Promise<TurnOutcome>) {
  const settled: string[] = [];
  const services = {
    clock: { now: () => NOW },
    tasks: { get: () => undefined },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    wakes: {
      done: (ids: string[]) => settled.push(`done:${ids.join(',')}`),
      release: (ids: string[], dueAt?: number) => settled.push(`release:${ids.join(',')}${dueAt === undefined ? '' : `@${dueAt}`}`),
    },
    runs: { get: () => ({ status: 'running' }), finish() {} },
  } as unknown as RuntimeServices;
  const live = { awake() {}, status() {}, emit() {} } as unknown as LiveStatus;
  const turns = new RunningTurns({ services: () => services, executor: { execute }, supervisor: { admit: async () => () => {} } }, live, () => {});
  const run = async (wakes: Wake[]) => {
    const [group] = groupWakes(wakes);
    turns.start(services, { id: 'ag_tom' } as Agent, group!);
    await turns.get('ag_tom')!.finished;
  };
  return { settled, turns, run };
}

test('retryAt: chat-free work retries with bounded backoff, even after many failures; chats and tasks continue elsewhere', () => {
  assert.equal(retryAt({ attempts: 1 }, NOW), NOW + 2 * MIN);
  assert.equal(retryAt({ attempts: 2 }, NOW), NOW + 4 * MIN);
  assert.equal(retryAt({ attempts: 3 }, NOW), NOW + 8 * MIN);
  assert.equal(retryAt({ attempts: 4 }, NOW), NOW + 16 * MIN);
  assert.equal(retryAt({ attempts: 5 }, NOW), NOW + 30 * MIN);
  assert.equal(retryAt({ attempts: 10_000 }, NOW), NOW + 30 * MIN);
  assert.equal(retryAt({ attempts: Number.MAX_SAFE_INTEGER }, NOW), NOW + 30 * MIN);
  assert.equal(retryAt({ attempts: 1, conversationId: 'cv_1' }, NOW), undefined);
  assert.equal(retryAt({ attempts: 1, taskId: 'tk_1' }, NOW), undefined);
});

test('a failed chat-free run releases its wakes with backoff; a crash too; done ends them', async () => {
  const failed = rig(async (request) => ({ runId: request.runId, status: 'failed', error: 'engine down' }));
  await failed.run([wake('wk_1', { attempts: 2 })]);
  assert.deepEqual(failed.settled, [`release:wk_1@${NOW + 4 * MIN}`]);

  const crashed = rig(async () => { throw new Error('boom'); });
  await crashed.run([wake('wk_1')]);
  assert.deepEqual(crashed.settled, [`release:wk_1@${NOW + 2 * MIN}`]);

  const done = rig(async (request) => ({ runId: request.runId, status: 'done' }));
  await done.run([wake('wk_1')]);
  assert.deepEqual(done.settled, ['done:wk_1']);
});

test('a run with a task or chat, and a stopped run end their wakes as before', async () => {
  const fail = async (request: TurnRequest): Promise<TurnOutcome> => ({ runId: request.runId, status: 'failed' });

  const task = rig(fail);
  await task.run([wake('wk_1', { taskId: 'tk_1', reason: 'task' })]);
  assert.deepEqual(task.settled, ['done:wk_1']);

  const chat = rig(fail);
  await chat.run([wake('wk_1', { conversationId: 'cv_1', reason: 'message' })]);
  assert.deepEqual(chat.settled, ['done:wk_1']);

  let stopped!: ReturnType<typeof rig>;
  stopped = rig(async (request) => {
    stopped.turns.get('ag_tom')!.control.stopKind = 'human';
    return { runId: request.runId, status: 'failed' };
  });
  await stopped.run([wake('wk_1')]);
  assert.deepEqual(stopped.settled, ['done:wk_1'], 'the person stopped it: no retry');
});

test('with the real queue the note survives more than three failures, backoff caps, and success removes the wake', async () => {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(NOW);
  const queue = new WakeQueueImpl({ db, clock });
  const live = { awake() {}, status() {}, emit() {} } as unknown as LiveStatus;
  const services = {
    clock, wakes: queue, tasks: { get: () => undefined },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as RuntimeServices;
  let succeeded = false;
  const turns = new RunningTurns({
    services: () => services,
    executor: { execute: async (request) => ({ runId: request.runId, status: succeeded ? 'done' : 'failed' }) },
    supervisor: { admit: async () => () => {} },
  }, live, () => {});
  const run = async (claimed: Wake[]) => {
    turns.start(services, { id: 'ag_tom' } as Agent, groupWakes(claimed)[0]!);
    await turns.get('ag_tom')!.finished;
  };
  queue.wake({ agentId: 'ag_tom', reason: 'event', note: 'New mail in me@example.test: 1 new message.', origin: MAIL });
  for (let round = 1; round <= 8; round++) {
    const claimed = queue.claim('ag_tom', clock.now());
    assert.equal(claimed.length, 1, `round ${round}`);
    const [only] = claimed;
    assert.equal(only!.attempts, round);
    assert.equal(only!.note, 'New mail in me@example.test: 1 new message.');
    assert.deepEqual(only!.origin, MAIL);
    const at = retryAt({ attempts: only!.attempts }, clock.now());
    assert.equal(at, clock.now() + Math.min(30, 2 ** round) * MIN);
    await run(claimed);
    assert.equal(queue.pending('ag_tom'), 1, `failure ${round} keeps the durable wake`);
    assert.equal(queue.claim('ag_tom', clock.now()).length, 0, 'not before the backoff');
    clock.set(at!);
  }
  succeeded = true;
  await run(queue.claim('ag_tom', clock.now()));
  assert.equal(queue.pending('ag_tom'), 0);
  assert.equal(queue.list('ag_tom').length, 0, 'success removes the claimed wake too');
  db.close();
});

test('B-054 fix: a claim the dispatcher hands back unrun (another group ran) spends no attempt', () => {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(NOW);
  const queue = new WakeQueueImpl({ db, clock });
  queue.wake({ agentId: 'ag_tom', reason: 'event', note: 'New mail', origin: MAIL });
  for (let round = 0; round < 5; round++) {
    const [only] = queue.claim('ag_tom', clock.now());
    queue.release([only!.id], undefined, true); // deferred behind chat groups
  }
  const [first] = queue.claim('ag_tom', clock.now());
  assert.equal(first!.attempts, 1, 'its first real run is attempt 1');
  assert.ok(retryAt({ attempts: first!.attempts }, clock.now()) !== undefined, 'so a failure is still retried');
});
