// Planning one day of My day (B-041 track A2, contract §5.7): day.plan and the morning run. Connected calendars
// sync first (calendarSources.sync 'plan', when there are any – a failed sync never stops the plan); then the
// person's open to-dos that belong in a calendar – their own, and the steps that need them somewhere in person
// (humanReason 'physical'); never a host card, a timer that rings by itself or a mini-app – with their estimates
// (the stored one, else the learned rule), the day's busy spans and every task block go to calendar/planner.ts
// planDay, and its placements become planner blocks (calendar.upsertBlock 'planner'); a movable block that found
// no new place goes, so its to-do shows as unplanned. Planning the local today records kv day/planned:<member>
// (the morning run never plans that day again). Sources not synced for more than a day are reported.
// A person-set block the planner moves on (it ended unticked on an earlier day – calendar/planner.ts) is replaced
// by a planner block.
// Owns: gathering the plan's input and applying its result. Never: moves a person- or agent-set block that has
// not ended, or fails the plan because a source could not sync.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import type { CalendarEvent, DayPlanMode, DayPlanResult } from '../../shared/model/calendar.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { planDay, type PlanBlock, type PlanTodo } from '../calendar/planner.ts';
import { localDate } from '../calendar/when.ts';
import { KvRepo } from '../store/kv.ts';
import { dayBounds, dayZone, daySettings } from './clock.ts';

export type PlanDeps = Pick<RuntimeServices, 'db' | 'clock' | 'settings' | 'tasks' | 'chats' | 'log'>
  & Partial<Pick<RuntimeServices, 'calendar' | 'calendarSources' | 'estimates'>>;

/** kv of the morning run's idempotency key: day / planned:<member> = the local date planned last. */
export const PLANNED_KV = { ns: 'day', key: (ownerId: string) => `planned:${ownerId}` } as const;
const STALE_MS = 24 * 60 * 60_000;
const MAX_TODOS = 1000;

/** A to-do that belongs in the calendar: open, the person's own or a step that needs them there; no host card, ring or mini-app. */
export function plannable(task: TaskView): boolean {
  if (task.assigneeKind !== 'human' || task.status !== 'open') return false;
  if (task.widget?.type === 'timer' || appWidgetOf(task.widget)) return false;
  return isHumanActor(task.createdBy) || (task.createdBy !== SYSTEM_ID && task.humanReason === 'physical');
}

const asBlock = (event: CalendarEvent): PlanBlock => ({ ...(event.taskId ? { taskId: event.taskId } : {}), startAt: event.startAt, endAt: event.endAt, setBy: event.setBy, state: event.state });

/** Oldest first; to-dos made in the same moment (one dictation) in the order of their anchors in the chat. */
function inDictatedOrder(s: Pick<PlanDeps, 'chats'>, tasks: TaskView[]): TaskView[] {
  const seqs = new Map<string, number>();
  const seq = (task: TaskView) => {
    if (!seqs.has(task.id)) {
      let value = 0;
      try { value = task.messageId ? s.chats.message(task.messageId)?.seq ?? 0 : 0; } catch { value = 0; }
      seqs.set(task.id, value);
    }
    return seqs.get(task.id)!;
  };
  return [...tasks].sort((a, b) => a.createdAt - b.createdAt || seq(a) - seq(b));
}

/** The local date the morning run or the person last planned for `ownerId`. */
export function plannedDate(s: Pick<RuntimeServices, 'db'>, ownerId: string): string | undefined {
  try { return new KvRepo(s.db).get<string>(PLANNED_KV.ns, PLANNED_KV.key(ownerId)); } catch { return undefined; }
}

export async function planFor(s: PlanDeps, ownerId: string, date: string, mode: DayPlanMode): Promise<DayPlanResult> {
  const calendar = s.calendar;
  if (!calendar) throw new WorkforceError('unavailable', 'The calendar is not available yet.', { details: { service: 'calendar' } });
  if (s.calendarSources && s.calendarSources.list(ownerId).length) {
    try { await s.calendarSources.sync(undefined, 'plan'); } catch (error) { s.log.warn('my day: calendars did not sync before planning', { error: String(error) }); }
  }
  const tz = dayZone(s);
  const settings = daySettings(s);
  const now = s.clock.now();
  const { start, end } = dayBounds(date, tz);
  const todos = inDictatedOrder(s, s.tasks.todos(MAX_TODOS).filter(plannable));
  const own = calendar.blocksFor(todos.map((task) => task.id));
  const listed = calendar.list(ownerId, start, end);
  const others = listed.events.filter((event) => event.kind === 'todo' && !(event.taskId && own.has(event.taskId)));
  const out = planDay({
    date, tz, now, mode, workStart: settings.workStart, workEnd: settings.workEnd, bufferMin: settings.bufferMin,
    busy: calendar.busy(ownerId, start, end), blocks: [...own.values(), ...others].map(asBlock),
    todos: todos.map((task): PlanTodo => ({
      taskId: task.id, estimateMin: task.estimateMin ?? s.estimates?.estimateFor({ ownerId, title: task.title }).minutes ?? 30,
      priority: task.priority, createdAt: task.createdAt, ...(task.dueAt !== undefined ? { dueAt: task.dueAt } : {}), ...(task.window ? { window: task.window } : {}),
    })),
  });
  const result: DayPlanResult = { date, placed: [], moved: [], unplanned: [...out.unplanned], staleSources: [] };
  for (const placement of out.placements) {
    try {
      const old = placement.moved ? own.get(placement.taskId) : undefined;
      if (old?.setBy === 'person') calendar.remove(old.id, SYSTEM_ID); // ended unticked: the planner places the to-do anew
      const event = calendar.upsertBlock(placement.taskId, placement.startAt, placement.endAt, 'planner');
      (placement.moved ? result.moved : result.placed).push(event.id);
    } catch (error) {
      s.log.warn('my day: a planned block was refused', { taskId: placement.taskId, error: String(error) });
      result.unplanned.push({ taskId: placement.taskId, reason: 'Could not be placed' });
    }
  }
  for (const taskId of out.released) {
    const block = own.get(taskId);
    if (!block) continue;
    try { calendar.remove(block.id, SYSTEM_ID); } catch (error) { s.log.warn('my day: an old block stayed', { taskId, error: String(error) }); }
  }
  if (date === localDate(now, tz)) {
    try { new KvRepo(s.db).set(PLANNED_KV.ns, PLANNED_KV.key(ownerId), date, now); } catch (error) { s.log.warn('my day: plan not recorded', { error: String(error) }); }
  }
  result.staleSources = staleSources(s, ownerId, now, listed.staleSources);
  return result;
}

/** Sources not synced for more than a day (or failing), plus what the calendar itself reported. */
function staleSources(s: Pick<PlanDeps, 'calendarSources' | 'log'>, ownerId: string, now: number, reported: readonly string[]): string[] {
  const stale = new Set(reported);
  try {
    for (const source of s.calendarSources?.list(ownerId) ?? []) {
      if (!source.visible) continue;
      if (source.status === 'error' || source.status === 'reconnect' || source.lastSyncAt === undefined || now - source.lastSyncAt > STALE_MS) stale.add(source.id);
    }
  } catch (error) {
    s.log.debug('my day: sources not readable', { error: String(error) });
  }
  return [...stale];
}
