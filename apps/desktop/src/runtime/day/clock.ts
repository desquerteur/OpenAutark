// Day math of My day (B-041 track A2): every day of the runtime's My day is a local date in the profile zone
// (settings.profile.timezone), with the day settings' defaults filled in, and DAY_BOUNDARY_HOUR deciding which day
// a night-time moment still belongs to ("since last evening" at 01:00 means the evening before yesterday's).
// Owns: these small helpers. Never: reads the clock itself or stores anything.

import { DAY_BOUNDARY_HOUR, DEFAULT_DAY_SETTINGS, clockMinutes, daySettingsOf, type DaySettings } from '../../shared/model/day-settings.ts';
import type { RuntimeServices } from '../contracts.ts';
import { localParts } from '../schedules/spec.ts';
import { addDays, zonedTime } from '../calendar/when.ts';

/** The profile zone (the process zone when settings cannot be read or name no valid zone). */
export function dayZone(s: Partial<Pick<RuntimeServices, 'settings'>>): string {
  try {
    const tz = s.settings?.get().profile.timezone;
    if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; }
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Settings › day with every key (defaults where settings are missing). */
export function daySettings(s: Partial<Pick<RuntimeServices, 'settings'>>): DaySettings {
  try { return daySettingsOf(s.settings?.get()); } catch { return { ...DEFAULT_DAY_SETTINGS }; }
}

/** [start, end) of a local day. */
export function dayBounds(date: string, tz: string): { start: number; end: number } {
  return { start: zonedTime(date, 0, tz), end: zonedTime(addDays(date, 1), 0, tz) };
}

/** The local date of `at`, and its minutes after midnight. */
export function localTime(at: number, tz: string): { date: string; minutes: number } {
  return localParts(at, tz);
}

/** The My-day day `at` belongs to: before the day boundary (04:00) it is still the date that just ended. */
export function dayOf(at: number, tz: string): string {
  const local = localParts(at, tz);
  return local.minutes < DAY_BOUNDARY_HOUR * 60 ? addDays(local.date, -1) : local.date;
}

/** "Since last evening": the end of the working hours of the day before the current My-day day (one rule with Home). */
export { lastEvening } from '../../shared/model/day-settings.ts';

/** The local wall time 'HH:MM' of `date` as an instant. */
export function wallTime(date: string, clock: string, tz: string): number {
  return zonedTime(date, clockMinutes(clock) ?? 0, tz);
}
