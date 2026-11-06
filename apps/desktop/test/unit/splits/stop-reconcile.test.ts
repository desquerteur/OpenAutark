// B-057 track A: stops and the boot recovery – the person's stop of a group aborts its running parts on their lanes,
// stops the waiting ones and ends the group without a parent wake; the parent's own stop ends the group normally (it
// gets the partial results); the person's stop of one part lets the rest go on; work-stop, pausing and archiving the
// agent stop its splits; reconcile after a restart queues interrupted parts again (their cut attempt does not count –
// restart-release.test.ts covers the bound), starts or stops pending groups by their parent run, settles ended groups,
// and is idempotent.
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { CHAT, PARENT, part, splitAndEnd, world } from './fixture.ts';

test("the person's stop of a group: running parts aborted, waiting ones stopped, no parent wake", () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B', { after: [1] }), part('C')]);
  const [a, c] = w.lanes.started;
  w.lanes.end(c, 'done', { answer: 'C' });
  assert.equal(w.splits.stop({ groupId }, HUMAN_ID), 2, 'A (running) and B (waiting)');
  assert.deepEqual(w.lanes.stopped, [{ splitId: a, why: 'human' }]);
  const group = w.splits.list({ groupId })[0];
  assert.equal(group.status, 'stopped');
  assert.deepEqual(group.splits.map((split) => [split.status, split.error]), [['stopped', 'Stopped by the person.'], ['stopped', 'Stopped by the person.'], ['done', undefined]]);
  w.lanes.end(a, 'stopped'); // the aborted lane reports its end later
  assert.equal(w.splits.list({ groupId })[0].status, 'stopped');
  assert.equal(w.wakes.list('ag_ava').length, 0, 'the person stopped it: nobody is woken');
  assert.equal(w.splits.pendingResults('ag_ava', CHAT), undefined);
  assert.equal(w.splits.stop({ groupId }, HUMAN_ID), 0, 'nothing left to stop');
});

test('the parent agent stops its own group: it ends normally and gets the partial results', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const [a] = w.lanes.started;
  w.lanes.end(a, 'done', { answer: 'A is done' });
  assert.equal(w.splits.stop({ groupId }, 'ag_ava'), 1);
  const group = w.splits.list({ groupId })[0];
  assert.equal(group.status, 'settled');
  assert.equal(group.splits[1].error, 'Stopped by its main self.');
  assert.equal(w.wakes.list('ag_ava').length, 1);
  const text = w.splits.pendingResults('ag_ava', CHAT)!.text;
  assert.match(text, /A is done/);
  assert.match(text, /### #2 B – stopped – Stopped by its main self\./);
});

test("the person's stop of one part: the others go on and the group ends normally", () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const [a, b] = w.lanes.started;
  assert.equal(w.splits.stop({ splitId: a }, HUMAN_ID), 1);
  assert.equal(w.splits.list({ groupId })[0].status, 'running');
  w.lanes.end(b, 'done', { answer: 'B' });
  assert.equal(w.splits.list({ groupId })[0].status, 'settled');
  assert.equal(w.wakes.list('ag_ava').length, 1);
});

test('a group stopped before its parent turn ended never starts', () => {
  const w = world();
  const view = w.splits.create(w.ctx(), { goal: 'Review', parts: [part('A')] });
  assert.equal(w.splits.stop({ groupId: view.id }, 'ag_ava'), 1);
  assert.equal(w.splits.list({ groupId: view.id })[0].status, 'stopped');
  w.splits.afterParentTurn(PARENT, 'done');
  assert.equal(w.lanes.started.length, 0);
  assert.equal(w.wakes.list('ag_ava').length, 0);
});

test('reconcile after a restart: interrupted parts queued again without using the cut attempt, pending groups started or stopped, idempotent', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B'), part('C')]);
  const [a, b, c] = w.lanes.started;
  w.lanes.end(c, 'failed', { retryable: true, error: 'busy' }); // C runs its second attempt now
  assert.equal(w.splits.get(c)!.split.attempts, 2);
  w.lanes.end(b, 'done', { answer: 'B' });
  // Two pending groups: one whose parent turn ended before the crash, one whose parent run is gone.
  w.runs.start({ id: 'run_two', agentId: 'ag_ava', conversationId: CHAT, trigger: 'message' });
  const ended = w.splits.create(w.ctx({ runId: 'run_two' }), { goal: 'Ended parent', parts: [part('X')] }).id;
  w.runs.finish('run_two', { status: 'interrupted', endedAt: w.clock.now() });
  w.db.run(`INSERT INTO split_groups (id, agent_id, parent_run_id, thread, goal, status, created_at) VALUES ('sgr_gone', 'ag_ava', 'run_gone', ?, 'Gone', 'pending', ?)`, [CHAT, w.clock.now()]);
  w.db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('spl_gone', 'sgr_gone', 'ag_ava', 1, 'Y', 'Do y.', ?)`, [w.clock.now()]);

  // The app stops: A (attempt 1) and C (attempt 2) were running. A new service on the same database:
  const after = w.restart();
  const first = after.splits.reconcile();
  assert.deepEqual(first, { requeued: 2, finished: 0, failed: 0, started: 1, stopped: 1 });
  const group = after.splits.list({ groupId })[0];
  assert.deepEqual(group.splits.map((split) => split.status), ['running', 'done', 'running'], 'A and C queued again and started at once');
  assert.deepEqual([after.splits.get(a)!.split.attempts, after.splits.get(c)!.split.attempts], [1, 2], 'the cut attempts did not count');
  assert.equal(after.splits.list({ groupId: ended })[0].status, 'running', 'its parent ended: it starts');
  assert.equal(after.splits.list({ groupId: 'sgr_gone' })[0].status, 'stopped');
  assert.deepEqual(after.lanes.started.sort(), [a, c, after.splits.list({ groupId: ended })[0].splits[0].id].sort());

  const second = after.splits.reconcile();
  assert.deepEqual(second, { requeued: 0, finished: 0, failed: 0, started: 0, stopped: 0 }, 'idempotent: running lanes are left alone');
  assert.equal(after.lanes.started.length, 3);

  after.lanes.end(a, 'done', { answer: 'A' });
  after.lanes.end(c, 'done', { answer: 'C' });
  assert.equal(after.splits.list({ groupId })[0].status, 'settled');
  assert.equal(w.wakes.list('ag_ava').filter((wake) => wake.note?.includes('Review the release')).length, 1);
});

test('reconcile settles a group whose parts all ended before the restart wrote its end', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A')]);
  w.db.run(`UPDATE splits SET status = 'done', ended_at = ? WHERE group_id = ?`, [w.clock.now(), groupId]); // the end was written, the settle was not
  const after = w.restart();
  after.splits.reconcile();
  assert.equal(after.splits.list({ groupId })[0].status, 'settled');
  assert.equal(w.wakes.list('ag_ava').length, 1);
});
