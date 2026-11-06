// The calm For-you list's order and time rules (F04, src/ui/tasks/todo-time.ts via tasks/model.ts):
// a to-do that rang sorts first (before an open one due earlier); the
// "Later" split takes snoozed to-dos, repeating timers waiting for their next time, timers more
// than 12 h ahead and (B-041) any other to-do due on a later day, never one that rang; the badge
// counts only what is due now; the snooze choices' "Tomorrow" at the start of work across the
// 04:00 day boundary; a timer's row
// time and its countdown in the last hour; a snooze's end from its schedule; the For-you clock's
// next change (also when "now" becomes "1 minute ago" after a ring, "in 3 hours" moves on, or
// "Tomorrow" at midnight); the chat panel leaves "Later" to-dos out.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Schedule, TaskView } from '../../../src/shared/model/tasks.ts';
import { relative, time } from '../../../src/ui/lib/format.ts';
import {
  HOUR_MS, LATER_MS, MINUTE_MS, compareTodos, countNow, countdownMs, isLater, isRinging, isSnoozed, nextListChange,
  onForYouList, relativeChange, snoozeEnd, splitLater, timerAt, whenText,
} from '../../../src/ui/tasks/model.ts';
import { endOfToday, nextMorning, snoozeChoices } from '../../../src/ui/tasks/todo-time.ts';

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

/** A timer to-do ringing at `at` (absolute, as the runtime stores it), due then. */
function timer(at: number, patch: Partial<TaskView> = {}): TaskView {
  return todo({ widget: { type: 'timer', label: 'Stretch', at: new Date(at).toISOString() }, dueAt: at, ...patch });
}

const snoozed = (patch: Partial<TaskView> = {}) => todo({ status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW - MINUTE_MS }, ...patch });

test('compareTodos: what rang first, then by due – a ringing to-do beats an open one due earlier', () => {
  const soon = todo({ dueAt: NOW + 5 * MINUTE_MS });
  const rang = timer(NOW - 2 * MINUTE_MS, { status: 'needs_you' });
  const later = todo({ dueAt: NOW + 3 * HOUR_MS });
  const ringingLate = todo({ status: 'needs_you', dueAt: NOW + DAY });
  assert.deepEqual([later, soon, ringingLate, rang].sort(compareTodos).map((t) => t.id), [rang.id, ringingLate.id, soon.id, later.id]);
  // An agent's task needing the person is no ringing to-do (the chat panel sorts those too).
  const agentAsk = todo({ status: 'needs_you', assigneeKind: 'agent', dueAt: NOW + DAY });
  assert.deepEqual([agentAsk, soon].sort(compareTodos).map((t) => t.id), [soon.id, agentAsk.id]);
});

test('splitLater: snoozed, waiting for the next ring and timers > 12 h ahead go under Later; one that rang never does', () => {
  const now1 = todo({ title: 'Sign the form' });
  const near = timer(NOW + 5 * MINUTE_MS);
  const edge = timer(NOW + LATER_MS); // exactly 12 h ahead: still now
  const far = timer(NOW + LATER_MS + MINUTE_MS);
  const week = timer(NOW + 7 * DAY);
  const nap = snoozed({ widget: { type: 'timer', label: 'Bread', at: new Date(NOW - 10 * MINUTE_MS).toISOString() }, dueAt: NOW - 10 * MINUTE_MS });
  const repeats = timer(NOW + DAY, { status: 'waiting', waitingOn: { kind: 'schedule', id: 'sch_1', reason: 'Repeats', since: NOW } });
  const rangFar = timer(NOW + 2 * DAY, { status: 'needs_you' }); // rang (e.g. a snooze ended) – it needs the person now
  const plainFar = todo({ dueAt: NOW + 7 * DAY }); // not a timer: due on a later day (B-041)
  const plainToday = todo({ dueAt: NOW + 2 * HOUR_MS }); // due later today: now
  const split = splitLater([week, now1, nap, far, near, repeats, edge, rangFar, plainFar, plainToday], NOW);
  assert.deepEqual(split.now.map((t) => t.id), [rangFar.id, near.id, plainToday.id, edge.id, now1.id]);
  assert.deepEqual(split.later.map((t) => t.id), [nap.id, far.id, repeats.id, plainFar.id, week.id], 'Later in the calm order too');
  assert.equal(isLater(far, NOW + MINUTE_MS + 1), false, 'a timer joins the list once it is within 12 h');
  assert.equal(isSnoozed(nap), true);
  assert.equal(isSnoozed(repeats), false, 'a repeating timer waits, it is not snoozed');
  assert.equal(isRinging(rangFar), true);
});

