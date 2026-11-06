// My day's short texts, pure: a row's time and length ("09:30 · 30 min"), the day title of the date navigation
// ("Today", "Tomorrow", "Sat 25 Oct") and dictated words after typed text.
// Owns: these texts (unit-tested in test/unit/day-ui/day-format.test.ts). Never: imports the store, rpc or the
// DOM – callers pass data, the time and the zone in.

import { nextDate } from '../chat/composer/schedule-clock.ts';

/** "30 min", "1 h", "1 h 30 min". */
export function minutesText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A row's time: "09:30 · 30 min" with a block, "30 min" with an estimate only, else ''. */
export function rowTime(startText: string | undefined, minutes: number | undefined): string {
  const length = minutes !== undefined && minutes > 0 ? minutesText(minutes) : '';
  return [startText, length].filter(Boolean).join(' · ');
}

/** The minutes a block covers. */
export function blockMinutes(event: { startAt: number; endAt: number }): number {
  return Math.max(0, Math.round((event.endAt - event.startAt) / 60_000));
}

/** Dictated words after the typed text: one space between; either may be empty. */
export function joinSaid(text: string, said: string): string {
  const head = text.trimEnd();
  const tail = said.trim();
  return head && tail ? `${head} ${tail}` : head || tail;
}

// ------------------------------------------------------------------ dates

/** The date `days` calendar days from `date` (YYYY-MM-DD; negative goes back). */
export function shiftDate(date: string, days: number): string {
  if (days >= 0) {
    let out = date;
    for (let i = 0; i < days; i++) out = nextDate(out);
    return out;
  }
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The weekday of a date (0 = Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Sat 25 Oct". */
export function dateText(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(date)]} ${d} ${MONTHS[m - 1]}`;
}

/** "October 2026" – the mini month's heading. */
export function monthText(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${y}`;
}

/** The date navigation's title: "Today", "Tomorrow", "Yesterday", else "Sat 25 Oct". */
export function dayTitle(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === shiftDate(today, 1)) return 'Tomorrow';
  if (date === shiftDate(today, -1)) return 'Yesterday';
  return dateText(date);
}
