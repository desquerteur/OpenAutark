// Tests for the durable wake queue (src/runtime/wakes/queue.ts): coalescing, the
// claim/done/release cycle, crash reconciliation, the scheduler's due queries and change
// notifications. Owns: these assertions only. Never: real timers or sleeps (ManualClock).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(T0);
  const wakes = new WakeQueueImpl({ db, clock });
  const changes: Array<{ agentId: string; dueAt?: number }> = [];
  wakes.onChange(change => changes.push(change));
  return { db, clock, wakes, changes };
}

test('identical wakes merge into one row; different chats or tasks stay apart', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1' });
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1' });
  assert.equal(wakes.pending('ag_a'), 1);
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_2' });
  wakes.wake({ agentId: 'ag_a', reason: 'task', conversationId: 'conv_1', taskId: 'task_1' });
  wakes.wake({ agentId: 'ag_b', reason: 'message', conversationId: 'conv_1' });
  assert.equal(wakes.pending('ag_a'), 3);
  assert.equal(wakes.pending('ag_b'), 1);
  assert.equal(wakes.pending(), 4);
});

test('coalesce key: earliest due time wins, stronger reason is kept, notes join once', () => {
  const { wakes, clock } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', coalesceKey: 'own:task_1', dueAt: T0 + 60_000, note: 'Try another way.' });
  wakes.wake({ agentId: 'ag_a', reason: 'message', taskId: 'task_1', coalesceKey: 'own:task_1', dueAt: T0 + 5_000, note: 'New message.' });
  wakes.wake({ agentId: 'ag_a', reason: 'schedule', coalesceKey: 'own:task_1', dueAt: T0 + 120_000, note: 'Try another way.' });
  const [row] = wakes.list('ag_a');
  assert.equal(wakes.pending('ag_a'), 1);
  assert.equal(row.dueAt, T0 + 5_000);
  assert.equal(row.reason, 'message', 'message (8) beats retry (1) and schedule (3)');
  assert.equal(row.note, 'Try another way.\n\nNew message.', 'a repeated note is not appended twice');
  assert.equal(row.taskId, 'task_1');
  assert.equal(row.createdAt, clock.now());
  assert.equal(row.attempts, 0);
});

test('merging keeps the first chat/task and caps joined notes at 4000 characters (newest kept)', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'review', coalesceKey: 'k', note: 'a'.repeat(3000) });
  wakes.wake({ agentId: 'ag_a', reason: 'review', coalesceKey: 'k', conversationId: 'conv_1', taskId: 'task_1', note: 'b'.repeat(3000) });
  wakes.wake({ agentId: 'ag_a', reason: 'review', coalesceKey: 'k', conversationId: 'conv_2', note: 'tail' });
  const [row] = wakes.list('ag_a');
  assert.equal(row.note!.length, 4000);
  assert.ok(row.note!.endsWith('\n\ntail'));
  assert.equal(row.conversationId, 'conv_1');
  assert.equal(row.taskId, 'task_1');
});

test('claim takes only due wakes of that agent, oldest first, and counts the attempt', () => {
  const { wakes, clock } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_2', dueAt: T0 - 1000 });
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', dueAt: T0 - 5000 });
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', dueAt: T0 + 60_000 });
  wakes.wake({ agentId: 'ag_b', reason: 'message', conversationId: 'conv_1' });
  const claimed = wakes.claim('ag_a');
  assert.deepEqual(claimed.map(w => w.conversationId), ['conv_1', 'conv_2']);
  assert.ok(claimed.every(w => w.claimedAt === T0 && w.attempts === 1));
  assert.equal(wakes.pending('ag_a'), 1, 'the future retry stays unclaimed');
  assert.deepEqual(wakes.claim('ag_a'), [], 'nothing due is left');
  // Claiming "up to" a later instant (budget resume) also takes the future one.
  assert.equal(wakes.claim('ag_a', T0 + 60_000).length, 1);
  clock.advance(1);
  assert.equal(wakes.pending('ag_b'), 1);
});

test('a claimed wake frees its key: a new wake with the same key is a fresh row while it runs', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', coalesceKey: 'chat:conv_1' });
  const [running] = wakes.claim('ag_a');
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', coalesceKey: 'chat:conv_1', note: 'newer' });
  assert.equal(wakes.pending('ag_a'), 1);
  assert.equal(wakes.list('ag_a').length, 2);
  wakes.done([running.id]);
  const [left] = wakes.list('ag_a');
  assert.equal(left.note, 'newer');
  assert.equal(left.claimedAt, undefined);
});

