// My day's short texts (src/ui/day/day-format.ts): "09:30 · 30 min", lengths, date shifts and titles and dictated
// words after typed text.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockMinutes, dateText, dayTitle, joinSaid, minutesText, monthText, rowTime, shiftDate, weekdayOf } from '../../../src/ui/day/day-format.ts';

test('lengths and a row\'s time', () => {
  assert.equal(minutesText(30), '30 min');
  assert.equal(minutesText(60), '1 h');
  assert.equal(minutesText(95), '1 h 35 min');
  assert.equal(minutesText(-4), '0 min');
  assert.equal(rowTime('09:30', 30), '09:30 · 30 min');
  assert.equal(rowTime(undefined, 45), '45 min');
  assert.equal(rowTime('09:30', undefined), '09:30');
  assert.equal(rowTime(undefined, 0), '');
  assert.equal(blockMinutes({ startAt: 0, endAt: 25 * 60_000 }), 25);
});

test('dates: shifts across months and years, weekday, titles relative to today', () => {
  assert.equal(shiftDate('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-10-24', 0), '2026-10-24');
  assert.equal(weekdayOf('2026-10-24'), 6, 'a Saturday');
  assert.equal(dateText('2026-10-25'), 'Sun 25 Oct');
  assert.equal(monthText('2026-10-24'), 'October 2026');
  assert.equal(dayTitle('2026-10-24', '2026-10-24'), 'Today');
  assert.equal(dayTitle('2026-10-25', '2026-10-24'), 'Tomorrow');
  assert.equal(dayTitle('2026-10-23', '2026-10-24'), 'Yesterday');
  assert.equal(dayTitle('2026-10-28', '2026-10-24'), 'Wed 28 Oct');
});

test('dictated words join the typed text with one space', () => {
  assert.equal(joinSaid('Buy milk', 'and bread'), 'Buy milk and bread');
  assert.equal(joinSaid('Buy milk  ', '  and bread '), 'Buy milk and bread');
  assert.equal(joinSaid('', 'Call Anna'), 'Call Anna');
  assert.equal(joinSaid('Call Anna', ''), 'Call Anna');
  assert.equal(joinSaid('', ''), '');
});
