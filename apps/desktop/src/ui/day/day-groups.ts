// My day's groups (B-041 §4.1, contract §5.5), pure: which group each of the person's to-dos
// (store.todos, the todos.list query) is in for the day shown, in what order, and the handed-off
// rows. The one shared "Later" rule (shared/model/todo-later.ts isLater) decides Later; the
// calendar (the to-do → block join, lib/day-store.ts slotOf) decides Today:
//   Needs you – the shared rule (shared/model/todo-later.ts needsYou, also the badge's and the
//               briefing's count): what rang, overdue, and what an agent, the host or a colleague asks
//               of the person (it holds their work) – plus the to-do whose block runs now;
//   Today     – planned blocks of the day and timers ringing within 12 h, by time;
//   Unplanned – the person's own to-dos without a block;
//   Later     – snoozed, repeating waits, timers more than 12 h ahead, due or planned on a later day.
// Another day than today shows that day's blocks, and under Unplanned the to-dos for that day without a block
// (Task.window.date – typed while that day was shown, or "Morgen: …"); today lists such a to-do under Later.
// Owns: these rules (unit-tested in test/unit/day-ui/day-groups.test.ts). Never: imports the store,
// rpc or the DOM – callers pass data and the time in.

import type { CalendarEvent } from '../../shared/model/calendar.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { isLater, needsYou, timerAt, waitsForRing } from '../../shared/model/todo-later.ts';
import { compareTodos } from '../tasks/todo-time.ts';
import { stuckOf } from '../tasks/work-model.ts';

export interface DayGroups<T> { needsYou: T[]; today: T[]; unplanned: T[]; later: T[] }
export type DayGroupName = keyof DayGroups<unknown>;

export interface DayGroupInput {
  now: number;
  /** Local midnight of the day shown and of the day after it (the profile zone). */
  dayStart: number;
  dayEnd: number;
  /** True when the day shown is today (else only its blocks and the to-dos for it are listed). */
  isToday: boolean;
  /** The day shown (YYYY-MM-DD, profile zone): matches a to-do's window.date. */
  date?: string;
  /** The to-do → block join (lib/day-store.ts slotOf). */
  slots: ReadonlyMap<string, CalendarEvent>;
}

type Grouped = Pick<TaskView, 'id' | 'status' | 'assigneeKind' | 'waitingOn' | 'widget' | 'dueAt' | 'createdBy' | 'priority' | 'createdAt'> & Partial<Pick<TaskView, 'window'>>;

/** A planned block of the to-do (done or cut blocks no longer place it). */
function plannedSlot(task: Grouped, slots: ReadonlyMap<string, CalendarEvent>): CalendarEvent | undefined {
  const slot = slots.get(task.id);
  return slot && slot.state === 'planned' ? slot : undefined;
}

/** The person's own to-do (they wrote it) – everything else on the list someone asked of them. */
export function isOwnTodo(task: Pick<Task, 'createdBy'>): boolean {
  return task.createdBy === HUMAN_ID;
}

/** The group of one to-do on today's list. */
export function groupOf(task: Grouped, input: DayGroupInput): DayGroupName {
  const { now, dayEnd } = input;
  if (needsYou(task, now, dayEnd)) return 'needsYou';
  if (waitsForRing(task)) return 'later';
  const slot = plannedSlot(task, input.slots);
  if (slot && slot.startAt <= now && now < slot.endAt) return 'needsYou';
  if (slot && slot.startAt >= input.dayStart && slot.startAt < dayEnd) return 'today';
  if (slot && slot.startAt >= dayEnd) return 'later';
  if (!slot && input.date && task.window?.date && task.window.date > input.date) return 'later'; // for a later day
  if (timerAt(task) !== undefined && !isLater(task, now, dayEnd)) return 'today';
  if (isLater(task, now, dayEnd)) return 'later';
  return isOwnTodo(task) ? 'unplanned' : 'needsYou';
}

/** The time a Today row is sorted by: its block start, else its ring time. */
export function todayTime(task: Grouped, slots: ReadonlyMap<string, CalendarEvent>): number {
  return plannedSlot(task, slots)?.startAt ?? timerAt(task) ?? Number.MAX_SAFE_INTEGER;
}

/** My day's groups for the day shown: each in its order (Today by time, the rest in the calm to-do order). */
export function dayGroups<T extends Grouped>(list: readonly T[], input: DayGroupInput): DayGroups<T> {
  const out: DayGroups<T> = { needsYou: [], today: [], unplanned: [], later: [] };
  for (const task of list) {
    if (input.isToday) { out[groupOf(task, input)].push(task); continue; }
    const slot = input.slots.get(task.id);
    if (slot && slot.startAt < input.dayEnd && slot.endAt > input.dayStart) out.today.push(task);
    else if (!plannedSlot(task, input.slots) && input.date && task.window?.date === input.date && !waitsForRing(task)) out.unplanned.push(task);
  }
  const startOf = (task: T) => (input.isToday ? todayTime(task, input.slots) : input.slots.get(task.id)?.startAt ?? Number.MAX_SAFE_INTEGER);
  out.today.sort((a, b) => startOf(a) - startOf(b) || compareTodos(a, b));
  out.needsYou.sort(compareTodos);
  out.unplanned.sort(compareTodos);
  out.later.sort(compareTodos);
  return out;
}

// ------------------------------------------------------------------ handed off

export interface HandedOffRow<T> {
  task: T;
  /** "Mara working", "Prepared – your step: …", "Done ✓" … */
  text: string;
  /** The person's open step under it ("Prepared – your step"), shown in Needs you. */
  step?: T;
  done: boolean;
}

type HandedTask = Pick<TaskView, 'id' | 'title' | 'status' | 'assigneeKind' | 'assigneeId' | 'parentId' | 'updatedAt'> & Parameters<typeof stuckOf>[0];

/**
 * The handed-off rows (lib/day-store.ts handedOff: what the person created that others own): its
 * owner and state – the person's own open step under it first ("Prepared – your step: …"), done
 * ones last. "Stuck" is Work's rule (tasks/work-model.ts stuckOf) at `now`. `nameOf` names an
 * agent, a person or the team.
 */
export function handedOffRows<T extends HandedTask>(
  handed: readonly T[], todos: readonly T[], nameOf: (task: T) => string | undefined, now: number,
): Array<HandedOffRow<T>> {
  const stepOf = new Map<string, T>();
  for (const todo of todos) if (todo.parentId && !stepOf.has(todo.parentId)) stepOf.set(todo.parentId, todo);
  const rows = handed.map((task): HandedOffRow<T> => {
    const done = task.status === 'done';
    const step = done ? undefined : stepOf.get(task.id);
    const name = nameOf(task);
    let text: string;
    if (done) text = 'Done ✓';
    else if (step) text = `Prepared – your step: ${step.title}`;
    else if (!name && task.status !== 'blocked' && task.status !== 'needs_you') text = 'Not assigned yet'; // Work: stuck, "No owner yet"
    else if (stuckOf(task, now)) text = 'Stuck';
    else if (task.status === 'needs_you') text = 'Needs you';
    else if (!name) text = 'Not assigned yet';
    else if (task.status === 'working') text = `${name} working`;
    else if (task.status === 'waiting') text = `${name} waiting`;
    else text = `With ${name}`;
    return { task, text, done, ...(step ? { step } : {}) };
  });
  const rank = (row: HandedOffRow<T>) => (row.step || row.text === 'Stuck' || row.text === 'Needs you' ? 0 : row.done ? 2 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || b.task.updatedAt - a.task.updatedAt);
}
