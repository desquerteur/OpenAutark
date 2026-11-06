// B-041 track G: the ICS reader – a Google Calendar export (weekly series with an EXDATE and a moved occurrence,
// monthly "last Friday" with COUNT, daily with UNTIL across the switch to winter time, an all-day holiday, a UTC event
// with escaped and folded text, a cancelled event), Outlook's Windows zone names, the content-line grammar, and the
// address rules of a calendar link.
// Owns: checks of runtime/calendar/sources/{ics,ics-parse,ics-time}.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icsAddress, readIcs } from '../../../src/runtime/calendar/sources/ics.ts';
import { parseDuration, parseLine, readCalendar, unescapeText, unfold } from '../../../src/runtime/calendar/sources/ics-parse.ts';
import { parseIcsTime, wallToUtc, zoneOf } from '../../../src/runtime/calendar/sources/ics-time.ts';
import { FROM, GOOGLE_EXPORT, OUTLOOK_EVENT, TO, VIENNA, vienna } from './ics-fixtures.ts';

const read = (text = GOOGLE_EXPORT, from = FROM, to = TO) => readIcs(text, from, to, VIENNA);
const byId = (text = GOOGLE_EXPORT) => new Map(read(text).occurrences.map((item) => [item.externalId, item]));

test('a Google export: the calendar name, every occurrence of the window once, in start order', () => {
  const result = read();
  assert.equal(result.name, 'Robin');
  const starts = result.occurrences.map((item) => item.startAt);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(new Set(result.occurrences.map((item) => item.externalId)).size, result.occurrences.length);
  assert.equal(result.occurrences.length, 15);
});

test('a weekly series keeps 09:00 local across the DST switch, leaves out its EXDATE and shows the moved occurrence instead', () => {
  const items = read().occurrences.filter((item) => item.externalId.startsWith('standup@google.com'));
  assert.deepEqual(items.map((item) => [item.externalId, item.title, item.startAt, item.endAt]), [
    ['standup@google.com#20261019T070000Z', 'Standup', vienna('2026-10-19', '09:00'), vienna('2026-10-19', '09:30')],
    ['standup@google.com#20261022T070000Z', 'Standup', vienna('2026-10-22', '09:00'), vienna('2026-10-22', '09:30')],
    // 26 Oct is excluded (EXDATE); 29 Oct moved to 11:00 – its id is the ORIGINAL start (09:00 CET = 08:00Z)
    ['standup@google.com#20261029T080000Z', 'Standup (moved)', vienna('2026-10-29', '11:00'), vienna('2026-10-29', '11:30')],
    ['standup@google.com#20261102T080000Z', 'Standup', vienna('2026-11-02', '09:00'), vienna('2026-11-02', '09:30')],
  ]);
  assert.equal(new Date(items[0].startAt).toISOString(), '2026-10-19T07:00:00.000Z', 'summer time: UTC+2');
  assert.equal(new Date(items[3].startAt).toISOString(), '2026-11-02T08:00:00.000Z', 'winter time: UTC+1');
  assert.equal(items[0].tz, VIENNA);
  assert.equal(items[0].notes, 'Zoom\n\nDaily sync\nwith the team', 'location, then the unescaped description');
});

test('a daily series with UNTIL stops on its last day; 07:30 stays 07:30 on the 23-hour day', () => {
  const items = read().occurrences.filter((item) => item.externalId.startsWith('pills@'));
  assert.equal(items.length, 8, '20 … 27 Oct');
  assert.equal(items[0].startAt, vienna('2026-10-20', '07:30'));
  assert.equal(items.at(-1)!.startAt, vienna('2026-10-27', '07:30'));
  const sunday = items.find((item) => item.externalId === 'pills@google.com#20261025T063000Z')!;
  assert.equal(sunday.startAt, vienna('2026-10-25', '07:30'));
  assert.equal(sunday.endAt - sunday.startAt, 15 * 60_000);
});

test('a monthly "last Friday" series with COUNT, an all-day holiday, a UTC event, and a cancelled one', () => {
  const items = byId();
  const review = [...items.values()].filter((item) => item.externalId.startsWith('review@'));
  assert.deepEqual(review.map((item) => item.startAt), [vienna('2026-10-30', '15:00')], 'the October occurrence (of 25 Sep, 30 Oct, 27 Nov)');
  const holiday = items.get('nationalfeiertag@google.com')!;
  assert.deepEqual([holiday.allDay, holiday.startAt, holiday.endAt, holiday.tz], [true, vienna('2026-10-26'), vienna('2026-10-27'), undefined]);
  const dinner = items.get('dinner@google.com')!;
  assert.equal(dinner.title, 'Abendessen, Oma');
  assert.equal(dinner.notes, 'Bring the photos from the summer and the recipe book that is still on the shelf', 'a folded line is one line');
  assert.equal(dinner.startAt, Date.UTC(2026, 9, 24, 17, 0));
  assert.equal(dinner.tz, 'UTC');
  assert.equal(items.has('lunch@google.com'), false, 'STATUS:CANCELLED is left out');
});

