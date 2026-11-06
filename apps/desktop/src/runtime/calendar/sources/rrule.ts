// Recurrence rules of connected calendars (B-041 track G, RFC 5545 §3.3.10 – the subset Google, Outlook and Apple
// export): FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with an ordinal such as 2TU or -1FR for
// monthly and yearly rules), BYMONTHDAY, BYMONTH and WKST. Occurrences are generated as local dates in the event's
// zone (so 09:00 stays 09:00 across a DST change) and only up to the last date asked for; without COUNT the walk
// starts near the first date asked for. DTSTART is always the first occurrence. Anything else (BYSETPOS, BYHOUR,
// SECONDLY …) makes the rule unknown: the caller keeps the first occurrence only.
// Owns: parsing and expanding that subset. Never: I/O, the clock, or EXDATE / RECURRENCE-ID (ics.ts applies those).

import { addDays, dateOf, daysBetween, daysInMonth, parseIcsTime, splitDate, weekday, type IcsTime } from './ics-time.ts';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export interface ByDay { n?: number; day: number } // day: 0 = Sunday

export interface RRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** The last instant an occurrence may start at (inclusive). */
  until?: number;
  byDay?: ByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  wkst: number;
}

const DAYS: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const FREQS: ReadonlySet<string> = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const KNOWN: ReadonlySet<string> = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
/** Candidates looked at per series at most (a daily rule over 30 years stays well below). */
const MAX_STEPS = 50_000;

