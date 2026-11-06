// The calendar's geometry (src/ui/day/day-grid.ts): local minutes in the profile zone (also on a
// DST day), blocks cut at the day's edges, the 5-minute snap of a drag, a click's 30 minutes from
// the quarter hour, a moved block keeping its length, "Move to…", working hours, overlapping
// blocks in lanes, the week and the mini month, days with blocks.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atWallTime } from '../../../src/ui/chat/composer/schedule-clock.ts';
import {
  CLICK_MIN, DAY_MINUTES, atMinute, clickSpan, clockOf, datesWithBlocks, lanes, localMinute, monthGrid, movedBy, movedTo, selection,
  snapMinute, spanOn, weekOf, workSpan, dayBounds, spanIn, HOUR_PX, LABEL_ROOM, labelSafeTop,
} from '../../../src/ui/day/day-grid.ts';

const TZ = 'Europe/Vienna';
const M = 60_000;
const at = (date: string, hour: number, minute = 0) => atWallTime(date, hour, minute, TZ);

test('local minutes and back, also across the DST change (25 October 2026, 03:00 → 02:00)', () => {
  assert.equal(localMinute(at('2026-10-24', 9, 30), TZ), 570);
  assert.equal(atMinute('2026-10-24', 570, TZ), at('2026-10-24', 9, 30));
  assert.equal(atMinute('2026-10-24', DAY_MINUTES, TZ), at('2026-10-25', 0, 0), '1440 = the next midnight');
  assert.equal(localMinute(at('2026-10-25', 12, 0), TZ), 720, 'noon on the 25-hour day');
  assert.equal(clockOf(at('2026-10-24', 7, 5), TZ), '07:05');
  assert.equal(clockOf(at('2026-10-24', 7, 5), 'UTC'), '05:05', 'another zone');
});

test('a block on a day: its minutes, cut at the day\'s edges, nothing for another day', () => {
  assert.deepEqual(spanOn({ startAt: at('2026-10-24', 9), endAt: at('2026-10-24', 10, 30) }, '2026-10-24', TZ), { start: 540, end: 630 });
  assert.deepEqual(spanOn({ startAt: at('2026-10-23', 23), endAt: at('2026-10-24', 1) }, '2026-10-24', TZ), { start: 0, end: 60 }, 'from the day before');
  assert.deepEqual(spanOn({ startAt: at('2026-10-24', 23), endAt: at('2026-10-25', 1) }, '2026-10-24', TZ), { start: 1380, end: DAY_MINUTES }, 'into the next day');
  assert.equal(spanOn({ startAt: at('2026-10-25', 9), endAt: at('2026-10-25', 10) }, '2026-10-24', TZ), undefined);
  assert.equal(spanOn({ startAt: at('2026-10-23', 9), endAt: at('2026-10-24', 0) }, '2026-10-24', TZ), undefined, 'ends at midnight: not on it');
});

test('selections: 5-minute snap, at least 15 minutes, inside the day; a click takes 30 minutes from the quarter hour', () => {
  assert.equal(snapMinute(542), 540);
  assert.equal(snapMinute(543), 545);
  assert.deepEqual(selection(600, 542), { start: 540, end: 600 }, 'dragged upwards');
  assert.deepEqual(selection(600, 603), { start: 600, end: 615 }, 'at least 15 minutes');
  assert.deepEqual(selection(1435, 1440), { start: 1425, end: 1440 }, 'kept inside the day');
  assert.deepEqual(clickSpan(557), { start: 555, end: 585 });
  assert.deepEqual(clickSpan(1439), { start: DAY_MINUTES - CLICK_MIN, end: DAY_MINUTES });
});

test('moving: by minutes (snapped, the length kept) and "Move to…" a typed time', () => {
  const event = { startAt: at('2026-10-24', 9, 0), endAt: at('2026-10-24', 9, 45) };
  assert.deepEqual(movedBy(event, 62, TZ, '2026-10-24'), { startAt: at('2026-10-24', 10, 0), endAt: at('2026-10-24', 10, 45) });
  assert.deepEqual(movedBy(event, -600, TZ, '2026-10-24'), { startAt: at('2026-10-24', 0, 0), endAt: at('2026-10-24', 0, 45) }, 'not before the day');
  assert.deepEqual(movedTo(event, '2026-10-24', '14:30', TZ), { startAt: at('2026-10-24', 14, 30), endAt: at('2026-10-24', 15, 15) });
  assert.equal(movedTo(event, '2026-10-24', '25:00', TZ), undefined);
});