test('done removes finished wakes; unknown ids are ignored', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1' });
  const claimed = wakes.claim('ag_a');
  wakes.done([...claimed.map(w => w.id), 'wk_nope']);
  assert.equal(wakes.list('ag_a').length, 0);
});

test('release puts a wake back under its own coalesce key (regression: key was lost)', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', coalesceKey: 'own:task_1', note: 'Continue.' });
  const claimed = wakes.claim('ag_a');
  wakes.release(claimed.map(w => w.id));
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', coalesceKey: 'own:task_1', note: 'Continue.' });
  assert.equal(wakes.pending('ag_a'), 1, 'the released wake and the new one share the key and merge');
  const [row] = wakes.list('ag_a');
  assert.equal(row.attempts, 1, 'release keeps the attempt count of the claim');
  assert.equal(row.claimedAt, undefined);
  assert.equal(row.reason, 'retry');
});

test('release merges with a wake that arrived meanwhile and can postpone', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', coalesceKey: 'chat:conv_1', note: 'first' });
  const [first] = wakes.claim('ag_a');
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', coalesceKey: 'chat:conv_1', note: 'second' });
  wakes.release([first.id], T0 + 3_600_000);
  const rows = wakes.list('ag_a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dueAt, T0, 'the newer wake is due now, so the merged row stays due now');
  assert.equal(rows[0].note, 'first\n\nsecond', 'notes stay in the order they were written');

  // Alone, a released wake takes the postponed due time.
  const [again] = wakes.claim('ag_a');
  wakes.release([again.id], T0 + 3_600_000);
  assert.equal(wakes.list('ag_a')[0].dueAt, T0 + 3_600_000);
  assert.deepEqual(wakes.claim('ag_a'), []);
  assert.equal(wakes.list('ag_a')[0].attempts, 2);
});

test('release of an unknown id does nothing; release without due time keeps the old one', () => {
  const { wakes, changes } = setup();
  wakes.release(['wk_c0000000000000.missing']);
  assert.equal(changes.length, 0);
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', dueAt: T0 - 10_000 });
  const [w] = wakes.claim('ag_a');
  wakes.release([w.id]);
  assert.equal(wakes.list('ag_a')[0].dueAt, T0 - 10_000);
});

