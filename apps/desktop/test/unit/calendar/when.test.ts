// My day's zone helpers (runtime/calendar/when.ts): the zone math across a DST change (Europe/Berlin leaves summer
// time on 2026-10-25), a skipped wall time, adding days and the weekday of a date.
// Owns: checks of zonedTime / localDate / addDays / weekdayOf only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, localDate, weekdayOf, zonedTime } from '../../../src/runtime/calendar/when.ts';

const BERLIN = 'Europe/Berlin';
const at = (iso: string) => Date.parse(iso);

test('zonedTime and localDate follow the zone across the end of summer time', () => {
  assert.equal(zonedTime('2026-10-24', 9 * 60, BERLIN), at('2026-10-24T07:00:00Z'), 'CEST: UTC+2');
  assert.equal(zonedTime('2026-10-25', 9 * 60, BERLIN), at('2026-10-25T08:00:00Z'), 'CET: UTC+1 the day it changes');
  assert.equal(zonedTime('2026-10-24', 9 * 60, 'America/New_York'), at('2026-10-24T13:00:00Z'));
  assert.equal(zonedTime('2026-03-29', 150, BERLIN), at('2026-03-29T01:30:00Z'), 'a skipped wall time moves on by the gap');
  assert.equal(localDate(at('2026-10-24T22:30:00Z'), BERLIN), '2026-10-25');
  assert.equal(localDate(at('2026-10-24T22:30:00Z'), 'America/New_York'), '2026-10-24');
});

test('addDays crosses months and years; weekdayOf names Sunday 0', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-11-01'), 0);
  assert.equal(weekdayOf('2026-10-31'), 6);
});
