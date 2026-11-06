// B-041 track A2: the pure day planner (runtime/calendar/planner.ts planDay) on a fixed clock – Robin's evening
// list against a calendar with a 10:00 meeting, a DST day (and the spring one), a too-long item, the
// "Polizeistation 08:00–12:00" window and every other window reason, the order rule, plan vs. replan, the morning
// move of yesterday's unticked planner blocks, items written after work going to the next day, weekdays, the
// buffer and the 5-minute grid, released blocks, and the working day being over.
// Owns: checks of planDay / durationText / firstDayOf only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationText, firstDayOf, planDay, type PlanBlock, type PlanInput, type PlanTodo } from '../../../src/runtime/calendar/planner.ts';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';

const B = 'Europe/Berlin';
const MIN = 60_000;
const wall = (date: string, clock: string) => zonedTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), B);
const TUE = '2026-10-27';
const MONDAY_EVENING = wall('2026-10-26', '22:30');
const TUESDAY_6 = wall(TUE, '06:00');
const meeting = { startAt: wall(TUE, '10:00'), endAt: wall(TUE, '11:00') };
const todo = (taskId: string, estimateMin: number, extra: Partial<PlanTodo> = {}): PlanTodo => ({ taskId, estimateMin, priority: 0, createdAt: MONDAY_EVENING, ...extra });
const input = (extra: Partial<PlanInput>): PlanInput => ({
  date: TUE, tz: B, now: TUESDAY_6, mode: 'plan', workStart: '08:00', workEnd: '20:00', bufferMin: 10, busy: [], blocks: [], todos: [], ...extra,
});
/** Placements as local "HH:MM–HH:MM" per task. */
const times = (out: ReturnType<typeof planDay>) => Object.fromEntries(out.placements.map((p) => {
  const clock = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: B, hour: '2-digit', minute: '2-digit' }).format(ms);
  return [p.taskId, `${clock(p.startAt)}–${clock(p.endAt)}`];
}));
/** Wäsche waschen, Küche aufräumen, Steuern erledigen, Webseite verbessern, am Buch arbeiten – in the order dictated. */
const ROBIN = [todo('wash', 30), todo('kitchen', 30), todo('taxes', 120), todo('website', 60), todo('book', 60)].map((item, index) => ({ ...item, createdAt: MONDAY_EVENING + index }));

test("Robin's evening list: nothing on the evening it was said; the next morning around the 10:00 meeting", () => {
  const evening = planDay(input({ date: '2026-10-26', now: MONDAY_EVENING, todos: ROBIN }));
  assert.deepEqual(evening, { placements: [], released: [], unplanned: [] }, 'written after work: tomorrow\'s, not tonight\'s');
  const out = planDay(input({ busy: [meeting], todos: ROBIN }));
  assert.deepEqual(times(out), {
    wash: '08:00–08:30', kitchen: '08:40–09:10', website: '11:10–12:10', book: '12:20–13:20', taxes: '13:30–15:30',
  });
  assert.deepEqual(out.unplanned, []);
  assert.ok(out.placements.every((p) => !p.moved));
});

test('a DST day: the working hours are wall time on the day summer time ends and on the day it starts', () => {
  const autumn = planDay(input({ date: '2026-10-25', now: wall('2026-10-25', '06:00'), todos: [todo('wash', 30, { createdAt: wall('2026-10-24', '21:00') })] }));
  assert.deepEqual(autumn.placements, [{ taskId: 'wash', startAt: Date.parse('2026-10-25T07:00:00Z'), endAt: Date.parse('2026-10-25T07:30:00Z'), moved: false }]);
  const spring = planDay(input({ date: '2026-03-29', now: wall('2026-03-29', '06:00'), workEnd: '08:30', todos: [todo('a', 20, { createdAt: 0 }), todo('b', 20, { createdAt: 1 })] }));
  assert.deepEqual(spring.placements.map((p) => new Date(p.startAt).toISOString()), ['2026-03-29T06:00:00.000Z']);
  assert.deepEqual(spring.unplanned, [{ taskId: 'b', reason: 'No free time left today' }], '08:00–08:30 CEST holds one 20-min block and its buffer');
});

