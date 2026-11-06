// The calendar's geometry and day math, pure (B-041 §4.1): where a block sits in the day grid (local
// wall minutes in the profile zone, DST-correct; a block running into the day before or after is
// cut at the day's edge), side-by-side lanes for blocks that overlap, the range a click or a drag
// selects (5-minute snap, 15 minutes at least; a click takes 30 minutes from the quarter hour), a
// moved block's new times (dragged by minutes or typed "Move to…"), the working hours, the week and
// the mini month's six weeks, and which days hold blocks.
// Owns: these rules (unit-tested in test/unit/day-ui/day-grid.test.ts). Never: imports the store,
// rpc or the DOM – callers pass events, dates and the zone in.

import { clockMinutes } from '../../shared/model/day-settings.ts';
import { atWallTime, nextDate, wallClock } from '../chat/composer/schedule-clock.ts';
import { shiftDate, weekdayOf } from './day-format.ts';

export const DAY_MINUTES = 24 * 60;
/** Height of one hour in the day grid (px); the stylesheet reads it as --day-hour. */
export const HOUR_PX = 48;
/** An hour's label reaches this far above its line (day.css .day-cal-hour-label top: -8px). */
export const LABEL_ROOM = 8;

/**
 * The grid's first scroll position: `top` as the scroller took it (the end of the day clamps it), moved up
 * when an hour line sits within a label's reach of the top edge – a label is never cut in half there.
 */
export function labelSafeTop(top: number): number {
  const line = Math.round(top / HOUR_PX) * HOUR_PX;
  return Math.abs(top - line) < LABEL_ROOM ? Math.max(0, line - LABEL_ROOM) : top;
}
/** Moves and selections snap to this many minutes. */
export const SNAP_MIN = 5;
/** A selected range is at least this long; a click selects CLICK_MIN from the quarter hour. */
export const MIN_RANGE_MIN = 15;
export const CLICK_MIN = 30;

export interface Span { start: number; end: number } // minutes after local midnight

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Minutes after local midnight of `at` in `tz`. */
export function localMinute(at: number, tz: string): number {
  const wall = wallClock(at, tz);
  return wall.hour * 60 + wall.minute;
}

/** The instant of `minute` (0–1440) on local `date` in `tz` (1440 = the next midnight). */
export function atMinute(date: string, minute: number, tz: string): number {
  if (minute >= DAY_MINUTES) return atWallTime(nextDate(date), 0, 0, tz);
  const whole = clamp(Math.round(minute), 0, DAY_MINUTES - 1);
  return atWallTime(date, Math.floor(whole / 60), whole % 60, tz);
}

/** The instants a local day starts and ends in `tz` (computed once per day, not per event). */
export function dayBounds(date: string, tz: string): { start: number; end: number } {
  return { start: atWallTime(date, 0, 0, tz), end: atWallTime(nextDate(date), 0, 0, tz) };
}

/** spanOn with the day's bounds at hand (the zone math only for an event that is on the day). */
export function spanIn(event: { startAt: number; endAt: number }, bounds: { start: number; end: number }, tz: string): Span | undefined {
  if (event.endAt <= bounds.start || event.startAt >= bounds.end) return undefined;
  const start = event.startAt <= bounds.start ? 0 : localMinute(event.startAt, tz);
  const end = event.endAt >= bounds.end ? DAY_MINUTES : localMinute(event.endAt, tz);
  return { start, end: Math.max(end, start) };
}

/** Where an event sits on `date`: its minutes, cut at the day's edges; undefined when it is not on that day. */
export function spanOn(event: { startAt: number; endAt: number }, date: string, tz: string): Span | undefined {
  return spanIn(event, dayBounds(date, tz), tz);
}

/** Rounds to the snap step and keeps it inside the day. */
export function snapMinute(minute: number, step = SNAP_MIN): number {
  return clamp(Math.round(minute / step) * step, 0, DAY_MINUTES);
}

/** A drag from `from` to `to` (minutes, either direction): snapped, at least MIN_RANGE_MIN long, inside the day. */
export function selection(from: number, to: number): Span {
  let start = snapMinute(Math.min(from, to));
  let end = snapMinute(Math.max(from, to));
  if (end - start < MIN_RANGE_MIN) end = start + MIN_RANGE_MIN;
  if (end > DAY_MINUTES) { end = DAY_MINUTES; start = end - MIN_RANGE_MIN; }
  return { start, end };
}