function ints(value: string, min: number, max: number): number[] | undefined {
  const out = value.split(',').map((part) => Number(part));
  return out.every((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max) ? out : undefined;
}

/** The rule of an RRULE value, UNTIL read in `start`'s zone; undefined for a rule outside the subset. */
export function parseRRule(value: string, start: IcsTime): RRule | undefined {
  const parts = new Map<string, string>();
  for (const part of value.replace(/^RRULE:/i, '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1).toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (!freq || !FREQS.has(freq) || [...parts.keys()].some((key) => !KNOWN.has(key))) return undefined;
  const rule: RRule = { freq: freq as Freq, interval: 1, wkst: 1 };
  const interval = Number(parts.get('INTERVAL') ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return undefined;
  rule.interval = interval;
  if (parts.has('COUNT')) {
    const count = Number(parts.get('COUNT'));
    if (!Number.isInteger(count) || count < 1) return undefined;
    rule.count = count;
  }
  if (parts.has('UNTIL')) {
    const until = parseIcsTime(parts.get('UNTIL')!, {}, start.tz);
    if (!until) return undefined;
    rule.until = until.allDay ? until.at + (start.allDay ? 0 : 86_400_000 - 1) : until.at; // a date UNTIL covers that whole day
  }
  if (parts.has('BYDAY')) {
    const days: ByDay[] = [];
    for (const part of parts.get('BYDAY')!.split(',')) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.trim());
      if (!match) return undefined;
      const n = match[1] === undefined ? undefined : Number(match[1]);
      if (n !== undefined && (n === 0 || Math.abs(n) > 53)) return undefined;
      days.push(n === undefined ? { day: DAYS[match[2]] } : { n, day: DAYS[match[2]] });
    }
    rule.byDay = days;
  }
  if (parts.has('BYMONTHDAY')) {
    const days = ints(parts.get('BYMONTHDAY')!, 1, 31);
    if (!days) return undefined;
    rule.byMonthDay = days;
  }
  if (parts.has('BYMONTH')) {
    const months = ints(parts.get('BYMONTH')!, 1, 12);
    if (!months || months.some((m) => m < 0)) return undefined;
    rule.byMonth = months;
  }
  if (parts.has('WKST')) {
    const day = DAYS[parts.get('WKST')!];
    if (day === undefined) return undefined;
    rule.wkst = day;
  }
  return rule;
}

/** The dates of `days` (BYDAY) inside a month, an ordinal counting from its start (2TU) or end (-1FR). */
function weekdaysIn(year: number, month: number, days: readonly ByDay[]): string[] {
  const out = new Set<string>();
  const last = daysInMonth(year, month);
  for (const by of days) {
    const all: string[] = [];
    for (let d = 1; d <= last; d++) if (weekday(dateOf(year, month, d)) === by.day) all.push(dateOf(year, month, d));
    if (by.n === undefined) all.forEach((date) => out.add(date));
    else {
      const pick = by.n > 0 ? all[by.n - 1] : all[all.length + by.n];
      if (pick) out.add(pick);
    }
  }
  return [...out];
}

/** The dates of `days` (BYDAY with ordinals) inside a whole year (a yearly rule without BYMONTH: 20MO = the 20th Monday). */
function weekdaysInYear(year: number, days: readonly ByDay[]): string[] {
  const out = new Set<string>();
  const total = daysBetween(dateOf(year, 1, 1), dateOf(year + 1, 1, 1));
  for (const by of days) {
    const all: string[] = [];
    for (let i = 0; i < total; i++) { const date = addDays(dateOf(year, 1, 1), i); if (weekday(date) === by.day) all.push(date); }
    if (by.n === undefined) all.forEach((date) => out.add(date));
    else { const pick = by.n > 0 ? all[by.n - 1] : all[all.length + by.n]; if (pick) out.add(pick); }
  }
  return [...out];
}

/** The days of a month a monthly (or yearly-in-month) rule picks: BYMONTHDAY and BYDAY intersect; neither → DTSTART's day. */
function monthDates(rule: RRule, year: number, month: number, startDay: number): string[] {
  const last = daysInMonth(year, month);
  const byMonthDay = rule.byMonthDay?.map((d) => (d > 0 ? d : last + d + 1)).filter((d) => d >= 1 && d <= last).map((d) => dateOf(year, month, d));
  const byDay = rule.byDay ? weekdaysIn(year, month, rule.byDay) : undefined;
  if (byMonthDay && byDay) return byMonthDay.filter((date) => byDay.includes(date));
  if (byMonthDay) return byMonthDay;
  if (byDay) return byDay;
  return startDay <= last ? [dateOf(year, month, startDay)] : []; // no 31st in April: skipped (RFC 5545)
}

/** Whether `date` is one of the month days of BYMONTHDAY (negative: from the month's end). */
function onMonthDay(days: readonly number[], date: string): boolean {
  const [y, m, d] = splitDate(date);
  const last = daysInMonth(y, m);
  return days.some((day) => (day > 0 ? day : last + day + 1) === d);
}

/** The candidate dates of period `k` (sorted), before the DTSTART and UNTIL checks. */
function periodDates(rule: RRule, start: string, k: number): string[] {
  const [y, m, d] = splitDate(start);
  let dates: string[];
  switch (rule.freq) {
    case 'DAILY': {
      const date = addDays(start, k * rule.interval);
      const keep = (!rule.byDay || rule.byDay.some((by) => by.day === weekday(date))) && (!rule.byMonthDay || onMonthDay(rule.byMonthDay, date));
      dates = keep ? [date] : [];
      break;
    }
    case 'WEEKLY': {
      const weekStart = addDays(start, -((weekday(start) - rule.wkst + 7) % 7) + k * 7 * rule.interval);
      const days = rule.byDay?.length ? rule.byDay.map((by) => by.day) : [weekday(start)];
      dates = [...new Set(days.map((day) => addDays(weekStart, (day - rule.wkst + 7) % 7)))];
      break;
    }
    case 'MONTHLY': {
      const index = (m - 1) + k * rule.interval;
      dates = monthDates(rule, y + Math.floor(index / 12), (index % 12) + 1, d);
      break;
    }
    case 'YEARLY': {
      const year = y + k * rule.interval;
      if (rule.byMonth) dates = rule.byMonth.flatMap((month) => monthDates(rule, year, month, d));
      else if (rule.byDay) dates = weekdaysInYear(year, rule.byDay).filter((date) => !rule.byMonthDay || onMonthDay(rule.byMonthDay, date));
      else if (rule.byMonthDay) dates = Array.from({ length: 12 }, (_unused, index) => monthDates(rule, year, index + 1, d)).flat();
      else dates = monthDates(rule, year, m, d); // Feb 29 only in leap years
      break;
    }
  }
  return dates.filter((date) => !rule.byMonth || rule.byMonth.includes(splitDate(date)[1])).sort();
}

/** The period index a date falls into (whole periods since DTSTART's period; used to start near the window). */
function periodOf(rule: RRule, start: string, date: string): number {
  const [sy, sm] = splitDate(start);
  const [y, m] = splitDate(date);
  switch (rule.freq) {
    case 'DAILY': return Math.floor(daysBetween(start, date) / rule.interval);
    case 'WEEKLY': {
      const weekStart = addDays(start, -((weekday(start) - rule.wkst + 7) % 7));
      return Math.floor(daysBetween(weekStart, date) / 7 / rule.interval);
    }
    case 'MONTHLY': return Math.floor(((y - sy) * 12 + (m - sm)) / rule.interval);
    case 'YEARLY': return Math.floor((y - sy) / rule.interval);
  }
}

/**
 * The local start dates of a series from DTSTART up to `lastDate` (inclusive), in order. `firstDate`: dates before
 * it may be skipped when the rule has no COUNT (they would only be thrown away). `toInstant` turns a date into the
 * occurrence's start instant for UNTIL.
 */
export function expandDates(rule: RRule, start: IcsTime, window: { firstDate: string; lastDate: string }, toInstant: (date: string) => number): string[] {
  const out: string[] = [start.date];
  let counted = 1;
  if (rule.count === 1 || start.date > window.lastDate) return out;
  const lastPeriod = periodOf(rule, start.date, window.lastDate);
  let k = rule.count === undefined ? Math.max(0, periodOf(rule, start.date, window.firstDate) - 1) : 0;
  for (let steps = 0; steps < MAX_STEPS && k <= lastPeriod; k++, steps++) {
    for (const date of periodDates(rule, start.date, k)) {
      if (date <= start.date) continue; // DTSTART counted already; earlier candidates are none
      if (date > window.lastDate) return out;
      if (rule.until !== undefined && toInstant(date) > rule.until) return out;
      out.push(date);
      counted++;
      if (rule.count !== undefined && counted >= rule.count) return out;
    }
  }
  return out;
}