test('too long: unplanned with how long it needs and the longest free time', () => {
  const out = planDay(input({ busy: [meeting], todos: [todo('taxes', 600)] }));
  assert.deepEqual(out.unplanned, [{ taskId: 'taxes', reason: 'Needs 10 h; the longest free time is 8 h 50 min' }]);
  assert.deepEqual(out.placements, []);
});

test('the "Polizeistation 08:00–12:00" window: placed inside its hours, before plain to-dos; every window reason', () => {
  const police = todo('police', 60, { window: { notBefore: '08:00', notAfter: '12:00' } });
  const out = planDay(input({ busy: [meeting], todos: [todo('wash', 30), police, todo('book', 90)] }));
  assert.deepEqual(times(out), { police: '08:00–09:00', wash: '09:10–09:40', book: '11:10–12:40' });
  const narrow = planDay(input({ todos: [todo('police', 90, { window: { notBefore: '08:00', notAfter: '09:00' } })] }));
  assert.deepEqual(narrow.unplanned, [{ taskId: 'police', reason: 'Needs 1 h 30 min; it can only be done 08:00–09:00' }]);
  const late = planDay(input({ now: wall(TUE, '13:00'), todos: [police] }));
  assert.deepEqual(late.unplanned, [{ taskId: 'police', reason: 'Its time today (08:00–12:00) has passed' }]);
  const night = planDay(input({ todos: [todo('stars', 30, { window: { notBefore: '21:00' } })] }));
  assert.deepEqual(night.unplanned, [{ taskId: 'stars', reason: 'Its hours (after 21:00) are outside your working hours' }]);
  const blocked = planDay(input({ busy: [meeting], todos: [todo('call', 30, { window: { notBefore: '10:00', notAfter: '11:00' } })] }));
  assert.deepEqual(blocked.unplanned, [{ taskId: 'call', reason: 'No free time between 10:00 and 11:00' }]);
});

test('order: due that day (or overdue) → priority → due → has hours → shorter → older', () => {
  const one = (todos: PlanTodo[]) => planDay(input({ workEnd: '09:00', todos })).placements.map((p) => p.taskId);
  assert.deepEqual(one([todo('normal', 60, { createdAt: 1 }), todo('urgent', 60, { priority: 2, createdAt: 2 })]), ['urgent']);
  assert.deepEqual(one([todo('urgent', 60, { priority: 2 }), todo('dueToday', 60, { dueAt: wall(TUE, '18:00') })]), ['dueToday']);
  assert.deepEqual(one([todo('overdue', 60, { dueAt: wall('2026-10-20', '12:00') }), todo('later', 60, { priority: 1, dueAt: wall('2026-11-02', '12:00') })]), ['overdue']);
  assert.deepEqual(one([todo('nextMonth', 60, { dueAt: wall('2026-11-20', '12:00') }), todo('nextWeek', 60, { dueAt: wall('2026-11-03', '12:00') })]), ['nextWeek']);
  assert.deepEqual(one([todo('plain', 60, { createdAt: 1 }), todo('hours', 60, { createdAt: 2, window: { notAfter: '18:00' } })]), ['hours']);
  assert.deepEqual(one([todo('older', 60, { createdAt: 1 }), todo('newer', 60, { createdAt: 2 })]), ['older']);
  assert.deepEqual(planDay(input({ workEnd: '09:00', todos: [todo('long', 50), todo('short', 20)] })).placements.map((p) => p.taskId), ['short'], 'shorter first; the long one no longer fits');
});