/** A click at `minute`: CLICK_MIN minutes from the quarter hour it falls in (inside the day). */
export function clickSpan(minute: number): Span {
  const start = clamp(Math.floor(minute / 15) * 15, 0, DAY_MINUTES - CLICK_MIN);
  return { start, end: start + CLICK_MIN };
}

/** A block moved by `delta` minutes: its start snapped, its length kept. */
export function movedBy(event: { startAt: number; endAt: number }, delta: number, tz: string, date: string): { startAt: number; endAt: number } {
  const length = event.endAt - event.startAt;
  const span = spanOn(event, date, tz);
  const from = span ? span.start : 0;
  const start = clamp(snapMinute(from + delta), 0, DAY_MINUTES - SNAP_MIN);
  const startAt = atMinute(date, start, tz);
  return { startAt, endAt: startAt + length };
}

/** "Move to…" a typed 'HH:MM' on `date`: the block's length kept; undefined for no valid time. */
export function movedTo(event: { startAt: number; endAt: number }, date: string, clock: string, tz: string): { startAt: number; endAt: number } | undefined {
  const minute = clockMinutes(clock);
  if (minute === undefined) return undefined;
  const startAt = atMinute(date, minute, tz);
  return { startAt, endAt: startAt + (event.endAt - event.startAt) };
}

/** 'HH:MM' of an instant in `tz` (for the time field). */
export function clockOf(at: number, tz: string): string {
  const wall = wallClock(at, tz);
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/** The working hours as minutes (settings.day; the defaults 08:00–20:00 where a value is unreadable). */
export function workSpan(day: { workStart: string; workEnd: string }): Span {
  const start = clockMinutes(day.workStart) ?? 8 * 60;
  const end = clockMinutes(day.workEnd) ?? 20 * 60;
  return end > start ? { start, end } : { start: 8 * 60, end: 20 * 60 };
}

// ------------------------------------------------------------------ lanes

export interface Laned<T> { item: T; span: Span; lane: number; lanes: number }

/**
 * Side-by-side lanes for overlapping blocks: each block takes the first lane free at its start; a
 * cluster of blocks that overlap one another shares its lane count, so they split the width.
 */
export function lanes<T>(items: ReadonlyArray<{ item: T; span: Span }>): Array<Laned<T>> {
  const sorted = [...items].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  const out: Array<Laned<T>> = [];
  let cluster: Array<Laned<T>> = [];
  let clusterEnd = -1;
  let ends: number[] = [];
  const close = () => { const count = ends.length; for (const entry of cluster) entry.lanes = count; cluster = []; ends = []; };
  for (const entry of sorted) {
    // Short blocks still take a row's height on screen, so they overlap what follows within it.
    const end = Math.max(entry.span.end, entry.span.start + MIN_RANGE_MIN);
    if (entry.span.start >= clusterEnd && cluster.length) close();
    let lane = ends.findIndex((laneEnd) => laneEnd <= entry.span.start);
    if (lane === -1) { lane = ends.length; ends.push(end); } else ends[lane] = end;
    const laned: Laned<T> = { item: entry.item, span: entry.span, lane, lanes: 1 };
    cluster.push(laned);
    out.push(laned);
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) close();
  return out;
}

// ------------------------------------------------------------------ week and month

/** The seven dates (Monday first) of the week `date` is in. */
export function weekOf(date: string): string[] {
  const monday = shiftDate(date, -((weekdayOf(date) + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index));
}

/** The mini month: six weeks (42 dates, Monday first) starting on or before the 1st of `date`'s month. */
export function monthGrid(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const start = shiftDate(first, -((weekdayOf(first) + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => shiftDate(start, index));
}

/** The local dates `events` touch (each day of a block that runs over midnight). */
export function datesWithBlocks(events: ReadonlyArray<{ startAt: number; endAt: number }>, tz: string): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    let date = wallClock(event.startAt, tz).date;
    const last = wallClock(Math.max(event.startAt, event.endAt - 1), tz).date;
    for (let guard = 0; guard < 62; guard++) {
      out.add(date);
      if (date >= last) break;
      date = nextDate(date);
    }
  }
  return out;
}
