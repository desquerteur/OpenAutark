// The day planner (B-041 track A2; pure, tested with a fixed clock): places the person's to-dos into the free gaps
// of one local day `date` in the profile zone – within workStart–workEnd, minus busy spans (events, person-set
// blocks) and every block it may not move, with `bufferMin` around each, on a 5-minute grid, first fit, each
// to-do inside its window (notBefore/notAfter; a window.date or weekdays that are not this day keep it out).
// Order: overdue or due that day → priority → due → has hours → shorter estimate → older → the caller's order (the
// order dictated). Too long or no room →
// unplanned with a short reason. A to-do's block is fixed unless the planner set it and it is not started:
// 'replan' moves such blocks of that day (only after `now`); both modes move any block of an open to-do that ended
// unticked before that day, whoever set it (yesterday's plan wanders on – an ended block holds no time), and a
// cut or done block of a to-do that is open again. A to-do without a day that was written after
// workEnd belongs to the next day (Robin's evening list is tomorrow's). A movable block that finds no new place
// is `released` (the caller removes it: the to-do shows as unplanned).
// Owns: the placement rule. Never: I/O, the clock, model calls, or moves a person- or agent-set block that has not ended.

import type { CalendarEventState, CalendarSetBy, DayPlanMode, TaskWindow } from '../../shared/model/calendar.ts';
import { clockMinutes, MAX_BUFFER_MIN } from '../../shared/model/day-settings.ts';
import { localParts } from '../schedules/spec.ts';
import { addDays, weekdayOf, zonedTime } from './when.ts';

const MIN = 60_000;
const GRID = 5 * MIN;

/** One open to-do of the person (the caller reads tasks and their estimates; the planner never does). */
export interface PlanTodo {
  taskId: string;
  estimateMin: number;
  priority: 0 | 1 | 2;
  dueAt?: number;
  window?: TaskWindow;
  createdAt: number;
}

/** A task's calendar block (the to-dos' own blocks, and other tasks' blocks on that day). */
export interface PlanBlock {
  taskId?: string;
  startAt: number;
  endAt: number;
  setBy: CalendarSetBy;
  state: CalendarEventState;
}

export interface Span { startAt: number; endAt: number }

export interface PlanInput {
  date: string; // YYYY-MM-DD in `tz`
  tz: string;
  now: number;
  mode: DayPlanMode;
  workStart: string; // 'HH:MM'
  workEnd: string;
  bufferMin: number;
  /** Busy spans (calendar.busy: events and person-set blocks – a list with every block is fine, see planDay). */
  busy: Span[];
  blocks: PlanBlock[];
  todos: PlanTodo[];
}

export interface Placement { taskId: string; startAt: number; endAt: number; moved: boolean }

export interface PlanOutput {
  /** New blocks, and planner blocks moved to a new time (`moved`), in placement order. */
  placements: Placement[];
  /** To-dos whose movable block found no new place (their old block goes). */
  released: string[];
  unplanned: Array<{ taskId: string; reason: string }>;
}

interface Candidate { todo: PlanTodo; minutes: number; moved: boolean }

const ceilGrid = (at: number) => Math.ceil(at / GRID) * GRID;
const pad = (value: number) => String(value).padStart(2, '0');

/** "45 min", "2 h", "1 h 30 min". */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h === 0 ? `${m} min` : m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** The local date a to-do without a day belongs to: the day it was written, or the next one when written after workEnd. */
export function firstDayOf(createdAt: number, tz: string, workEndMin: number): string {
  const local = localParts(createdAt, tz);
  return local.minutes >= workEndMin ? addDays(local.date, 1) : local.date;
}

