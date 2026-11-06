// Arming of human to-do widgets (F02): one step for every way a to-do with a widget is made or
// changed – an ask block in a message, a typed to-do, human.ask, the tasks.create/update RPC,
// "Show as…" – so a timer always rings and a widget always renders:
//  * prepareWidget (pure): an agent's widget goes through the catalog's validation with
//    coercion (invalid → a precise 'bad_request' the agent gets back); widgets the runtime built
//    itself (typed to-dos, "Show as…", the verifier's review to-do) are kept as they are. A timer's duration ("PT10M") becomes an
//    absolute `at` from the creation time (the duration stays for display), and that `at` is the
//    to-do's due time unless one was given – a due time the old timer set moves with a new one
//    (dueAfter);
//  * armTimer: the widget's ring – the human 'timer' schedule of a timer to-do (marked
//    payload.ring 'widget'), at most one per to-do; a changed time or repeat moves it (also after
//    it rang), an unchanged one stays as it is, and a widget that is no longer a timer drops it.
//    A pending snooze (tasks/human.ts) is never taken for the widget's ring;
//  * F03: dropTimers (a finished to-do stops ringing; cancel and "Stop repeating" end a
//    repeating timer too), repeatingTimer, snoozeUntil (a snooze answer → when), snoozeChanged
//    (INT-1: a snoozed to-do's recorded end follows the person pausing, resuming or deleting its ring).
// Owns: those rules. Never: arms agent tasks, or creates a second widget ring for a to-do.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { validateBlock } from '../../shared/blocks/validate.ts';
import type { Schedule, ScheduleSpec, Task } from '../../shared/model/tasks.ts';
import { isSnoozed, snoozeEnd } from '../../shared/model/todo-later.ts';
import type { RuntimeServices } from '../contracts.ts';
import { isAskBlock, parseDue } from './widgets.ts';

/** A widget ring's payload carries `ring: 'widget'`; a snooze's ring has none. */
type RingPayload = Schedule['payload'] & { ring?: 'widget' };
/** waitingOn.reason of a snoozed to-do (tasks/human.ts snooze). */
const SNOOZED = 'Snoozed';

/**
 * The widget as stored and the due time it implies. `by` is who made it: an agent's widget is
 * validated; the person's and the system's are the runtime's own.
 */
export function prepareWidget(widget: UiBlock, from: number, by: string): { widget: UiBlock; dueAt?: number } {
  let block = widget;
  if (by !== HUMAN_ID && by !== SYSTEM_ID) {
    const checked = validateBlock(widget);
    if (!checked.ok) throw new WorkforceError('bad_request', `Invalid ${widget.type ?? 'widget'} widget: ${checked.error}.`, { details: { param: 'widget' } });
    if (!isAskBlock(checked.block)) throw new WorkforceError('bad_request', `A to-do needs an ask widget, not "${checked.block.type}".`, { details: { param: 'widget' } });
    const { todo: _ingestOnly, ...rest } = checked.block; // "todo" only steers ingestBlocks
    block = rest as UiBlock;
  }
  if (block.type !== 'timer') return { widget: block };
  const at = parseDue(block.at, from) ?? parseDue(block.duration, from);
  if (at === undefined) return { widget: block };
  return { widget: { ...block, at: new Date(at).toISOString() }, dueAt: at };
}

/**
 * timer{at, repeat?} → the widget's ring: the human 'timer' schedule linked to the to-do (one per
 * to-do). Called after every widget change: a new time or repeat moves the ring (and arms it
 * again after it rang), the same one leaves it alone (a past one-off `at` would fire late
 * again), and a widget that is no longer a timer – or has no time – drops it.
 */
export function armTimer(s: Partial<Pick<RuntimeServices, 'scheduler'>>, task: Pick<Task, 'id' | 'conversationId' | 'title' | 'assigneeKind' | 'widget' | 'waitingOn'>): void {
  const scheduler = s.scheduler;
  if (!scheduler || task.assigneeKind !== 'human') return;
  const rings = scheduler.list({ taskId: task.id }).filter((schedule) => isWidgetRing(schedule, task));
  const spec = ringSpec(task.widget);
  const same = spec ? rings.find((ring) => ring.spec.at === spec.at && ring.spec.cron === spec.cron) : undefined;
  const kept = spec ? same ?? rings[0] : undefined;
  for (const ring of rings) if (ring !== kept) scheduler.remove(ring.id); // no longer a timer, or a duplicate
  if (!spec || same) return;
  const payload: RingPayload = { note: typeof task.widget?.label === 'string' ? task.widget.label : task.title, ring: 'widget' };
  if (kept) scheduler.update(kept.id, { spec, active: true, title: task.title, payload });
  else scheduler.create({ ownerId: HUMAN_ID, conversationId: task.conversationId, taskId: task.id, kind: 'timer', title: task.title, spec, payload });
}