test('B-041: a to-do due on a later day waits under Later until its day starts; one that rang or is overdue never does', () => {
  const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
  assert.equal(endOfToday(NOW), midnight, 'today ends at the next local midnight');
  const tomorrow = todo({ dueAt: midnight + 9 * HOUR_MS });
  const tonight = todo({ dueAt: midnight - MINUTE_MS });
  const atMidnight = todo({ dueAt: midnight });
  assert.equal(isLater(tomorrow, NOW), true);
  assert.equal(isLater(tonight, NOW), false, 'due before midnight: today');
  assert.equal(isLater(atMidnight, NOW), true, 'midnight already is the next day');
  assert.equal(isLater(tomorrow, midnight), false, 'its day has come');
  assert.equal(isLater(todo({ dueAt: midnight + HOUR_MS, status: 'needs_you' }), NOW), false, 'it rang: it needs the person now');
  assert.equal(isLater(todo({ dueAt: NOW - HOUR_MS }), NOW), false, 'overdue');
  assert.equal(isLater(tomorrow, NOW, midnight + DAY), false, 'a later end of today (another zone: My day reads the profile zone) keeps it today');
  assert.equal(countNow([tomorrow, tonight, todo()], NOW), 2, 'the badge leaves it out');
  assert.equal(countNow([tomorrow, tonight, todo()], NOW, midnight + DAY), 3);
  const dayAfter = todo({ dueAt: midnight + DAY + 23 * HOUR_MS });
  assert.equal(nextListChange([dayAfter], NOW), midnight, 'the list reads it again at midnight (a day word, its Later)');
});

test('B-041 snooze choices: 10 minutes, 1 hour, tomorrow at the start of work – before 04:00 "tomorrow" is the coming morning', () => {
  const choices = snoozeChoices(NOW, '08:30');
  const morning = new Date(2026, 9, 21, 8, 30, 0).getTime();
  assert.deepEqual(choices.map((choice) => choice.until), [NOW + 10 * MINUTE_MS, NOW + HOUR_MS, morning]);
  assert.deepEqual(choices.map((choice) => choice.label), ['In 10 minutes', 'In 1 hour', `Tomorrow ${time(morning)}`]);
  const night = new Date(2026, 9, 21, 0, 40, 0).getTime();
  assert.equal(nextMorning(night, '08:00'), new Date(2026, 9, 21, 8, 0, 0).getTime(), '00:40: the coming morning, same date');
  assert.equal(nextMorning(new Date(2026, 9, 21, 4, 0, 0).getTime(), '08:00'), new Date(2026, 9, 22, 8, 0, 0).getTime(), 'from 04:00 on: the next date');
  assert.equal(nextMorning(NOW, 'later'), new Date(2026, 9, 21, 8, 0, 0).getTime(), 'an unreadable work start: 08:00');
});

test('the badge counts what needs the person now (one rule with the Needs-you group), never a Later one', () => {
  const list = [todo(), timer(NOW + 5 * MINUTE_MS), timer(NOW + 2 * DAY), snoozed(), timer(NOW + HOUR_MS, { status: 'needs_you' })];
  assert.equal(countNow(list, NOW), 2, 'the ask and what rang – a timer that has not rung waits under Today or Later');
  assert.equal(countNow([], NOW), 0);
  assert.equal(countNow([...list, todo({ createdBy: 'human' })], NOW), 2, 'the own to-do of the person waits under Today or Unplanned');
  assert.equal(countNow(list, NOW + 2 * DAY - LATER_MS + 1), 3, 'the far timer still waits for its ring; the near one is overdue by then');
});