/** Free spans of [from, to) once `taken` (sorted or not) is cut out. */
function freeSpans(from: number, to: number, taken: Span[]): Span[] {
  const free: Span[] = [];
  let at = from;
  for (const span of [...taken].sort((a, b) => a.startAt - b.startAt)) {
    if (span.endAt <= at || span.startAt >= to) continue;
    if (span.startAt > at) free.push({ startAt: at, endAt: Math.min(span.startAt, to) });
    at = Math.max(at, span.endAt);
    if (at >= to) break;
  }
  if (at < to) free.push({ startAt: at, endAt: to });
  return free;
}

/** The earliest grid start in `free` within [lo, hi) that holds `length`. */
function firstFit(free: Span[], lo: number, hi: number, length: number): number | undefined {
  for (const span of free) {
    const start = ceilGrid(Math.max(span.startAt, lo));
    if (start + length <= Math.min(span.endAt, hi)) return start;
  }
  return undefined;
}

/** Plans one day (see the header). */
export function planDay(input: PlanInput): PlanOutput {
  const { date, tz, now } = input;
  const dayStart = zonedTime(date, 0, tz);
  const dayEnd = zonedTime(addDays(date, 1), 0, tz);
  const workStartMin = clockMinutes(input.workStart) ?? 8 * 60;
  const workEndMin = clockMinutes(input.workEnd) ?? 20 * 60;
  const workFrom = zonedTime(date, workStartMin, tz);
  const workTo = zonedTime(date, workEndMin, tz);
  const buffer = Math.min(Math.max(Math.round(input.bufferMin) || 0, 0), MAX_BUFFER_MIN) * MIN;
  const todoIds = new Set(input.todos.map((todo) => todo.taskId));
  const blockOf = new Map(input.blocks.filter((block) => block.taskId && todoIds.has(block.taskId)).map((block) => [block.taskId!, block]));
  const taken: Span[] = [...input.busy, ...input.blocks.filter((block) => !block.taskId || !todoIds.has(block.taskId))];
  const candidates: Candidate[] = [];
  const weekday = weekdayOf(date);

  for (const todo of input.todos) {
    const minutes = Math.min(Math.max(Math.round(todo.estimateMin) || 0, 5), 24 * 60);
    const block = blockOf.get(todo.taskId);
    if (todo.window?.days?.length && !todo.window.days.includes(weekday)) { // not on this weekday: not this day's
      if (block) taken.push(block);
      continue;
    }
    if (block) {
      const onDay = block.startAt < dayEnd && block.endAt > dayStart;
      const planners = block.setBy === 'planner' && block.state === 'planned';
      if (onDay && planners && input.mode === 'replan' && block.startAt > now) candidates.push({ todo, minutes, moved: true });
      else if (!onDay && block.endAt <= dayStart && block.endAt <= now) candidates.push({ todo, minutes, moved: true }); // ended on an earlier day
      else if (block.state !== 'planned') candidates.push({ todo, minutes, moved: true }); // ticked, then reopened: it holds no time
      else taken.push(block); // fixed (or on another day, where it does not matter)
      continue;
    }
    const day = todo.window?.date;
    if (day ? day > date : firstDayOf(todo.createdAt, tz, workEndMin) > date) continue; // a later day's
    candidates.push({ todo, minutes, moved: false });
  }

  // A busy list that names every timed row also holds the movable blocks being placed again: one span each goes.
  for (const candidate of candidates.filter((c) => c.moved)) {
    const block = blockOf.get(candidate.todo.taskId)!;
    const index = taken.findIndex((span) => span !== block && span.startAt === block.startAt && span.endAt === block.endAt && !('setBy' in span));
    if (index >= 0) taken.splice(index, 1);
  }
  const from = Math.max(workFrom, ceilGrid(now));
  let free = from < workTo ? freeSpans(from, workTo, taken.map((span) => ({ startAt: span.startAt - buffer, endAt: span.endAt + buffer }))) : [];
  const longest = free.reduce((max, span) => Math.max(max, span.endAt - span.startAt), 0);
  const rank = (c: Candidate) => (c.todo.dueAt !== undefined && c.todo.dueAt < dayEnd ? 0 : 1);
  const hasHours = (c: Candidate) => (c.todo.window?.notBefore || c.todo.window?.notAfter ? 0 : 1);
  candidates.sort((a, b) => rank(a) - rank(b) || b.todo.priority - a.todo.priority || (a.todo.dueAt ?? Infinity) - (b.todo.dueAt ?? Infinity)
    || hasHours(a) - hasHours(b) || a.minutes - b.minutes || a.todo.createdAt - b.todo.createdAt); // stable: ties keep the caller's order

  const out: PlanOutput = { placements: [], released: [], unplanned: [] };
  for (const candidate of candidates) {
    const { todo, minutes, moved } = candidate;
    const length = minutes * MIN;
    const notBefore = todo.window?.notBefore ? clockMinutes(todo.window.notBefore) : undefined;
    const notAfter = todo.window?.notAfter ? clockMinutes(todo.window.notAfter) : undefined;
    const lo = notBefore === undefined ? from : Math.max(from, zonedTime(date, notBefore, tz));
    const hi = notAfter === undefined ? workTo : Math.min(workTo, zonedTime(date, notAfter, tz));
    const start = firstFit(free, lo, hi, length);
    if (start !== undefined) {
      out.placements.push({ taskId: todo.taskId, startAt: start, endAt: start + length, moved });
      free = cut(free, { startAt: start - buffer, endAt: start + length + buffer });
      continue;
    }
    if (moved) out.released.push(todo.taskId);
    out.unplanned.push({ taskId: todo.taskId, reason: reasonFor({ date, tz, now, from, workFrom, workTo, longest, length, notBefore, notAfter, today: dayStart <= now && now < dayEnd }) });
  }
  return out;
}

