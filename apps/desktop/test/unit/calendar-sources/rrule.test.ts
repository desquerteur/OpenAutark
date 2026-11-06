// B-041 track G: the recurrence subset of connected calendars – DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT,
// UNTIL, BYDAY (also with ordinals), BYMONTHDAY, BYMONTH and WKST; DTSTART is the first occurrence; dates that do
// not exist are skipped; a rule outside the subset is refused (the caller keeps the first occurrence).
// Owns: checks of runtime/calendar/sources/rrule.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIcs } from '../../../src/runtime/calendar/sources/ics.ts';
import { parseIcsTime, wallToUtc } from '../../../src/runtime/calendar/sources/ics-time.ts';
import { expandDates, parseRRule } from '../../../src/runtime/calendar/sources/rrule.ts';
import { VIENNA, vienna } from './ics-fixtures.ts';

/** The local dates of `rule` from DTSTART `start` (Vienna, 10:00) up to `last`. */
function dates(rule: string, start: string, last: string, first = start): string[] {
  const time = parseIcsTime(`${start.replace(/-/g, '')}T100000`, { TZID: VIENNA }, VIENNA)!;
  const parsed = parseRRule(rule, time);
  assert.ok(parsed, `rule ${rule} parses`);
  return expandDates(parsed, time, { firstDate: first, lastDate: last }, (date) => wallToUtc(date, 36_000, VIENNA));
}

test('DAILY with INTERVAL and COUNT (DTSTART is the first of them)', () => {
  assert.deepEqual(dates('FREQ=DAILY;INTERVAL=2;COUNT=4', '2026-10-24', '2026-12-31'), ['2026-10-24', '2026-10-26', '2026-10-28', '2026-10-30']);
  assert.deepEqual(dates('FREQ=DAILY;BYDAY=MO,FR', '2026-10-23', '2026-11-03'), ['2026-10-23', '2026-10-26', '2026-10-30', '2026-11-02'], 'BYDAY limits a daily rule');
});

test('WEEKLY every second week on Tuesday and Thursday; WKST decides which weeks count', () => {
  assert.deepEqual(dates('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', '2026-10-20', '2026-11-20'), ['2026-10-20', '2026-10-22', '2026-11-03', '2026-11-05', '2026-11-17', '2026-11-19']);
  // RFC 5545's WKST example: starting Tue 5 Aug 1997, every other week on Tue and Sun
  assert.deepEqual(dates('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', '1997-08-05', '1997-12-31'), ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
  assert.deepEqual(dates('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', '1997-08-05', '1997-12-31'), ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
});

test('MONTHLY on the 31st skips short months; BYMONTHDAY=-1 is the last day; BYDAY=2TU and -1FR', () => {
  assert.deepEqual(dates('FREQ=MONTHLY;COUNT=4', '2026-08-31', '2027-12-31'), ['2026-08-31', '2026-10-31', '2026-12-31', '2027-01-31']);
  assert.deepEqual(dates('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', '2027-01-31', '2027-12-31'), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.deepEqual(dates('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '2026-10-13', '2027-12-31'), ['2026-10-13', '2026-11-10', '2026-12-08']);
  assert.deepEqual(dates('FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR', '2026-01-30', '2026-12-31'), ['2026-01-30', '2026-04-24', '2026-07-31', '2026-10-30']);
  assert.deepEqual(dates('FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', '2026-02-13', '2027-12-31'), ['2026-02-13', '2026-03-13', '2026-11-13', '2027-08-13'], 'Friday the 13th: both limit');
});

test('YEARLY: a birthday on 29 Feb only in leap years; BYMONTH with an ordinal weekday; UNTIL is inclusive', () => {
  assert.deepEqual(dates('FREQ=YEARLY;COUNT=3', '2024-02-29', '2040-12-31'), ['2024-02-29', '2028-02-29', '2032-02-29']);
  assert.deepEqual(dates('FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', '2026-10-25', '2029-12-31'), ['2026-10-25', '2027-10-31', '2028-10-29', '2029-10-28']);
  assert.deepEqual(dates('FREQ=YEARLY;UNTIL=20281024T080000Z', '2026-10-24', '2030-12-31'), ['2026-10-24', '2027-10-24', '2028-10-24']);
  assert.deepEqual(dates('FREQ=YEARLY;UNTIL=20281024T075959Z', '2026-10-24', '2030-12-31'), ['2026-10-24', '2027-10-24'], '10:00 Vienna is 08:00Z');
  assert.deepEqual(dates('FREQ=YEARLY;UNTIL=20281024', '2026-10-24', '2030-12-31'), ['2026-10-24', '2027-10-24', '2028-10-24'], 'a date UNTIL covers its day');
});

test('expansion stops at the last date asked for; without COUNT it may start near the first date', () => {
  assert.deepEqual(dates('FREQ=WEEKLY', '2026-10-01', '2026-10-20'), ['2026-10-01', '2026-10-08', '2026-10-15']);
  const near = dates('FREQ=WEEKLY', '2000-01-06', '2026-10-31', '2026-10-20');
  assert.equal(near[0], '2000-01-06', 'DTSTART always comes first');
  assert.deepEqual(near.filter((date) => date >= '2026-10-20'), ['2026-10-22', '2026-10-29']);
  assert.ok(near.length < 10, 'the years in between are not walked');
});

test('rules outside the subset are refused; the event then has its first occurrence only', () => {
  const start = parseIcsTime('20261024T100000', { TZID: VIENNA }, VIENNA)!;
  for (const rule of ['FREQ=HOURLY', 'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR', 'FREQ=DAILY;INTERVAL=0', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=DAILY;COUNT=abc', 'INTERVAL=2']) {
    assert.equal(parseRRule(rule, start), undefined, rule);
  }
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID=Europe/Vienna:20261024T100000', 'DURATION:PT1H', 'RRULE:FREQ=MINUTELY',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.deepEqual(readIcs(text, vienna('2026-10-20'), vienna('2026-11-20'), VIENNA).occurrences.map((item) => [item.externalId, item.startAt]),
    [['x', vienna('2026-10-24', '10:00')]]);
});

test('all-day series: whole local days, also across the DST switch; RDATE adds an occurrence', () => {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:trash', 'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261024', 'RRULE:FREQ=DAILY;COUNT=3',
    'RDATE;VALUE=DATE:20261030', 'SUMMARY:Bin day', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const items = readIcs(text, vienna('2026-10-20'), vienna('2026-11-01'), VIENNA).occurrences;
  assert.deepEqual(items.map((item) => [item.externalId, item.startAt, item.endAt]), [
    ['trash#20261023', vienna('2026-10-23'), vienna('2026-10-24')],
    ['trash#20261024', vienna('2026-10-24'), vienna('2026-10-25')],
    ['trash#20261025', vienna('2026-10-25'), vienna('2026-10-26')], // the 25-hour day
    ['trash#20261030', vienna('2026-10-30'), vienna('2026-10-31')],
  ]);
  assert.equal(items[2].endAt - items[2].startAt, 25 * 3_600_000);
});
