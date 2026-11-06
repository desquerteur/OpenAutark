// Task.dependsOn (tasks/depends.ts): a task that comes after others waits and wakes nobody; each one that ends shortens the wait;
// after the last one it opens again and its owner hears how it ended. Nothing holds it: it can be moved on by hand.
// Owns: these assertions only. Never: real timers, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom', { createdAt: 1 }));
  h.org.add(agent('ag_ivy', 'Ivy', { createdAt: 2 }));
  const wakesOf = (taskId: string) => h.wakeRows().filter((row) => row.task_id === taskId);
  const done = (id: string, by = 'ag_ivy') => h.tasks.complete(id, { summary: 'Copy is ready', evidence: [], verification: 'claimed_by_agent' }, by);
  return { h, wakesOf, done };
}

test('it waits on what is unfinished, wakes nobody, and goes on after the last one', () => {
  const { h, wakesOf, done } = setup();
  const copy = h.tasks.create({ title: 'Write the copy', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const photo = h.tasks.create({ title: 'Take the photo', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const page = h.tasks.create({ title: 'Build the page', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [copy.id, photo.id] });
  assert.equal(page.status, 'waiting');
  assert.equal(page.waitingOn?.kind, 'task');
  assert.deepEqual(page.waitingOn?.ids, [copy.id, photo.id]);
  assert.match(page.waitingOn?.reason ?? '', /After: Write the copy, Take the photo/);
  assert.deepEqual(wakesOf(page.id), [], 'no turn while it waits');

  done(copy.id);
  assert.equal(h.tasks.get(page.id)?.status, 'waiting');
  assert.deepEqual(h.tasks.get(page.id)?.waitingOn?.ids, [photo.id]);
  assert.deepEqual(wakesOf(page.id), []);

  done(photo.id);
  const after = h.tasks.get(page.id)!;
  assert.equal(after.status, 'open');
  assert.equal(after.waitingOn, undefined);
  assert.deepEqual(after.dependsOn, [copy.id, photo.id], 'the list stays');
  const wake = wakesOf(page.id)[0];
  assert.equal(wake?.agent_id, 'ag_tom');
  assert.match(String(wake?.note ?? ''), /Take the photo.*done: Copy is ready/);
});

test('a finished dependency holds nothing; cancelled and removed ones end the wait too', () => {
  const { h, wakesOf, done } = setup();
  const first = h.tasks.create({ title: 'First', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  done(first.id);
  const free = h.tasks.create({ title: 'Free', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [first.id] });
  assert.equal(free.status, 'open');
  assert.ok(wakesOf(free.id).length, 'its owner starts at once');

  const cancelled = h.tasks.create({ title: 'Cancelled', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const a = h.tasks.create({ title: 'After cancelled', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [cancelled.id] });
  h.tasks.setStatus(cancelled.id, 'cancelled', HUMAN_ID);
  assert.equal(h.tasks.get(a.id)?.status, 'open');
  assert.match(String(wakesOf(a.id)[0]?.note ?? ''), /is cancelled/);

  const removed = h.tasks.create({ title: 'Removed', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const b = h.tasks.create({ title: 'After removed', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [removed.id] });
  h.tasks.remove(removed.id, HUMAN_ID);
  assert.equal(h.tasks.get(b.id)?.status, 'open');
});

test('anyone may move it on; it then only hears; a later change of the list follows', () => {
  const { h, wakesOf, done } = setup();
  const first = h.tasks.create({ title: 'First', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const next = h.tasks.create({ title: 'Next', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [first.id] });
  h.tasks.setStatus(next.id, 'working', 'ag_tom');
  done(first.id);
  assert.equal(h.tasks.get(next.id)?.status, 'working');
  assert.ok(wakesOf(next.id).some((row) => /is done/.test(String(row.note))));

  const later = h.tasks.create({ title: 'Later', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const third = h.tasks.create({ title: 'Third', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  assert.equal(h.tasks.update(third.id, { dependsOn: [later.id] }, HUMAN_ID).status, 'waiting');
  const freed = h.tasks.update(third.id, { dependsOn: [] }, HUMAN_ID);
  assert.equal(freed.status, 'open');
  assert.equal(freed.dependsOn, undefined);
  assert.equal(freed.waitingOn, undefined);
});

test('another wait stays what it is; a person\'s to-do shows up when its turn comes; no loops or unknown tasks', () => {
  const { h, done } = setup();
  const first = h.tasks.create({ title: 'First', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const blocked = h.tasks.create({ title: 'Blocked', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [first.id] });
  h.tasks.setStatus(blocked.id, 'blocked', 'ag_tom', 'needs a key');
  const todo = h.tasks.create({ title: 'Sign it', assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_tom', dependsOn: [first.id] });
  assert.ok(!h.tasks.todos().some((item) => item.id === todo.id), 'not on the list yet');
  done(first.id);
  assert.equal(h.tasks.get(blocked.id)?.status, 'blocked');
  assert.ok(h.tasks.todos().some((item) => item.id === todo.id));

  const a = h.tasks.create({ title: 'A', assigneeId: 'ag_tom', createdBy: HUMAN_ID });
  const b = h.tasks.create({ title: 'B', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [a.id] });
  assert.throws(() => h.tasks.update(a.id, { dependsOn: [b.id] }, HUMAN_ID), /cannot come after itself/);
  assert.throws(() => h.tasks.update(a.id, { dependsOn: [a.id] }, HUMAN_ID), /cannot come after itself/);
  assert.throws(() => h.tasks.create({ title: 'C', createdBy: HUMAN_ID, dependsOn: ['task_gone'] }), /not found/);
});

test('a wait on delegated work outlives the dependency and a change of the list', () => {
  const { h, done } = setup();
  const first = h.tasks.create({ title: 'First', assigneeId: 'ag_ivy', createdBy: HUMAN_ID });
  const job = h.tasks.create({ title: 'Job', assigneeId: 'ag_tom', createdBy: HUMAN_ID, dependsOn: [first.id] });
  h.tasks.setStatus(job.id, 'working', 'ag_tom');
  const part = h.tasks.create({ title: 'Part', assigneeId: 'ag_ivy', createdBy: 'ag_tom', parentId: job.id });
  h.tasks.update(job.id, { status: 'waiting', waitingOn: { kind: 'task', id: part.id, reason: 'Waiting for Ivy', since: 1 } }, 'ag_tom'); // as agents/handoff.ts writes it
  done(first.id);
  assert.equal(h.tasks.get(job.id)?.status, 'waiting', 'the child is still out');
  assert.deepEqual(h.tasks.get(job.id)?.waitingOn?.ids, [part.id]);
  assert.equal(h.tasks.update(job.id, { dependsOn: [] }, HUMAN_ID).status, 'waiting');
  assert.deepEqual(h.tasks.get(job.id)?.waitingOn?.ids, [part.id]);
  done(part.id);
  assert.equal(h.tasks.get(job.id)?.status, 'working', 'its end goes on as ever');
});
