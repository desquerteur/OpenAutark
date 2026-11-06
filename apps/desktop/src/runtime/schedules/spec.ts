// Pure schedule math: next fire time of a ScheduleSpec after a given instant.
// Supports one-off `at`, 5/6-field `cron` (croner, IANA tz, DST-safe), fixed `everyMs`
// (anchored at `at` when given), clock `times` each local day (B-044: "09:00, 13:30, 18:00" –
// the earliest next one over all times, DST-correct wall times; `at` is "not before"), `until`,
// `except` dates, local weekdays `days` and a daily HH:MM `window` (evaluated in the spec's tz;
// windows may wrap midnight, e.g. 22:00–06:00). An excluded date or weekday is skipped as a
// whole local day (DST-safe: 23/25-hour days and midnights that DST skips), so "every 5 minutes
// except Friday" stays a few steps. `maxRuns` and catch-up are stateful and handled by the scheduler.
// Owns: those rules. Never: I/O, timers or the clock.

import { Cron } from 'croner';
import type { ScheduleSpec } from '../../shared/model/tasks.ts';

const MAX_STEPS = 5000; // bound for skipping excluded days / outside-window instants
const MIN = 60_000;
export const MAX_TIMES = 24;

/** A one-off: `at` alone, no recurrence. */
export function isOneOff(spec: ScheduleSpec): boolean {
  return spec.at !== undefined && spec.cron === undefined && spec.everyMs === undefined && spec.times === undefined;
}

export function validateSpec(spec: ScheduleSpec, options: { minEveryMs?: number } = {}): string | undefined {
  const kinds = [spec.cron !== undefined, spec.everyMs !== undefined, spec.times !== undefined].filter(Boolean).length;
  if (spec.at === undefined && !kinds) return 'A schedule needs "at", "cron", "everyMs" or "times".';
  if (kinds > 1) return 'Use only one of "cron", "everyMs" and "times".';
  if (spec.everyMs !== undefined && (!Number.isFinite(spec.everyMs) || spec.everyMs < (options.minEveryMs ?? 60_000))) {
    return `"everyMs" must be at least ${options.minEveryMs ?? 60_000} ms.`;
  }
  if (spec.cron !== undefined) {
    try { cron(spec); } catch { return 'Invalid cron expression.'; }
  }
  if (spec.times !== undefined && !validTimes(spec.times)) return `"times" must list 1 to ${MAX_TIMES} different HH:MM times.`;
  if (spec.tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: spec.tz }); } catch { return 'Unknown time zone.'; }
  }
  if (spec.window && (!isClock(spec.window.from) || !isClock(spec.window.to))) return 'Window times must be HH:MM.';
  if (spec.except?.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day))) return 'Excluded dates must be YYYY-MM-DD.';
  if (spec.days !== undefined && (!Array.isArray(spec.days) || !spec.days.length || spec.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) {
    return '"days" must list weekdays from 0 (Sunday) to 6 (Saturday).';
  }
  return undefined;
}

function validTimes(times: unknown): boolean {
  return Array.isArray(times) && times.length > 0 && times.length <= MAX_TIMES
    && times.every(time => typeof time === 'string' && isClock(time)) && new Set(times).size === times.length;
}

/** Next fire time strictly after `after`, or undefined when the schedule is exhausted. */
export function nextFire(spec: ScheduleSpec, after: number): number | undefined {
  // An unanchored interval runs on the grid after + k·everyMs, also across skipped days.
  const grid = spec.everyMs !== undefined && spec.cron === undefined && spec.at === undefined ? { ...spec, at: after } : spec;
  let cursor = after;
  for (let step = 0; step < MAX_STEPS; step++) {
    const candidate = rawNext(grid, cursor);
    if (candidate === undefined) return undefined;
    if (spec.until !== undefined && candidate > spec.until) return undefined;
    const blocked = excluded(spec, candidate);
    if (!blocked) return candidate;
    if (isOneOff(spec)) return undefined; // one-off excluded
    cursor = blocked === 'day' ? Math.max(candidate, nextLocalDay(candidate, spec.tz) - 1) : candidate;
  }
  return undefined;
}

