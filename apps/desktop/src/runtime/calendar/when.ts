// The zone helpers of My day and the calendar: the local date of an instant, an instant of a local wall time (DST
// gaps move on by the gap), adding days to a date and its weekday – all in the profile zone `tz`.
// Owns: zonedTime/localDate/addDays/weekdayOf. Never: I/O, the clock, or parsing what people type (agents read text).

import { localParts } from '../schedules/spec.ts';

const MIN = 60_000;
const pad = (value: number) => String(value).padStart(2, '0');

/** The zone when it is a valid IANA zone, else undefined (the process zone). */
function zone(tz: string | undefined): string | undefined {
  try { if (tz) new Intl.DateTimeFormat('en', { timeZone: tz }); return tz || undefined; } catch { return undefined; }
}

/** The local calendar date 'YYYY-MM-DD' of `at` in `tz`. */
export function localDate(at: number, tz?: string): string {
  return localParts(at, zone(tz)).date;
}

/** Epoch ms of the wall time `minutes` after local midnight of `date` in `tz` (a wall time a DST change skips moves on by the gap). */
export function zonedTime(date: string, minutes: number, tz?: string): number {
  const z = zone(tz);
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MIN; // the wall time read as if the zone were UTC
  const offset = (ms: number) => {
    const local = localParts(ms, z);
    const [ly, lm, ld] = local.date.split('-').map(Number);
    return Date.UTC(ly, lm - 1, ld) + local.minutes * MIN - Math.floor(ms / MIN) * MIN;
  };
  return wall - offset(wall - offset(wall));
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The weekday of a local date (0 = Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