test("plan keeps the day's blocks; replan moves only the planner's blocks not started yet; person and agent blocks never move", () => {
  const block = (taskId: string, from: string, to: string, setBy: PlanBlock['setBy']): PlanBlock => ({ taskId, startAt: wall(TUE, from), endAt: wall(TUE, to), setBy, state: 'planned' });
  const blocks = [block('started', '09:00', '10:00', 'planner'), block('later', '15:00', '16:00', 'planner'), block('pinned', '11:00', '12:00', 'person'), block('agent', '12:30', '13:00', 'agent')];
  const todos = [todo('started', 60), todo('later', 60), todo('pinned', 60), todo('agent', 30), todo('fresh', 30)];
  const now = wall(TUE, '09:30');
  const kept = planDay(input({ now, blocks, todos }));
  assert.deepEqual(times(kept), { fresh: '10:10–10:40' }, 'plan: only the new one, after now and around every block');
  const re = planDay(input({ now, mode: 'replan', blocks, todos }));
  assert.deepEqual(times(re), { fresh: '10:10–10:40', later: '13:10–14:10' });
  assert.deepEqual(re.placements.find((p) => p.taskId === 'later')?.moved, true);
});

test("a busy list that also names the planner's own blocks (calendar.busy of every timed row) still lets replan reuse a block's time", () => {
  const block: PlanBlock = { taskId: 'later', startAt: wall(TUE, '15:00'), endAt: wall(TUE, '16:00'), setBy: 'planner', state: 'planned' };
  const busy = [{ startAt: wall(TUE, '09:30'), endAt: wall(TUE, '15:00') }, { startAt: wall(TUE, '15:00'), endAt: wall(TUE, '16:00') }, { startAt: wall(TUE, '16:00'), endAt: wall(TUE, '20:00') }];
  const out = planDay(input({ now: wall(TUE, '09:30'), mode: 'replan', bufferMin: 0, busy, blocks: [block], todos: [todo('later', 60)] }));
  assert.deepEqual(out.placements, [{ taskId: 'later', startAt: wall(TUE, '15:00'), endAt: wall(TUE, '16:00'), moved: true }]);
});

test("the morning moves yesterday's unticked blocks, the person's too (an ended block holds no time); a later day's block stays", () => {
  const yesterday = (taskId: string, setBy: PlanBlock['setBy']): PlanBlock => ({ taskId, startAt: wall('2026-10-26', '14:00'), endAt: wall('2026-10-26', '15:00'), setBy, state: 'planned' });
  const tomorrow: PlanBlock = { taskId: 'friday', startAt: wall('2026-10-30', '09:00'), endAt: wall('2026-10-30', '10:00'), setBy: 'planner', state: 'planned' };
  const out = planDay(input({ blocks: [yesterday('missed', 'planner'), yesterday('mine', 'person'), tomorrow], todos: [todo('missed', 60), todo('mine', 60), todo('friday', 60)] }));
  assert.deepEqual(out.placements, [
    { taskId: 'missed', startAt: wall(TUE, '08:00'), endAt: wall(TUE, '09:00'), moved: true },
    { taskId: 'mine', startAt: wall(TUE, '09:10'), endAt: wall(TUE, '10:10'), moved: true },
  ]);
  assert.deepEqual(out.unplanned, []);
  const agents = planDay(input({ blocks: [yesterday('asked', 'agent')], busy: [{ startAt: wall(TUE, '06:00'), endAt: wall(TUE, '20:00') }], todos: [todo('asked', 60)] }));
  assert.deepEqual([agents.released, agents.unplanned], [['asked'], [{ taskId: 'asked', reason: 'No free time left today' }]], 'no room: released and reported, never silently dropped');
});

test('a cut or done block of a to-do that is open again holds no time: the plan places the to-do again', () => {
  const cut: PlanBlock = { taskId: 'kitchen', startAt: wall(TUE, '08:00'), endAt: wall(TUE, '08:15'), setBy: 'planner', state: 'cut' };
  const done: PlanBlock = { taskId: 'wash', startAt: wall(TUE, '08:30'), endAt: wall(TUE, '09:00'), setBy: 'person', state: 'done' };
  const out = planDay(input({ now: wall(TUE, '09:30'), blocks: [cut, done], todos: [todo('kitchen', 30, { createdAt: 1 }), todo('wash', 30, { createdAt: 2 })] }));
  assert.deepEqual(times(out), { kitchen: '09:30–10:00', wash: '10:10–10:40' });
  assert.ok(out.placements.every((p) => p.moved));
  const tomorrow = planDay(input({ date: '2026-10-28', now: wall(TUE, '09:30'), blocks: [cut], todos: [todo('kitchen', 30, { createdAt: 1 })] }));
  assert.deepEqual(times(tomorrow), { kitchen: '08:00–08:30' }, 'also when the next morning is planned');
});