test('onForYouList: the rule of todos.list – open, ringing, working and waiting for a ring; no other wait, nothing finished', () => {
  assert.equal(onForYouList(todo()), true);
  assert.equal(onForYouList(todo({ status: 'needs_you' })), true);
  assert.equal(onForYouList(todo({ status: 'working' })), true);
  assert.equal(onForYouList(snoozed()), true);
  assert.equal(onForYouList(todo({ status: 'waiting', waitingOn: { kind: 'external', reason: 'Waiting for the bank', since: NOW } })), false);
  assert.equal(onForYouList(todo({ status: 'done' })), false);
  assert.equal(onForYouList(todo({ status: 'cancelled' })), false);
  assert.equal(onForYouList(snoozed({ assigneeKind: 'agent' })), false, 'agent work is never on the list');
});

test('a timer row: ring time, a countdown in the last hour only ("17:00 · in 5 min")', () => {
  const five = new Date(2026, 9, 20, 17, 0, 0).getTime();
  assert.equal(timerAt(timer(five)), five);
  assert.equal(timerAt(todo({ dueAt: five })), undefined, 'a due date is no ring time');
  assert.equal(timerAt(todo({ widget: { type: 'timer', label: 'x', duration: 'PT5M' } })), undefined, 'not armed yet: no ring time');
  assert.equal(whenText(five, NOW), time(five), 'today: the clock time');
  assert.equal(countdownMs(five, NOW), 5 * MINUTE_MS);
  assert.equal(countdownMs(five, NOW + 30_000), 5 * MINUTE_MS, 'rounded up to whole minutes');
  assert.equal(countdownMs(five, five - 20_000), MINUTE_MS);
  assert.equal(countdownMs(five, five - HOUR_MS), HOUR_MS, 'exactly an hour ahead: the countdown starts');
  assert.equal(countdownMs(five, five - HOUR_MS - 1), undefined, 'more than an hour ahead: no countdown');
  assert.equal(countdownMs(five, five), undefined, 'it rings: no countdown');
  const tomorrow = new Date(2026, 9, 21, 9, 0, 0).getTime();
  assert.equal(whenText(tomorrow, NOW), `Tomorrow ${time(tomorrow)}`);
  const friday = new Date(2026, 9, 23, 9, 0, 0).getTime();
  assert.match(whenText(friday, NOW), new RegExp(`^\\S+ ${time(friday)}$`), 'this week: weekday and time');
  assert.notEqual(whenText(friday, NOW).split(' ')[0], 'Tomorrow');
  const nextMonth = new Date(2026, 10, 24, 9, 0, 0).getTime();
  assert.match(whenText(nextMonth, NOW), /24/, 'further: the date');
});

test('snoozeEnd: the pending one-shot timer of the to-do, not its repeating ring or another to-do\'s', () => {
  const schedule = (patch: Partial<Schedule>): Schedule => ({
    id: `sch_${++seq}`, ownerId: 'human', taskId: 'todo_x', kind: 'timer', title: 'Bread', spec: { at: NOW + 10 * MINUTE_MS }, payload: {},
    runs: 0, active: true, createdAt: NOW, ...patch,
  });
  const list = [
    schedule({ spec: { cron: '0 9 * * *' }, nextAt: NOW + MINUTE_MS }),
    schedule({ taskId: 'todo_y', spec: { at: NOW + 2 * MINUTE_MS } }),
    schedule({ active: false, spec: { at: NOW + 3 * MINUTE_MS } }),
    schedule({ kind: 'message', spec: { at: NOW + 4 * MINUTE_MS } }),
    schedule({ spec: { at: NOW + 10 * MINUTE_MS } }),
  ];
  assert.equal(snoozeEnd(list, 'todo_x'), NOW + 10 * MINUTE_MS);
  assert.equal(snoozeEnd([], 'todo_x'), undefined);
});