test('working hours: settings.day, the defaults where a value cannot be read or ends before it starts', () => {
  assert.deepEqual(workSpan({ workStart: '07:30', workEnd: '18:00' }), { start: 450, end: 1080 });
  assert.deepEqual(workSpan({ workStart: 'x', workEnd: '18:00' }), { start: 480, end: 1080 });
  assert.deepEqual(workSpan({ workStart: '19:00', workEnd: '08:00' }), { start: 480, end: 1200 });
});

test('lanes: overlapping blocks share the width; a block after them starts a new cluster', () => {
  const laid = lanes([
    { item: 'a', span: { start: 540, end: 600 } },
    { item: 'b', span: { start: 570, end: 630 } },
    { item: 'c', span: { start: 600, end: 660 } },
    { item: 'd', span: { start: 700, end: 730 } },
    { item: 'e', span: { start: 702, end: 703 } }, // short: still overlaps what follows within 15 minutes
  ]);
  const by = Object.fromEntries(laid.map((entry) => [entry.item, [entry.lane, entry.lanes]]));
  assert.deepEqual(by, { a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 2], e: [1, 2] });
  assert.deepEqual(lanes([{ item: 'x', span: { start: 0, end: 30 } }]).map((entry) => entry.lanes), [1]);
});

test('the week (Monday first) and the mini month (six weeks from the Monday before the 1st)', () => {
  assert.deepEqual(weekOf('2026-10-24'), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.equal(weekOf('2026-10-19')[0], '2026-10-19', 'a Monday is its own week\'s start');
  assert.equal(weekOf('2026-10-25')[0], '2026-10-19', 'a Sunday belongs to the week before it');
  const month = monthGrid('2026-10-24');
  assert.equal(month.length, 42);
  assert.equal(month[0], '2026-09-28', '1 October 2026 is a Thursday');
  assert.equal(month[41], '2026-11-08');
  assert.equal(monthGrid('2026-06-15')[0], '2026-06-01', '1 June 2026 is a Monday');
});

test('days with blocks: each day a block touches, not the day it ends at midnight', () => {
  const days = datesWithBlocks([
    { startAt: at('2026-10-24', 9), endAt: at('2026-10-24', 10) },
    { startAt: at('2026-10-26', 22), endAt: at('2026-10-28', 0) },
  ], TZ);
  assert.deepEqual([...days].sort(), ['2026-10-24', '2026-10-26', '2026-10-27']);
  assert.equal(datesWithBlocks([{ startAt: at('2026-10-24', 9), endAt: at('2026-10-24', 9) + M }], 'UTC').has('2026-10-24'), true);
});

test('the day bounds once, the span of each event against them: the same as spanOn (the DST day too)', () => {
  for (const date of ['2026-10-24', '2026-10-25', '2026-03-29']) {
    const bounds = dayBounds(date, TZ);
    for (const event of [
      { startAt: at(date, 9), endAt: at(date, 10, 30) }, { startAt: bounds.start - 3_600_000, endAt: bounds.start + 3_600_000 },
      { startAt: bounds.end - 3_600_000, endAt: bounds.end + 3_600_000 }, { startAt: bounds.end, endAt: bounds.end + 60_000 },
    ]) assert.deepEqual(spanIn(event, bounds, TZ), spanOn(event, date, TZ), `${date} ${event.startAt}`);
  }
});

test('the first scroll position never cuts an hour label at the top edge', () => {
  assert.equal(labelSafeTop(9 * HOUR_PX - LABEL_ROOM), 9 * HOUR_PX - LABEL_ROOM, 'the usual place: the line just below the edge, its label whole');
  assert.equal(labelSafeTop(430), 9 * HOUR_PX - LABEL_ROOM, 'clamped at the end of the day 2 px above the 09:00 line: up to show its label');
  assert.equal(labelSafeTop(9 * HOUR_PX + 3), 9 * HOUR_PX - LABEL_ROOM, 'just past a line: up as well');
  assert.equal(labelSafeTop(9 * HOUR_PX + 20), 9 * HOUR_PX + 20, 'between two labels: unchanged');
  assert.equal(labelSafeTop(3), 0, 'never above the grid');
});
