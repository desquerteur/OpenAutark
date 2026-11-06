// The "Later" part (F04) on the app's other surfaces (INT-1): a snooze's recorded end
// (shared/model/todo-later.ts snoozedUntil – only for a snoozed to-do), the offline list's row
// time for a "Later" item (tasks/todo-time.ts laterText: "Snoozed until …", "Snoozed", the ring
// time), and the store's views over the list – todosNow (what the chat's catch-up digest reads)
// and forYouCount (the workspace tab's number) leave "Later" out and follow the For-you clock.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { snoozedUntil } from '../../../src/shared/model/todo-later.ts';
import { forYouCount, todoClock, todos, todosNow } from '../../../src/ui/lib/store.ts';
import { HOUR_MS, LATER_MS, MINUTE_MS, laterText, splitLater, whenText } from '../../../src/ui/tasks/model.ts';

const NOW = new Date(2026, 9, 20, 16, 55, 0).getTime(); // local time, 16:55
const DAY = 24 * HOUR_MS;
let seq = 0;

function todo(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: patch.id ?? `todo_${seq}`, conversationId: 'ch_a', title: `To-do ${seq}`, notes: '', status: 'open', assigneeKind: 'human',
    createdBy: 'ag_ava', priority: 0, ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Alpha', running: false,
    ...patch,
  };
}

const timer = (at: number, patch: Partial<TaskView> = {}) => todo({ widget: { type: 'timer', label: 'Stretch', at: new Date(at).toISOString() }, dueAt: at, ...patch });
const snoozed = (until?: number) => todo({ status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW - MINUTE_MS, ...(until === undefined ? {} : { until }) } });

test('snoozedUntil: the end a snooze recorded on its wait – nothing for other waits or older snoozes', () => {
  assert.equal(snoozedUntil(snoozed(NOW + 10 * MINUTE_MS)), NOW + 10 * MINUTE_MS);
  assert.equal(snoozedUntil(snoozed()), undefined, 'a snooze from before `until` was recorded');
  const repeats = todo({ status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Repeats', since: NOW, until: NOW + DAY } });
  assert.equal(snoozedUntil(repeats), undefined, 'a repeating timer is not snoozed');
  const external = todo({ status: 'waiting', waitingOn: { kind: 'external', reason: 'Snoozed', since: NOW, until: NOW + HOUR_MS } });
  assert.equal(snoozedUntil(external), undefined, 'only a wait for a ring');
  assert.equal(snoozedUntil(todo({ waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW, until: NOW + HOUR_MS } })), undefined, 'an open to-do');
});

test('laterText: the offline row time of a "Later" item', () => {
  assert.equal(laterText(snoozed(NOW + 15 * MINUTE_MS), NOW), `Snoozed until ${whenText(NOW + 15 * MINUTE_MS, NOW)}`);
  assert.equal(laterText(snoozed(), NOW), 'Snoozed', 'without a recorded end');
  const far = NOW + 3 * DAY;
  assert.equal(laterText(timer(far), NOW), whenText(far, NOW), 'a timer far ahead: its ring time');
  const next = NOW + DAY;
  const repeats = timer(next, { status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Repeats', since: NOW } });
  assert.equal(laterText(repeats, NOW), whenText(next, NOW), 'a repeating timer: its next ring');
  assert.equal(laterText(todo({ dueAt: far }), NOW), undefined, 'no timer: the row keeps its due time');
});

test('the offline list splits at the time it is shown: what is due now, then "Later"', () => {
  const sign = todo({ title: 'Sign the form' });
  const nap = snoozed(NOW + HOUR_MS);
  const far = timer(NOW + LATER_MS + HOUR_MS);
  const split = splitLater([nap, far, sign], NOW);
  assert.deepEqual(split.now.map((task) => task.id), [sign.id]);
  assert.deepEqual(split.later.map((task) => task.id).sort(), [far.id, nap.id].sort());
  assert.deepEqual(splitLater([nap, far, sign], NOW + 2 * HOUR_MS).now.map((task) => task.id), [far.id, sign.id], 'a snapshot read later: the timer is due by then');
});

test('store: todosNow and forYouCount leave "Later" out and follow the For-you clock', () => {
  const sign = todo({ title: 'Sign the form' });
  const nap = snoozed(NOW + HOUR_MS);
  const far = timer(NOW + LATER_MS + HOUR_MS);
  const before = { list: todos.value, clock: todoClock.value };
  try {
    todoClock.value = NOW;
    todos.value = [sign, nap, far];
    assert.deepEqual(todosNow.value.map((task) => task.id), [sign.id], 'the catch-up digest reads only what is due now');
    assert.equal(forYouCount.value, 1, 'the workspace tab counts only what is due now');
    todoClock.value = NOW + 2 * HOUR_MS;
    assert.deepEqual(todosNow.value.map((task) => task.id), [sign.id, far.id], 'the timer comes within 12 h');
    assert.equal(forYouCount.value, 1, 'the badge is the Needs-you rule: a timer that has not rung waits under Today');
  } finally {
    todos.value = before.list;
    todoClock.value = before.clock;
  }
});