/** `free` without `span`. */
function cut(free: Span[], span: Span): Span[] {
  return free.flatMap((f) => (f.endAt <= span.startAt || f.startAt >= span.endAt ? [f] : [
    ...(f.startAt < span.startAt ? [{ startAt: f.startAt, endAt: span.startAt }] : []),
    ...(f.endAt > span.endAt ? [{ startAt: span.endAt, endAt: f.endAt }] : []),
  ]));
}

interface ReasonInput {
  date: string; tz: string; now: number; from: number; workFrom: number; workTo: number; longest: number; length: number;
  notBefore?: number; notAfter?: number; today: boolean;
}

/** Why a to-do found no place (short UI text). */
function reasonFor(r: ReasonInput): string {
  const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  if (r.from >= r.workTo) return r.today ? 'Your working hours are over for today' : 'This day is over';
  if (r.notBefore !== undefined || r.notAfter !== undefined) {
    const hours = r.notBefore !== undefined && r.notAfter !== undefined ? `${clock(r.notBefore)}–${clock(r.notAfter)}`
      : r.notBefore !== undefined ? `after ${clock(r.notBefore)}` : `before ${clock(r.notAfter!)}`;
    const windowFrom = r.notBefore === undefined ? r.workFrom : zonedTime(r.date, r.notBefore, r.tz);
    const windowTo = r.notAfter === undefined ? r.workTo : zonedTime(r.date, r.notAfter, r.tz);
    if (windowTo <= r.now) return `Its time today (${hours}) has passed`;
    if (windowFrom >= r.workTo || windowTo <= r.workFrom) return `Its hours (${hours}) are outside your working hours`;
    if (Math.min(windowTo, r.workTo) - Math.max(windowFrom, r.from) < r.length) return `Needs ${durationText(r.length / MIN)}; it can only be done ${hours}`;
    return `No free time ${hours.includes('–') ? `between ${hours.replace('–', ' and ')}` : hours}`;
  }
  if (r.longest === 0) return r.today ? 'No free time left today' : 'No free time that day';
  if (r.length > r.longest) return `Needs ${durationText(r.length / MIN)}; the longest free time is ${durationText(r.longest / MIN)}`;
  return r.today ? 'No free time left today' : 'No free time left that day';
}
