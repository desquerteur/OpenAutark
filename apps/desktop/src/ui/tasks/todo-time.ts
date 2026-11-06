// The calm "For you" list's order and time rules (F04, re-exported by tasks/model.ts): which
// to-dos are on it, ring now or wait under "Later" (shared/model/todo-later.ts, the same rules the
// runtime's readers of todos.list use), the order (binding approvals → ringing → due → priority →
// age), a timer's row time ("Tomorrow 09:00") and its quiet countdown in the last hour, a "Later"
// row's time without schedules, the next moment any row reads differently (the store's For-you
// clock) and the snooze choices every to-do offers (B-041: "Tomorrow" at the start of the working
// day, read across the 04:00 day boundary). A snooze's end from its schedule (snoozeEnd) is the
// shared rule, re-exported here.
// Owns: these rules (unit-tested in test/unit/ui/tasks-later.test.ts and tasks-model.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data and the time in, so tests run in Node.

import type { Task } from '../../shared/model/tasks.ts';
import { DAY_BOUNDARY_HOUR, clockMinutes } from '../../shared/model/day-settings.ts';
import { LATER_MS, isLater, isRinging, isSnoozed, onForYouList, snoozedUntil, timerAt, waitsForRing } from '../../shared/model/todo-later.ts';
import { locale, shortDate, time } from '../lib/format.ts';
import { DAY_MS } from './todo-model.ts';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

export {
  LATER_MS, SNOOZED_REASON, countNow, endOfToday, isLater, isRinging, isSnoozed, onForYouList, snoozeEnd, snoozedUntil, timerAt, waitsForRing,
} from '../../shared/model/todo-later.ts';

type Listed = Pick<Task, 'assigneeKind' | 'status' | 'waitingOn' | 'widget' | 'dueAt'>;

// ------------------------------------------------------------------ order and split

type TodoSortable = Pick<Task, 'priority' | 'dueAt' | 'createdAt'> & Partial<Pick<Task, 'widget' | 'createdBy' | 'status' | 'assigneeKind'>>;

/** The calm My day order: ringing → due ↑ (none last) → priority ↓ → age. */
export function compareTodos(a: TodoSortable, b: TodoSortable): number {
  const rank = (task: TodoSortable) => (task.status !== undefined && isRinging({ status: task.status, assigneeKind: task.assigneeKind ?? 'human' }) ? 0 : 1);
  return rank(a) - rank(b)
    || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
    || b.priority - a.priority
    || a.createdAt - b.createdAt;
}

export interface LaterSplit<T> { now: T[]; later: T[] }

/** The list now and its collapsed "Later" part, each in the calm order (`dayEnd`: where today ends, default the local midnight). */
export function splitLater<T extends TodoSortable & Listed>(list: readonly T[], now: number, dayEnd?: number): LaterSplit<T> {
  const out: LaterSplit<T> = { now: [], later: [] };
  for (const task of list) (isLater(task, now, dayEnd) ? out.later : out.now).push(task);
  out.now.sort(compareTodos);
  out.later.sort(compareTodos);
  return out;
}

// ------------------------------------------------------------------ ring times

/** The quiet countdown in the last hour before `at`, rounded up to whole minutes; else undefined. */
export function countdownMs(at: number, now: number): number | undefined {
  const left = at - now;
  if (left <= 0 || left > HOUR_MS) return undefined;
  return Math.ceil(left / MINUTE_MS) * MINUTE_MS;
}

const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });

function dayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A ring time in a row: "17:00" today, "Tomorrow 09:00", "Mon 09:00" this week, else "24.10 09:00". */
export function whenText(at: number, now: number): string {
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY_MS);
  const day = days === 0 ? '' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : days > 1 && days < 7 ? weekday.format(at) : shortDate(at);
  return day ? `${day} ${time(at)}` : time(at);
}

/**
 * A "Later" row's time where no schedule is at hand (the PWA's offline list): "Snoozed until
 * Mon 09:00" (the end the snooze recorded, shared/model/todo-later.ts snoozedUntil), "Snoozed"
 * without one, else the ring time ("Tomorrow 09:00"); undefined for a to-do without a timer.
 */
