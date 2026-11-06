// My day's groups (src/ui/day/day-groups.ts, B-041 §4.1 / contract §5.5): Needs you (what rang, the block in
// progress, overdue, what an agent or the host asks), Today (the day's blocks and near timers, by time), Unplanned
// (the person's own without a block), Later (snoozed, repeating, far timers, due or planned on a later day); another
// day lists only its blocks; the handed-off rows.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEvent } from '../../../src/shared/model/calendar.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { dayGroups, groupOf, handedOffRows } from '../../../src/ui/day/day-groups.ts';
import type { DayGroupInput } from '../../../src/ui/day/day-groups.ts';
import { countNow, needsYou } from '../../../src/shared/model/todo-later.ts';

const M = 60_000;
const H = 60 * M;
const DAY_START = new Date(2026, 9, 24, 0, 0, 0).getTime();
const DAY_END = DAY_START + 24 * H;
const NOW = DAY_START + 10 * H; // 10:00
let seq = 0;

function todo(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: patch.id ?? `todo_${seq}`, conversationId: 'ch_todo', title: `To-do ${seq}`, notes: '', status: 'open', assigneeKind: 'human',
    createdBy: HUMAN_ID, priority: 0, ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'To-dos', running: false,
    ...patch,
  };
}

function block(taskId: string, startAt: number, minutes = 30, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: `cal_${taskId}`, ownerId: HUMAN_ID, kind: 'todo', taskId, startAt, endAt: startAt + minutes * M, sourceId: 'local',
    setBy: 'planner', state: 'planned', createdBy: 'system', rev: 1, createdAt: NOW, updatedAt: NOW, ...patch,
  };
}

const input = (slots: CalendarEvent[] = [], patch: Partial<DayGroupInput> = {}): DayGroupInput => ({
  now: NOW, dayStart: DAY_START, dayEnd: DAY_END, isToday: true, slots: new Map(slots.filter((slot) => slot.taskId).map((slot) => [slot.taskId!, slot])), ...patch,
});

const timer = (at: number, patch: Partial<TaskView> = {}) => todo({ widget: { type: 'timer', label: 'Stretch', at: new Date(at).toISOString() }, dueAt: at, ...patch });

test('Needs you: what rang, the block in progress, overdue, and what an agent or the host asks', () => {
  const rang = timer(NOW - 5 * M, { status: 'needs_you' });
  const running = todo({ title: 'Kitchen' });
  const overdue = todo({ dueAt: NOW - H });
  const asked = todo({ createdBy: 'ag_mara', widget: { type: 'choice', options: ['A', 'B'] } });
  const slots = [block(running.id, NOW - 10 * M, 30)];
  for (const task of [rang, running, overdue, asked]) assert.equal(groupOf(task, input(slots)), 'needsYou', task.title);
  const agentApprove = todo({ createdBy: 'ag_mara', widget: { type: 'approve', action: 'Use the logo' } });
  assert.equal(groupOf(agentApprove, input()), 'needsYou', 'an agent-written approve is an ordinary question – it needs the person');
});

test('Today: the day\'s planned blocks and timers within 12 h, by time; Unplanned: the person\'s own without a block', () => {
  const taxes = todo({ title: 'Taxes' });
  const laundry = todo({ title: 'Laundry' });
  const stretch = timer(NOW + 30 * M, { title: 'Stretch' });
  const book = todo({ title: 'Book', estimateMin: 60 });
  const doneBlock = todo({ title: 'Was planned' });
  const slots = [block(taxes.id, NOW + 2 * H), block(laundry.id, NOW + H), block(doneBlock.id, NOW - 3 * H, 30, { state: 'done' })];
  const groups = dayGroups([taxes, book, stretch, laundry, doneBlock], input(slots));
  assert.deepEqual(groups.today.map((task) => task.title), ['Stretch', 'Laundry', 'Taxes']);
  assert.deepEqual(groups.unplanned.map((task) => task.title), ['Was planned', 'Book'], 'a done or cut block no longer places it (the calm order: older first)');
  assert.deepEqual(groups.needsYou, []);
});