/**
 * The due time after a widget change: a due time the old timer set (or none) follows the new
 * timer; one given explicitly stays.
 */
export function dueAfter(current: Pick<Task, 'dueAt' | 'widget'>, armed: { dueAt?: number }): number | undefined {
  if (armed.dueAt === undefined) return current.dueAt;
  const previous = current.widget?.type === 'timer' && typeof current.widget.at === 'string' ? Date.parse(current.widget.at) : undefined;
  return current.dueAt === undefined || current.dueAt === previous ? armed.dueAt : current.dueAt;
}

/** The ring schedule a timer widget asks for (`at` is absolute after prepareWidget). */
function ringSpec(block: UiBlock | undefined): ScheduleSpec | undefined {
  if (block?.type !== 'timer') return undefined;
  const at = typeof block.at === 'string' ? Date.parse(block.at) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const date = new Date(at);
  const cron = block.repeat === 'daily' ? `${date.getMinutes()} ${date.getHours()} * * *`
    : block.repeat === 'weekdays' ? `${date.getMinutes()} ${date.getHours()} * * 1-5`
    : block.repeat === 'weekly' ? `${date.getMinutes()} ${date.getHours()} * * ${date.getDay()}` : undefined;
  return cron ? { cron } : { at };
}

/**
 * The widget's ring, not a snooze: marked ones; an unmarked one (armed before the marker) unless
 * it may be the pending snooze – a one-off while the to-do is snoozed.
 */
function isWidgetRing(schedule: Schedule, task: Pick<Task, 'waitingOn'>): boolean {
  if (schedule.kind !== 'timer') return false;
  const ring = (schedule.payload as RingPayload).ring;
  if (ring !== undefined) return ring === 'widget';
  return schedule.spec.cron !== undefined || task.waitingOn?.reason !== SNOOZED;
}

/**
 * A finished or snoozed to-do stops ringing at the old time (F03): its one-shot timer schedules
 * go; with `all`, the repeating one too (cancel, "Stop repeating").
 */
export function dropTimers(s: Partial<Pick<RuntimeServices, 'scheduler'>>, taskId: string, all = false): void {
  const scheduler = s.scheduler;
  if (!scheduler) return;
  for (const schedule of scheduler.list({ taskId })) {
    if (schedule.kind === 'timer' && (all || 'at' in schedule.spec)) scheduler.remove(schedule.id);
  }
}

/** The repeating timer schedule of a to-do, if it has one. */
export function repeatingTimer(s: Partial<Pick<RuntimeServices, 'scheduler'>>, taskId: string) {
  return s.scheduler?.list({ taskId }).find((schedule) => schedule.kind === 'timer' && 'cron' in schedule.spec);
}

/** A legacy snooze answer ({event:'snoozed', minutes?|until?}) → when; undefined for other answers. */
export function snoozeUntil(answer: unknown, now: number): number | undefined {
  const value = answer && typeof answer === 'object' ? answer as Record<string, unknown> : undefined;
  if (value?.event !== 'snoozed') return undefined;
  if (typeof value.until === 'number' && Number.isFinite(value.until)) return value.until;
  if (typeof value.until === 'string' && Number.isFinite(Date.parse(value.until))) return Date.parse(value.until);
  const minutes = typeof value.minutes === 'number' && value.minutes > 0 ? Math.min(value.minutes, 7 * 24 * 60) : 10;
  return now + minutes * 60_000;
}

/**
 * After the person paused, resumed or deleted a schedule (schedules.update/delete – Chat details ›
 * Scheduled): a snoozed to-do's recorded end (waitingOn.until, what the surfaces without
 * schedules.list show) follows its pending ring – the next ring of an active one, none while it is
 * paused or gone. Agents cannot change the person's schedules (tools/builtin/schedule.ts).
 */
export function snoozeChanged(s: Pick<RuntimeServices, 'scheduler' | 'tasks'>, schedule: Pick<Schedule, 'kind' | 'taskId'>): void {
  if (schedule.kind !== 'timer' || !schedule.taskId) return;
  const task = s.tasks.get(schedule.taskId);
  if (!task?.waitingOn || !isSnoozed(task)) return;
  const until = snoozeEnd(s.scheduler.list({ taskId: task.id }), task.id);
  if (until === task.waitingOn.until) return;
  const { until: _previous, ...wait } = task.waitingOn;
  s.tasks.update(task.id, { waitingOn: until === undefined ? wait : { ...wait, until } }, HUMAN_ID);
}