export function laterText(task: Listed, now: number): string | undefined {
  if (isSnoozed(task)) {
    const until = snoozedUntil(task);
    return until === undefined ? 'Snoozed' : `Snoozed until ${whenText(until, now)}`;
  }
  const at = timerAt(task);
  return at === undefined ? undefined : whenText(at, now);
}

/**
 * The next moment lib/format.ts `relative(at, ·)` reads differently ("in 3 hours" → "in 2 hours",
 * "now" → "1 minute ago"): it says "now" within a minute and rounds to minutes within an hour,
 * hours within a day, else days. Always after `now`.
 */
export function relativeChange(at: number, now: number): number {
  const diff = at - now;
  const abs = Math.abs(diff);
  const unit = abs < MINUTE_MS ? 0 : abs < HOUR_MS ? MINUTE_MS : abs < DAY_MS ? HOUR_MS : DAY_MS;
  // Crossing a range edge ("in 1 minute" → "now" → "1 minute ago", "in 60 minutes" → "in 1 hour" …)
  const steps = [MINUTE_MS, HOUR_MS, DAY_MS].flatMap((range) => [at - range + 1, at + range]);
  // or the rounded number dropping, just after the time is half a unit below it.
  if (unit) steps.push(at - (Math.round(diff / unit) - 0.5) * unit + 1);
  return Math.min(...steps.filter((step) => step > now));
}

function nextMidnight(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/**
 * The next moment the list reads differently by time alone: a timer comes within 12 h (leaves
 * "Later"), within a day (the "soon" tone), its countdown starts or moves by a minute, it rings,
 * its "2 minutes ago" moves on; a due time comes within a day, passes, or its "in 3 hours" moves
 * on; a day word ("Tomorrow 09:00", "Snoozed until Mon 09:00") changes at midnight. A snoozed
 * to-do comes back with its ring (an event). Undefined: nothing changes.
 */
export function nextListChange(list: ReadonlyArray<Listed & Pick<Task, 'dueAt'>>, now: number): number | undefined {
  let next = Number.POSITIVE_INFINITY;
  const consider = (at: number) => { if (at > now && at < next) next = at; };
  let days = false;
  for (const task of list) {
    if (!onForYouList(task)) continue;
    if (isSnoozed(task)) { days = true; continue; }
    const at = timerAt(task);
    if (at === undefined) {
      if (task.dueAt === undefined) continue;
      if (task.dueAt >= nextMidnight(now)) days = true; // due on a later day: it leaves "Later" at midnight
      consider(task.dueAt - DAY_MS);
      consider(task.dueAt);
      consider(relativeChange(task.dueAt, now));
      continue;
    }
    days = true;
    const left = at - now;
    if (left > LATER_MS && !isRinging(task) && !waitsForRing(task)) consider(at - LATER_MS);
    consider(at - DAY_MS);
    if (left > HOUR_MS) consider(at - HOUR_MS);
    else if (left > 0) consider(at - (Math.ceil(left / MINUTE_MS) - 1) * MINUTE_MS);
    else consider(relativeChange(at, now));
  }
  if (days) consider(nextMidnight(now));
  return Number.isFinite(next) ? next : undefined;
}

// ------------------------------------------------------------------ snooze

/**
 * The start of the person's next working day after `now`: `workStart` ('HH:MM', default 08:00)
 * tomorrow – before DAY_BOUNDARY_HOUR (04:00) the night still belongs to the day before, so
 * "tomorrow" is the coming morning of the same date. Local time.
 */
export function nextMorning(now: number, workStart = '08:00'): number {
  const minutes = clockMinutes(workStart) ?? 8 * 60;
  const date = new Date(now);
  if (date.getHours() >= DAY_BOUNDARY_HOUR) date.setDate(date.getDate() + 1);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

/** The snooze choices (the Timer widget and every to-do's menu): in 10 minutes, in 1 hour, tomorrow at the start of work. */
export function snoozeChoices(now: number, workStart = '08:00'): Array<{ label: string; until: number }> {
  const morning = nextMorning(now, workStart);
  return [
    { label: 'In 10 minutes', until: now + 10 * MINUTE_MS },
    { label: 'In 1 hour', until: now + HOUR_MS },
    { label: `Tomorrow ${time(morning)}`, until: morning },
  ];
}