test('Later: snoozed, repeating, far timers, due on a later day, planned on a later day – never one that rang', () => {
  const snoozed = todo({ status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW } });
  const repeats = timer(NOW + 20 * H, { status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Repeats', since: NOW } });
  const far = timer(NOW + 13 * H);
  const tomorrow = todo({ dueAt: DAY_END + 9 * H });
  const plannedLater = todo();
  const rangTomorrow = todo({ dueAt: DAY_END + H, status: 'needs_you' });
  const groups = dayGroups([snoozed, repeats, far, tomorrow, plannedLater, rangTomorrow], input([block(plannedLater.id, DAY_END + 9 * H)]));
  assert.deepEqual(new Set(groups.later.map((task) => task.id)), new Set([snoozed.id, repeats.id, far.id, tomorrow.id, plannedLater.id]));
  assert.deepEqual(groups.needsYou.map((task) => task.id), [rangTomorrow.id]);
  assert.equal(groupOf(todo({ dueAt: DAY_END + H }), input([], { dayEnd: DAY_END + 2 * H })), 'unplanned', 'the end of today is the caller\'s (profile zone)');
});

test('one "Needs you" rule: the badge (countNow) counts exactly the Needs-you group, the running block aside', () => {
  const asked = todo({ createdBy: 'ag_mara', title: 'Which tax year?' });
  const colleague = todo({ createdBy: 'per_anna', title: 'Sign the form' });
  const askedTomorrow = todo({ createdBy: 'ag_mara', dueAt: DAY_END + H });
  const overdue = todo({ dueAt: NOW - H });
  const own = [todo({ title: 'Laundry' }), todo({ title: 'Kitchen' }), todo({ title: 'Book' }), timer(NOW + H)];
  const plannedLater = todo({ title: 'Taxes' });
  const list = [asked, colleague, askedTomorrow, overdue, plannedLater, ...own];
  const slots = [block(plannedLater.id, NOW + 2 * H)];
  const groups = dayGroups(list, input(slots));
  assert.deepEqual(new Set(groups.needsYou.map((task) => task.id)), new Set([asked.id, colleague.id, overdue.id]));
  assert.equal(countNow(list, NOW, DAY_END), groups.needsYou.length, 'the badge and the group agree');
  assert.equal(needsYou(own[0], NOW, DAY_END), false, "the person's own unplanned to-do does not need them");
  assert.equal(needsYou(askedTomorrow, NOW, DAY_END), false, 'never a Later one');
  const running = todo({ title: 'Running' });
  const withRunning = dayGroups([...list, running], input([...slots, block(running.id, NOW - 10 * M)]));
  assert.equal(withRunning.needsYou.length - 1, countNow([...list, running], NOW, DAY_END), 'My day adds the block in progress');
  assert.equal(countNow([...list, running], NOW, DAY_END, new Set([running.id])), withRunning.needsYou.length, 'the briefing passes the running block');
});

test('another day lists only its blocks, by start', () => {
  const a = todo({ title: 'A' });
  const b = todo({ title: 'B' });
  const c = todo({ title: 'C', createdBy: 'ag_mara' });
  const tomorrow = { dayStart: DAY_END, dayEnd: DAY_END + 24 * H, isToday: false };
  const groups = dayGroups([a, b, c], input([block(b.id, DAY_END + 9 * H), block(a.id, DAY_END + 14 * H), block(c.id, NOW)], tomorrow));
  assert.deepEqual(groups.today.map((task) => task.title), ['B', 'A']);
  assert.deepEqual([...groups.needsYou, ...groups.unplanned, ...groups.later], []);
});

test('handed off: the person\'s own step first ("Prepared – your step"), then who works on it, done last', () => {
  const taxes = todo({ title: 'Do the taxes', assigneeKind: 'agent', assigneeId: 'ag_mara', status: 'working', updatedAt: NOW - H });
  const site = todo({ title: 'Improve the website', assigneeKind: 'agent', assigneeId: 'ag_tom', status: 'open', updatedAt: NOW - 2 * H });
  const done = todo({ title: 'Book a table', assigneeKind: 'agent', assigneeId: 'ag_mara', status: 'done', updatedAt: NOW });
  const stuck = todo({ title: 'Renew the domain', assigneeKind: 'agent', assigneeId: 'ag_tom', status: 'blocked', updatedAt: NOW - 3 * H });
  const unowned = todo({ title: 'Plan the trip', assigneeKind: 'team', status: 'open', updatedAt: NOW - 4 * H });
  const step = todo({ title: 'Bring the form to the office', parentId: site.id, createdBy: 'ag_tom' });
  const names: Record<string, string> = { ag_mara: 'Mara', ag_tom: 'Tom' };
  const rows = handedOffRows([taxes, site, done, stuck, unowned], [step], (task) => (task.assigneeId ? names[task.assigneeId] : undefined), NOW);
  assert.deepEqual(rows.map((row) => [row.task.title, row.text]), [
    ['Improve the website', 'Prepared – your step: Bring the form to the office'],
    ['Renew the domain', 'Stuck'],
    ['Do the taxes', 'Mara working'],
    ['Plan the trip', 'Not assigned yet'],
    ['Book a table', 'Done ✓'],
  ]);
  assert.equal(rows[0].step?.id, step.id);
  assert.equal(rows[4].done, true);
  const wait = (since: number) => todo({ title: 'Print the flyers', assigneeKind: 'agent', assigneeId: 'ag_tom', status: 'waiting', waitingOn: { kind: 'external', reason: 'Printer', since } });
  assert.deepEqual(handedOffRows([wait(NOW - 3 * 24 * H)], [], () => 'Tom', NOW).map((row) => row.text), ['Stuck'], "Work's Stuck rule: a wait over two days");
  assert.deepEqual(handedOffRows([wait(NOW - H)], [], () => 'Tom', NOW).map((row) => row.text), ['Tom waiting']);
});

test('a to-do for another day (window.date – typed while that day was shown): Unplanned on that day, Later today', () => {
  const tomorrow = '2026-10-25';
  const laundry = todo({ title: 'Laundry', window: { date: tomorrow } });
  const kitchen = todo({ title: 'Kitchen' });
  const planned = todo({ title: 'Planned', window: { date: tomorrow } });
  const slots = [block(planned.id, DAY_END + 9 * H)];
  const there = dayGroups([laundry, kitchen, planned], input(slots, { dayStart: DAY_END, dayEnd: DAY_END + 24 * H, isToday: false, date: tomorrow }));
  assert.deepEqual(there.unplanned.map((task) => task.title), ['Laundry']);
  assert.deepEqual(there.today.map((task) => task.title), ['Planned']);
  const here = dayGroups([laundry, kitchen], input([], { date: '2026-10-24' }));
  assert.deepEqual([here.unplanned.map((task) => task.title), here.later.map((task) => task.title)], [['Kitchen'], ['Laundry']]);
});