test('only occurrences overlapping the window are returned; an old series is expanded near the window, not from its start', () => {
  const oneDay = read(GOOGLE_EXPORT, vienna('2026-10-26'), vienna('2026-10-27')).occurrences;
  assert.deepEqual(oneDay.map((item) => item.externalId), ['nationalfeiertag@google.com', 'pills@google.com#20261026T063000Z']);
  const old = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:old', 'DTSTART;TZID=Europe/Vienna:19900101T080000', 'DTEND;TZID=Europe/Vienna:19900101T081500',
    'RRULE:FREQ=DAILY', 'SUMMARY:Daily since 1990', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const started = performance.now();
  const items = readIcs(old, vienna('2026-10-24'), vienna('2026-10-26'), VIENNA).occurrences;
  assert.ok(performance.now() - started < 200, 'no walk over 36 years of days');
  assert.deepEqual(items.map((item) => item.startAt), [vienna('2026-10-24', '08:00'), vienna('2026-10-25', '08:00')]);
});

test('Outlook: Windows zone names and "(UTC+01:00) … Wien" labels; DURATION instead of DTEND', () => {
  const items = read(OUTLOOK_EVENT).occurrences;
  assert.deepEqual(items.map((item) => [item.externalId, item.startAt, item.endAt, item.tz]), [
    ['outlook-1', vienna('2026-10-28', '14:00'), vienna('2026-10-28', '15:00'), 'Europe/Berlin'],
    ['outlook-2', vienna('2026-10-30', '08:00'), vienna('2026-10-30', '08:45'), 'Europe/Berlin'],
  ]);
});

test('zones: IANA names, vendor prefixes, Windows names; an unknown TZID or a floating time uses the calendar zone', () => {
  assert.equal(zoneOf('Europe/Vienna', 'UTC'), 'Europe/Vienna');
  assert.equal(zoneOf('/mozilla.org/20050126_1/Europe/Vienna', 'UTC'), 'Europe/Vienna');
  assert.equal(zoneOf('"Pacific Standard Time"', 'UTC'), 'America/Los_Angeles');
  assert.equal(zoneOf('Custom zone 4', VIENNA), VIENNA);
  assert.equal(parseIcsTime('20261024T090000', {}, VIENNA)!.at, vienna('2026-10-24', '09:00'), 'floating');
  assert.equal(parseIcsTime('20261024T090000', { TZID: 'Mars/Olympus' }, VIENNA)!.at, vienna('2026-10-24', '09:00'));
  assert.equal(parseIcsTime('20260230', {}, VIENNA), undefined, 'no 30 February');
  assert.equal(parseIcsTime('2026-10-24', {}, VIENNA), undefined);
  // 02:30 on 29 March 2026 does not exist in Vienna: it moves on by the gap
  assert.equal(wallToUtc('2026-03-29', 2.5 * 3600, VIENNA), Date.UTC(2026, 2, 29, 1, 30));
});

test('the content-line grammar: folding, quoted parameters with colons, TEXT escapes, DURATION values', () => {
  assert.deepEqual(unfold('A:1\r\n 2\r\nB:3\n\tx\n'), ['A:12', 'B:3x']);
  assert.deepEqual(parseLine('DTSTART;TZID="(UTC+01:00) Wien: Zeit";VALUE=DATE-TIME:20261024T090000'),
    { name: 'DTSTART', params: { TZID: '(UTC+01:00) Wien: Zeit', VALUE: 'DATE-TIME' }, value: '20261024T090000' });
  assert.equal(parseLine('no colon here'), undefined);
  assert.equal(unescapeText('a\\, b\\; c\\nd\\\\e'), 'a, b; c\nd\\e');
  assert.deepEqual(parseDuration('PT1H30M'), { days: 0, ms: 5_400_000 });
  assert.deepEqual(parseDuration('P1W2D'), { days: 9, ms: 0 });
  assert.equal(parseDuration('P'), undefined);
  assert.equal(parseDuration('PT'), undefined);
  assert.equal(parseDuration('1H'), undefined);
});

test('a broken feed: events without a start, an override with an unreadable RECURRENCE-ID, repeated UIDs, no UID', () => {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:no start', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261024T100000Z', 'SUMMARY:first', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261024T110000Z', 'SUMMARY:second', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'RECURRENCE-ID:garbage', 'DTSTART:20261024T120000Z', 'SUMMARY:bad override', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261024T130000Z', 'SUMMARY:no uid', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  const calendar = readCalendar(text, VIENNA);
  assert.deepEqual(calendar.events.map((event) => event.title), ['first', 'second', 'no uid']);
  const items = readIcs(text, vienna('2026-10-24'), vienna('2026-10-25'), VIENNA).occurrences;
  assert.deepEqual(items.map((item) => item.title), ['second', 'no uid'], 'a repeated UID: the last one wins');
  assert.equal(items[0].endAt, items[0].startAt, 'no DTEND, no DURATION: it ends when it starts');
  assert.match(items[1].externalId, /^no-uid-/);
});

test('calendar link addresses: https and http, webcal read as https, nothing else, no credentials in it', () => {
  assert.deepEqual(icsAddress('webcal://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics'),
    { url: 'https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics', host: 'calendar.google.com' });
  assert.equal(icsAddress(' https://example.com/a.ics ')!.url, 'https://example.com/a.ics');
  assert.equal(icsAddress('http://intranet.example/cal.ics')!.host, 'intranet.example');
  assert.equal(icsAddress('ftp://example.com/a.ics'), undefined);
  assert.equal(icsAddress('file:///C:/cal.ics'), undefined);
  assert.equal(icsAddress('https://user:pw@example.com/a.ics'), undefined);
  assert.equal(icsAddress('not a url'), undefined);
});
