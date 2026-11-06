// ICS fixtures for the connected-calendar tests (B-041 track G): a Google Calendar export (VTIMEZONE Europe/Vienna,
// a weekly series with an EXDATE and a moved occurrence, a monthly "last Friday" series with COUNT, a daily series
// with UNTIL across the switch to winter time on 25 Oct 2026, an all-day holiday, a UTC event with escaped and
// folded text, a cancelled event) plus an Outlook event with a Windows zone name. CRLF line ends like the real ones.
// Owns: fixtures only. Never imported by src/.

import { wallToUtc } from '../../../src/runtime/calendar/sources/ics-time.ts';

export const VIENNA = 'Europe/Vienna';

/** Epoch ms of `hhmm` on `date` in Vienna. */
export function vienna(date: string, hhmm = '00:00'): number {
  const [h, m] = hhmm.split(':').map(Number);
  return wallToUtc(date, h * 3600 + m * 60, VIENNA);
}

const lines = (...rows: string[]) => `${rows.join('\r\n')}\r\n`;

export const GOOGLE_EXPORT = lines(
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Robin',
  'X-WR-TIMEZONE:Europe/Vienna',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Vienna',
  'X-LIC-LOCATION:Europe/Vienna',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Vienna:20261005T090000',
  'DTEND;TZID=Europe/Vienna:20261005T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TH',
  'EXDATE;TZID=Europe/Vienna:20261026T090000',
  'DTSTAMP:20261020T120000Z',
  'UID:standup@google.com',
  'CREATED:20260901T080000Z',
  'DESCRIPTION:Daily sync\\nwith the team',
  'LAST-MODIFIED:20261020T120000Z',
  'LOCATION:Zoom',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Standup',
  'TRANSP:OPAQUE',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Vienna:20261029T110000',
  'DTEND;TZID=Europe/Vienna:20261029T113000',
  'DTSTAMP:20261020T120000Z',
  'UID:standup@google.com',
  'RECURRENCE-ID;TZID=Europe/Vienna:20261029T090000',
  'SUMMARY:Standup (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261026',
  'DTEND;VALUE=DATE:20261027',
  'UID:nationalfeiertag@google.com',
  'SUMMARY:Nationalfeiertag',
  'TRANSP:TRANSPARENT',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Vienna:20260925T150000',
  'DTEND;TZID=Europe/Vienna:20260925T160000',
  'RRULE:FREQ=MONTHLY;COUNT=3;BYDAY=-1FR',
  'UID:review@google.com',
  'SUMMARY:Monthly review',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261024T170000Z',
  'DTEND:20261024T183000Z',
  'UID:dinner@google.com',
  'SUMMARY:Abendessen\\, Oma',
  'DESCRIPTION:Bring the photos from the summer and the recipe book that is still ',
  ' on the shelf',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Vienna:20261027T120000',
  'DTEND;TZID=Europe/Vienna:20261027T130000',
  'UID:lunch@google.com',
  'STATUS:CANCELLED',
  'SUMMARY:Lunch',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Vienna:20261020T073000',
  'DTEND;TZID=Europe/Vienna:20261020T074500',
  'RRULE:FREQ=DAILY;UNTIL=20261027T225959Z',
  'UID:pills@google.com',
  'SUMMARY:Pills',
  'END:VEVENT',
  'END:VCALENDAR',
);

export const OUTLOOK_EVENT = lines(
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;TZID="W. Europe Standard Time":20261028T140000',
  'DTEND;TZID="W. Europe Standard Time":20261028T150000',
  'UID:outlook-1',
  'SUMMARY:Zahnarzt',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID="(UTC+01:00) Amsterdam, Berlin, Bern, Rom, Stockholm, Wien":20261030T080000',
  'DURATION:PT45M',
  'UID:outlook-2',
  'SUMMARY:Physio',
  'END:VEVENT',
  'END:VCALENDAR',
);

/** The window the parser tests read: Monday 19 Oct up to Tuesday 3 Nov 2026 (local midnights in Vienna). */
export const FROM = vienna('2026-10-19');
export const TO = vienna('2026-11-03');