test('reconcile after a crash: claimed wakes become due again under their key, unclaimed stay', () => {
  const { db, clock, wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', coalesceKey: 'own:task_1', dueAt: T0 - 1000, note: 'Continue.' });
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_2', coalesceKey: 'own:task_2', dueAt: T0 + 60_000 });
  wakes.claim('ag_a');
  // The process dies here. A new process opens the same database.
  clock.advance(10 * 60_000);
  const restarted = new WakeQueueImpl({ db, clock });
  assert.equal(restarted.reconcile(), 1);
  assert.equal(restarted.pending('ag_a'), 2);
  assert.deepEqual(restarted.dueAgents(), ['ag_a']);
  // Ownership.recover() wakes the same task again: it merges instead of doubling the turn.
  restarted.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', coalesceKey: 'own:task_1', note: 'You were interrupted.' });
  assert.equal(restarted.pending('ag_a'), 2);
  const row = restarted.list('ag_a').find(w => w.taskId === 'task_1')!;
  assert.equal(row.dueAt, T0 - 1000, 'a wake that was already due keeps its due time');
  assert.equal(row.note, 'Continue.\n\nYou were interrupted.');
  assert.equal(restarted.reconcile(), 0, 'nothing claimed is left');
});

test('reconcile moves a claimed future wake to now (claimed early by budget resume)', () => {
  const { db, clock, wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', dueAt: T0 + 3_600_000 });
  wakes.claim('ag_a', T0 + 3_600_000);
  const restarted = new WakeQueueImpl({ db, clock });
  restarted.reconcile();
  assert.equal(restarted.list('ag_a')[0].dueAt, T0);
});

test('reconcile keeps working for rows claimed by an older build (plain claimed ids)', () => {
  const { db, clock, wakes } = setup();
  db.run(
    'INSERT INTO wakes (id, agent_id, conversation_id, task_id, reason, note, due_at, created_at, claimed_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['wk_0000000001abcdefgh', 'ag_a', 'conv_1', null, 'message', 'old', T0 - 5000, T0 - 6000, T0 - 4000, 1],
  );
  assert.equal(wakes.reconcile(), 1);
  const [row] = wakes.list('ag_a');
  assert.equal(row.claimedAt, undefined);
  assert.equal(row.note, 'old');
  // It now lives under the default key, so an identical event wake merges with it.
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1' });
  assert.equal(wakes.pending('ag_a'), 1);
  clock.advance(1);
});

test('dueAgents, dueBetween and nextDueAfter ignore claimed rows', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_b', reason: 'message', conversationId: 'conv_1', dueAt: T0 - 1000 });
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', dueAt: T0 });
  wakes.wake({ agentId: 'ag_c', reason: 'retry', taskId: 'task_1', dueAt: T0 + 30_000 });
  wakes.wake({ agentId: 'ag_d', reason: 'retry', taskId: 'task_2', dueAt: T0 + 90_000 });
  assert.deepEqual(wakes.dueAgents(), ['ag_a', 'ag_b']);
  assert.deepEqual(wakes.dueAgents(T0 + 30_000), ['ag_a', 'ag_b', 'ag_c']);
  assert.deepEqual(wakes.dueBetween(T0 - 1000, T0 + 30_000).sort(), ['ag_a', 'ag_c'], '(from, to]: from is exclusive');
  assert.deepEqual(wakes.dueBetween(T0 + 30_000, T0 + 60_000), []);
  assert.equal(wakes.nextDueAfter(T0), T0 + 30_000);
  assert.equal(wakes.nextDueAfter(T0 + 30_000), T0 + 90_000);
  assert.equal(wakes.nextDueAfter(T0 + 90_000), undefined);
  wakes.claim('ag_c', T0 + 30_000);
  assert.equal(wakes.nextDueAfter(T0), T0 + 90_000, 'a claimed wake is no longer a timer candidate');
  assert.deepEqual(wakes.dueAgents(T0 + 30_000), ['ag_a', 'ag_b']);
});

test('cancel removes unclaimed wakes of one agent (optionally per task or chat)', () => {
  const { wakes, changes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1' });
  wakes.wake({ agentId: 'ag_a', reason: 'task', conversationId: 'conv_1', taskId: 'task_1' });
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_2' });
  wakes.wake({ agentId: 'ag_b', reason: 'message', conversationId: 'conv_1' });
  wakes.cancel('ag_a', { taskId: 'task_1' });
  assert.equal(wakes.pending('ag_a'), 2);
  wakes.cancel('ag_a', { conversationId: 'conv_1' });
  assert.deepEqual(wakes.list('ag_a').map(w => w.conversationId), ['conv_2']);
  const before = changes.length;
  wakes.cancel('ag_a', { conversationId: 'conv_9' });
  assert.equal(changes.length, before, 'nothing removed → no change notification');
  wakes.cancel('ag_a');
  assert.equal(wakes.pending('ag_a'), 0);
  assert.equal(wakes.pending('ag_b'), 1);
});

test('cancelTask removes unclaimed wakes of every agent for the task, optionally by reason', () => {
  const { wakes, changes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_1', coalesceKey: 'own:task_1' });
  wakes.wake({ agentId: 'ag_m', reason: 'review', taskId: 'task_1', coalesceKey: 'review:task_1' });
  wakes.wake({ agentId: 'ag_b', reason: 'retry', taskId: 'task_1', dueAt: T0 - 1 });
  wakes.wake({ agentId: 'ag_a', reason: 'retry', taskId: 'task_2' });
  const [running] = wakes.claim('ag_b');
  changes.length = 0;
  wakes.cancelTask('task_1', ['retry']);
  assert.deepEqual(wakes.list('ag_a').map(w => w.taskId), ['task_2']);
  assert.equal(wakes.pending('ag_m'), 1, 'the manager review survives a retry-only cancel');
  assert.equal(wakes.list('ag_b')[0].id, running.id, 'a running (claimed) wake is never cancelled');
  assert.deepEqual(changes.map(c => c.agentId), ['ag_a']);
  wakes.cancelTask('task_1');
  assert.equal(wakes.pending('ag_m'), 0);
});

test('onChange: insert, merge, cancel and release notify; requeueing is silent per row', () => {
  const { wakes, changes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1' });
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'conv_1', dueAt: T0 + 5000 });
  assert.deepEqual(changes, [{ agentId: 'ag_a', dueAt: T0 }, { agentId: 'ag_a', dueAt: T0 + 5000 }]);
  changes.length = 0;
  const claimed = wakes.claim('ag_a');
  assert.equal(changes.length, 0, 'claiming is not a change the timer cares about');
  wakes.release(claimed.map(w => w.id), T0 + 60_000);
  assert.deepEqual(changes, [{ agentId: 'ag_a', dueAt: T0 + 60_000 }], 'one notification per agent');
  changes.length = 0;
  const off = wakes.onChange(() => { throw new Error('listener bug'); });
  assert.doesNotThrow(() => wakes.wake({ agentId: 'ag_b', reason: 'manual' }), 'a broken listener never breaks the writer');
  off();
  assert.equal(changes.length, 1);
});