/** All fire times in (from, to], at most `limit` (catch-up policy 'all', UI previews). */
export function firesBetween(spec: ScheduleSpec, from: number, to: number, limit = 100): number[] {
  const out: number[] = [];
  let cursor = from;
  while (out.length < limit) {
    const next = nextFire(spec, cursor);
    if (next === undefined || next > to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function rawNext(spec: ScheduleSpec, after: number): number | undefined {
  // `at` acts as "not before" for cron and clock-time schedules.
  const notBefore = spec.at !== undefined && spec.at - 1 > after ? spec.at - 1 : after;
  if (spec.cron !== undefined) {
    const next = cron(spec).nextRun(new Date(notBefore));
    return next ? next.getTime() : undefined;
  }
  if (spec.times !== undefined) return nextClockTime(spec.times, spec.tz, notBefore);
  if (spec.everyMs !== undefined) {
    if (spec.at === undefined) return after + spec.everyMs;
    if (spec.at > after) return spec.at;
    const k = Math.floor((after - spec.at) / spec.everyMs) + 1;
    return spec.at + k * spec.everyMs;
  }
  if (spec.at !== undefined) return spec.at > after ? spec.at : undefined;
  return undefined;
}

/** The earliest of the clock times strictly after `after` (on its local day or the next ones). */
function nextClockTime(times: readonly string[], tz: string | undefined, after: number): number | undefined {
  let date = localParts(after, tz).date;
  for (let day = 0; day < 3; day++) {
    let best: number | undefined;
    for (const time of times) {
      const at = wallInstant(date, minutes(time), tz);
      if (at > after && (best === undefined || at < best)) best = at;
    }
    if (best !== undefined) return best;
    date = nextDate(date);
  }
  return undefined;
}

const cronCache = new Map<string, Cron>();

function cron(spec: ScheduleSpec): Cron {
  const key = `${spec.cron}|${spec.tz ?? ''}`;
  let job = cronCache.get(key);
  if (!job) {
    job = new Cron(spec.cron!, { timezone: spec.tz, paused: true }); // no callback: pure calculator, no timer
    if (cronCache.size > 200) cronCache.clear();
    cronCache.set(key, job);
  }
  return job;
}

/** Why `at` may not fire: 'day' (an excluded date or weekday – its whole local day is out), 'time' (outside the window); undefined when it may. */
function excluded(spec: ScheduleSpec, at: number): 'day' | 'time' | undefined {
  if (!spec.except?.length && !spec.days && !spec.window) return undefined;
  const local = localParts(at, spec.tz);
  if (spec.except?.includes(local.date)) return 'day';
  if (spec.days && !spec.days.includes(weekday(local.date))) return 'day';
  if (spec.window) {
    const from = minutes(spec.window.from);
    const to = minutes(spec.window.to);
    const now = local.minutes;
    const inside = from <= to ? now >= from && now < to : now >= from || now < to;
    if (!inside) return 'time';
  }
  return undefined;
}

/** The zone's offset (local minus UTC, ms) at `ms`, to the minute. */
function offsetAt(ms: number, tz?: string): number {
  const local = localParts(ms, tz);
  const [y, m, d] = local.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + local.minutes * MIN - Math.floor(ms / MIN) * MIN;
}

/**
 * The instant of local `date` (YYYY-MM-DD) at `minuteOfDay` in `tz` (DST-correct to the minute;
 * a wall time that DST skips lands an hour off, a repeated one on one of its two instants).
 */
export function wallInstant(date: string, minuteOfDay: number, tz?: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + minuteOfDay * MIN; // the wall time read as if the zone were UTC
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/**
 * The first instant of the local day after the one `at` falls on, in `tz`: the zone's offset is
 * read at the target, so 23- and 25-hour days are exact; when DST skips that midnight the day
 * starts at the first wall time that exists (01:00).
 */
export function nextLocalDay(at: number, tz?: string): number {
  const { date } = localParts(at, tz);
  const [y, m, d] = date.split('-').map(Number);
  const midnight = Date.UTC(y, m - 1, d + 1); // the next local midnight, read as if the zone were UTC
  const first = midnight - offsetAt(midnight, tz);
  const second = midnight - offsetAt(first, tz);
  return localParts(second, tz).date === date ? Math.max(first, second) : second;
}

/** The calendar day after `date` (YYYY-MM-DD). */
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Weekday (0 Sunday … 6 Saturday) of a YYYY-MM-DD calendar date. */
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date (YYYY-MM-DD) and minute of day in `tz` (default: process zone). */
export function localParts(at: number, tz?: string): { date: string; minutes: number } {
  const key = tz ?? '';
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(key, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function isClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
