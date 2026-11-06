// Which of the person's to-dos are due now and which wait under "Later" (F04) – one rule for every
// surface that lists or counts what todos.list returns (runtime tasks/repo.ts todos): the app's
// For-you list and badge (ui/tasks/todo-time.ts re-exports these), and the runtime's own readers
// of TaskService.todos (the wf CLI). Under "Later": a to-do
// waiting for a ring (snoozed, or a repeating timer until its next time), a timer more than 12 h
// ahead that has not rung, and (B-041) any other to-do due on a later day – after the end of the
// local today (the caller's zone; My day passes the end of the day in the profile zone). A to-do
// that rang is never "Later". A snooze's end: its pending ring where the schedules are at hand
// (snoozeEnd), else the end its wait records (waitingOn.until, snoozedUntil – the offline list,
// the wf CLI); tasks/timers.ts snoozeChanged keeps that record in step when the person
// pauses, resumes or deletes the ring. A snooze without a recorded end reads as plain "Snoozed".
// "Needs you" (B-041, one rule for the badge, My day's Needs-you group and the morning briefing):
// what rang, what is overdue, and what an agent, the host or a colleague asks of the person – never a "Later" one.
// Owns: these pure rules. Never: reads a clock, the store or the database – callers pass data and
// the time in.

import { HUMAN_ID } from '../ids.ts';
import type { Schedule, Task } from './tasks.ts';

/** A timer further ahead than this waits under "Later". */
export const LATER_MS = 12 * 60 * 60_000;
/** waitingOn.reason of a snoozed to-do (tasks/human.ts snooze); a repeating timer waits with 'Repeats'. */
export const SNOOZED_REASON = 'Snoozed';

type Listed = Pick<Task, 'assigneeKind' | 'status' | 'waitingOn' | 'widget' | 'dueAt'>;
/** A listed to-do with who wrote it (a missing author counts as someone else) and its id (for approval pairs). */
type Counted = Listed & { createdBy?: string; id?: string; assigneeId?: string };

/** The first instant of the local day after the one `now` is in (this process's zone): where "today" ends. */
export function endOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/** The ring time of a timer to-do (its absolute `at`), else undefined. */
export function timerAt(task: Pick<Task, 'widget'>): number | undefined {
  const at = task.widget?.type === 'timer' && typeof task.widget.at === 'string' ? Date.parse(task.widget.at) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** Waits for a ring: snoozed, or a repeating timer ticked off until its next time. */
export function waitsForRing(task: Pick<Task, 'assigneeKind' | 'status' | 'waitingOn'>): boolean {
  return task.assigneeKind === 'human' && task.status === 'waiting' && task.waitingOn?.kind === 'schedule';
}

export function isSnoozed(task: Pick<Task, 'assigneeKind' | 'status' | 'waitingOn'>): boolean {
  return waitsForRing(task) && task.waitingOn?.reason === SNOOZED_REASON;
}

/**
 * When a snoozed to-do rings again, as its wait records it (waitingOn.until) – readable on every
 * surface, also where schedules.list is not allowed. Undefined when not snoozed, while its ring is
 * paused or gone, or when no end was recorded (then only the snooze schedule knows: snoozeEnd).
 */
export function snoozedUntil(task: Pick<Task, 'assigneeKind' | 'status' | 'waitingOn'>): number | undefined {
  const until = isSnoozed(task) ? task.waitingOn?.until : undefined;
  return typeof until === 'number' && Number.isFinite(until) ? until : undefined;
}

/**
 * When a snoozed to-do rings again: its pending one-shot timer schedule (snoozing drops the
 * widget's one-shot ring – tasks/timers.ts dropTimers – and a repeating ring has a cron spec).
 * Undefined while that ring is paused or after it was deleted.
 */
export function snoozeEnd(schedules: readonly Schedule[], taskId: string): number | undefined {
  let end: number | undefined;
  for (const schedule of schedules) {
    if (schedule.taskId !== taskId || schedule.kind !== 'timer' || !schedule.active || schedule.spec.at === undefined) continue;
    const at = schedule.nextAt ?? schedule.spec.at;
    if (end === undefined || at < end) end = at;
  }
  return end;
}

/** On the list (the rule of repo.todos): open, ringing or in progress – or waiting for a ring (under "Later"). */
export function onForYouList(task: Pick<Task, 'assigneeKind' | 'status' | 'waitingOn'> & { assigneeId?: string }): boolean {
  // F-52: a to-do with an assignee id belongs to another person (the caller's own have none, or 'human').
  if (task.assigneeId !== undefined && task.assigneeId !== 'human') return false;
  return task.assigneeKind === 'human' && (task.status === 'open' || task.status === 'needs_you' || task.status === 'working' || waitsForRing(task));
}

/** Rings now: its timer rang (schedules/fire.ts sets needs_you) or it otherwise needs the person now. */
export function isRinging(task: Pick<Task, 'assigneeKind' | 'status'>): boolean {
  return task.assigneeKind === 'human' && task.status === 'needs_you';
}

/**
 * Under "Later": waiting for a ring; a timer more than 12 h ahead that has not rung (its ring time
 * decides, not the day); any other to-do due at or after `dayEnd` (default: the end of the local
 * today). A to-do that rang needs the person now.
 */
export function isLater(task: Listed, now: number, dayEnd: number = endOfToday(now)): boolean {
  if (waitsForRing(task)) return true;
  if (isRinging(task)) return false;
  const at = timerAt(task);
  if (at !== undefined) return at - now > LATER_MS;
  return task.dueAt !== undefined && task.dueAt >= dayEnd;
}

/**
 * Needs the person now (My day's "Needs you", the badge, the briefing's "n need you"): what rang,
 * what is overdue, and what someone else (an agent, the host, a colleague)
 * asks of them – never a "Later" one. The person's own to-dos wait under Today or Unplanned; a
 * timer that has not rung waits under Today or Later. My day adds the to-do whose block runs now.
 */
export function needsYou(task: Counted, now: number, dayEnd: number = endOfToday(now)): boolean {
  if (isRinging(task)) return true;
  if (waitsForRing(task)) return false;
  if (task.dueAt !== undefined && task.dueAt < now) return true;
  if (isLater(task, now, dayEnd) || timerAt(task) !== undefined) return false;
  return task.createdBy !== HUMAN_ID;
}

/**
 * The badge (rail, phone tab, overlay; the briefing's "n need you"): the
 * to-dos on the list that need the person now (needsYou).
 * `running`: ids of to-dos whose calendar block runs now (My day lists them under Needs you too).
 */
export function countNow(list: readonly Counted[], now: number, dayEnd: number = endOfToday(now), running?: ReadonlySet<string>): number {
  let count = 0;
  for (const task of list) {
    if (!onForYouList(task)) continue;
    if (needsYou(task, now, dayEnd) || (task.id !== undefined && running?.has(task.id) && !waitsForRing(task))) count++;
  }
  return count;
}