test('the day of a to-do: written after work → the next day; a named day or weekday keeps it to that day', () => {
  assert.equal(firstDayOf(wall('2026-10-26', '19:59'), B, 20 * 60), '2026-10-26');
  assert.equal(firstDayOf(wall('2026-10-26', '20:00'), B, 20 * 60), TUE);
  assert.equal(firstDayOf(wall(TUE, '00:40'), B, 20 * 60), TUE, 'just after midnight: the day that just began');
  const today = planDay(input({ now: wall(TUE, '07:00'), todos: [
    todo('thisMorning', 30, { createdAt: wall(TUE, '06:30') }), todo('wednesday', 30, { window: { date: '2026-10-28' } }),
    todo('mondayLeftover', 30, { window: { date: '2026-10-26' } }), todo('weekend', 30, { window: { days: [0, 6] } }), todo('tuesdays', 30, { window: { days: [2] } }),
  ] }));
  assert.deepEqual(Object.keys(times(today)).sort(), ['mondayLeftover', 'thisMorning', 'tuesdays']);
});

test('buffer and grid: blocks keep the buffer to events and to each other and start on 5-minute marks after now', () => {
  const out = planDay(input({ now: wall(TUE, '08:03'), bufferMin: 15, busy: [{ startAt: wall(TUE, '09:00'), endAt: wall(TUE, '09:20') }], todos: [todo('a', 25, { createdAt: 1 }), todo('b', 25, { createdAt: 2 })] }));
  assert.deepEqual(times(out), { a: '08:05–08:30', b: '09:35–10:00' });
  const none = planDay(input({ bufferMin: 0, workEnd: '09:00', todos: [todo('a', 30, { createdAt: 1 }), todo('b', 30, { createdAt: 2 })] }));
  assert.deepEqual(times(none), { a: '08:00–08:30', b: '08:30–09:00' }, 'no buffer: back to back');
  const other: PlanBlock = { taskId: 'someone-elses', startAt: wall(TUE, '08:00'), endAt: wall(TUE, '09:00'), setBy: 'agent', state: 'planned' };
  assert.deepEqual(times(planDay(input({ blocks: [other], todos: [todo('a', 30)] }))), { a: '09:10–09:40' }, 'other tasks\' blocks are busy too');
});

test('a movable block without a new place is released; a working day that is over says so', () => {
  const block: PlanBlock = { taskId: 'later', startAt: wall(TUE, '15:00'), endAt: wall(TUE, '16:00'), setBy: 'planner', state: 'planned' };
  const out = planDay(input({ now: wall(TUE, '14:00'), mode: 'replan', busy: [{ startAt: wall(TUE, '14:00'), endAt: wall(TUE, '20:00') }], blocks: [block], todos: [todo('later', 60)] }));
  assert.deepEqual(out.released, ['later']);
  assert.deepEqual(out.unplanned, [{ taskId: 'later', reason: 'No free time left today' }]);
  const over = planDay(input({ now: wall(TUE, '20:30'), todos: [todo('a', 30, { createdAt: wall(TUE, '09:00') })] }));
  assert.deepEqual(over.unplanned, [{ taskId: 'a', reason: 'Your working hours are over for today' }]);
  const past = planDay(input({ date: '2026-10-26', todos: [todo('a', 30, { createdAt: 0 })] }));
  assert.deepEqual(past.unplanned, [{ taskId: 'a', reason: 'This day is over' }]);
});

test('durationText reads minutes and hours', () => {
  assert.equal(durationText(45), '45 min');
  assert.equal(durationText(120), '2 h');
  assert.equal(durationText(90), '1 h 30 min');
});