test('nextListChange: a timer leaves Later, its countdown starts and moves, it rings; a due time comes near and passes', () => {
  assert.equal(nextListChange([timer(NOW + 13 * HOUR_MS)], NOW), NOW + HOUR_MS, 'it joins the list 12 h ahead');
  assert.equal(nextListChange([timer(NOW + 5 * HOUR_MS)], NOW), NOW + 4 * HOUR_MS, 'its countdown starts an hour ahead');
  assert.equal(nextListChange([timer(NOW + 5 * MINUTE_MS)], NOW), NOW + MINUTE_MS, 'the next countdown minute');
  assert.equal(nextListChange([timer(NOW + 5 * MINUTE_MS)], NOW + 30_000), NOW + MINUTE_MS, 'from mid-minute to the next step');
  assert.equal(nextListChange([timer(NOW + 20_000)], NOW), NOW + 20_000, 'the ring itself');
  assert.equal(nextListChange([todo({ dueAt: NOW + 20_000 })], NOW), NOW + 20_000, 'a due time passes');
  assert.equal(nextListChange([todo({ dueAt: NOW + DAY + 10 * MINUTE_MS })], NOW), NOW + 10 * MINUTE_MS, 'a due time comes within a day');
  assert.equal(nextListChange([todo()], NOW), undefined, 'no time on the row: nothing changes by time');
  assert.equal(nextListChange([timer(NOW + 2 * DAY), timer(NOW + 5 * MINUTE_MS)], NOW), NOW + MINUTE_MS, 'the earliest change wins');
});

test('nextListChange: what a row says keeps up – "2 minutes ago" after a ring, "in 3 hours", "Tomorrow" at midnight', () => {
  const rang = new Date(2026, 9, 20, 17, 0, 0).getTime();
  const ringing = timer(rang, { status: 'needs_you' });
  // Right after the ring the row reads "17:00 · now"; it must not stay that way.
  assert.equal(relative(rang, rang + 1500), relative(rang, rang), 'it rang: "now"');
  assert.equal(nextListChange([ringing], rang + 1500), rang + MINUTE_MS, '"now" becomes "1 minute ago"');
  assert.equal(nextListChange([ringing], rang + 3 * MINUTE_MS), rang + 3.5 * MINUTE_MS + 1, 'then minute by minute');
  assert.equal(nextListChange([ringing], rang + 3 * HOUR_MS), rang + 3.5 * HOUR_MS + 1, 'then hour by hour');
  assert.equal(nextListChange([todo({ dueAt: NOW + 3 * HOUR_MS })], NOW), NOW + HOUR_MS / 2 + 1, '"in 3 hours" becomes "in 2 hours"');
  const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
  const late = new Date(2026, 9, 20, 23, 0, 0).getTime();
  const nine = new Date(2026, 9, 21, 9, 0, 0).getTime();
  assert.equal(nextListChange([timer(nine)], late), midnight, '"Tomorrow 09:00" becomes "09:00" at midnight');
  assert.equal(whenText(nine, midnight), time(nine));
  assert.equal(nextListChange([snoozed()], NOW), midnight, 'a snooze comes back with its ring (an event); only its day word moves');
  assert.equal(nextListChange([todo({ status: 'waiting', waitingOn: { kind: 'external', reason: 'Bank', since: NOW }, dueAt: NOW + HOUR_MS })], NOW), undefined, 'not on the list');
});

test('relativeChange: the next moment relative() reads differently – never later, never a moment without a change', () => {
  const at = NOW;
  const span = [-3 * DAY, -DAY - 1, -DAY, -2 * HOUR_MS, -HOUR_MS, -90_001, -90_000, -MINUTE_MS, -1, 0, 1, 59_999, MINUTE_MS, 89_999, 90_000, HOUR_MS - 1, HOUR_MS, 5 * HOUR_MS, DAY - 1, DAY, 3 * DAY];
  for (let offset = -3 * DAY; offset <= 3 * DAY; offset += 7 * MINUTE_MS + 13_001) span.push(offset);
  for (const offset of span) {
    const now = at - offset;
    const next = relativeChange(at, now);
    assert.ok(next > now, `after now (${offset})`);
    assert.notEqual(relative(at, next), relative(at, now), `it changes at ${next - now} ms (${offset})`);
    assert.equal(relative(at, next - 1), relative(at, now), `nothing changes before (${offset})`);
    assert.equal(relative(at, Math.floor((now + next) / 2)), relative(at, now), `nor in between (${offset})`);
  }
});
