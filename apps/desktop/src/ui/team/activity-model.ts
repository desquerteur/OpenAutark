// Activity, pure: one row per member – people and agents side by side – with what they finished today, what they are on
// right now, how much is open and how much is stuck; plus the totals line. Robin's "Dashboard über alles, was alle machen":
// the owner's admin overview. Stuck is Work's rule (tasks/work-model.ts stuckOf: blocked, stopped by the person, waiting
// longer than two days, escalated) and, for a human, work past its due time (a timer is never stuck – it rings). Working
// now: an agent's live run (its task's title, else what started it, the origin's label, else the run's note, else
// "Working"; the live note beside it when it says more; its own turn, never one of its splits); a person's task marked
// working or with a running focus timer. Open counts all open work given to the member except what waits for a ring
// (snoozed, a repeating timer between rings). Work nobody owns yet (team work the router still has to place) is a row of
// its own ({ id: 'team', kind: 'team' } – "No owner yet"), so the totals match Work and Home. The caller may narrow what
// is counted to Work's own scope (`counted`, ActivityView: tasks/work-model.ts onWork – the viewer's own to-dos are My
// day's, not Work's): done today, open and stuck then say what Work, Home and a count's link show; "now" still sees every
// task (a focus timer on an own to-do).
// Owns: these rules (unit-tested in test/unit/team-view/activity-model.test.ts). Never: imports the store, rpc or the DOM,
// or loads anything – callers pass the store's tasks, the done store and the live runs in.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { waitsForRing } from '../../shared/model/todo-later.ts';
import { finishedAt, stuckOf } from '../tasks/work-model.ts';

/** A member's row – or, kind 'team' (id 'team', Work's owner filter for no owner), the work nobody owns yet. */
export interface ActivityMember { id: string; kind: 'person' | 'agent' | 'team' }

/** The "No owner yet" row's member. */
export const NO_OWNER: ActivityMember = Object.freeze({ id: 'team', kind: 'team' });

export interface ActivityNow {
  title: string;
  /** The live run's own words when they differ from the title ("Reading the invoice"). */
  note?: string;
  taskId?: string;
  conversationId?: string;
}

export interface ActivityRow {
  member: ActivityMember;
  doneToday: number;
  now?: ActivityNow;
  open: number;
  stuck: number;
}

export interface ActivityInput {
  /** The store's open tasks. */
  open: readonly TaskView[];
  /** The caller's to-dos (steps included). */
  todos: readonly TaskView[];
  /** Finished tasks loaded so far (the done store, loaded from `dayStart`). */
  done: readonly TaskView[];
  /** Live runs (store.activity). */
  live: readonly AgentActivity[];
  now: number;
  /** Start of today (local midnight in the profile's zone). */
  dayStart: number;
  /** What the counts include (default: everything; ActivityView: Work's scope). */
  counted?: (task: TaskView) => boolean;
}

/** True when `task` is given to the human `personId` ('human' = the caller, whose own to-dos may carry no id). */
function assignedToPerson(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, personId: string): boolean {
  return task.assigneeKind === 'human' && (task.assigneeId ?? HUMAN_ID) === personId;
}

/** The store's open tasks and the caller's to-dos (steps included) as one list, each task once. */
function openWork(open: readonly TaskView[], todos: readonly TaskView[]): TaskView[] {
  const byId = new Map<string, TaskView>();
  for (const task of open) byId.set(task.id, task);
  for (const task of todos) if (!byId.has(task.id)) byId.set(task.id, task);
  return [...byId.values()];
}

/** True when `task` belongs to `member`: an agent's by assignee id, a person's by theirs. */
export function ownedByMember(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, member: ActivityMember): boolean {
  if (member.kind === 'team') return task.assigneeKind === 'team';
  return member.kind === 'agent' ? task.assigneeKind === 'agent' && task.assigneeId === member.id : assignedToPerson(task, member.id);
}

/** Stuck: Work's rule (stuckOf) – or a human's work past its due time; never what waits for a ring (a snooze, a timer). */
export function isStuck(task: Parameters<typeof stuckOf>[0] & Pick<Task, 'dueAt' | 'widget'>, now: number): boolean {
  if (waitsForRing(task)) return false;
  if (stuckOf(task, now)) return true;
  return task.assigneeKind === 'human' && task.widget?.type !== 'timer' && task.dueAt !== undefined && task.dueAt < now;
}

function nowOf(member: ActivityMember, mine: readonly TaskView[], input: ActivityInput): ActivityNow | undefined {
  if (member.kind === 'agent') {
    const run = input.live.find((entry) => entry.agentId === member.id && !entry.split); // a split is not the agent's own work
    if (!run) return undefined;
    const task = run.taskId ? mine.find((entry) => entry.id === run.taskId) ?? input.open.find((entry) => entry.id === run.taskId) : undefined;
    const label = task?.title ?? run.origin?.label; // a chat-free run without a task says what started it
    const title = label || run.note || 'Working';
    return {
      title, ...(label && run.note && run.note !== title ? { note: run.note } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}), conversationId: run.conversationId,
    };
  }
  const busy = mine.filter((task) => task.timerStartedAt !== undefined || task.status === 'working')
    .sort((a, b) => (b.timerStartedAt ?? 0) - (a.timerStartedAt ?? 0) || b.updatedAt - a.updatedAt)[0];
  return busy ? { title: busy.title, taskId: busy.id, conversationId: busy.conversationId } : undefined;
}

/** One row per member, in the order given. */
export function activityRows(members: readonly ActivityMember[], input: ActivityInput): ActivityRow[] {
  const open = openWork(input.open, input.todos).filter((task) => task.status !== 'done' && task.status !== 'cancelled' && !waitsForRing(task));
  const counts = input.counted ?? (() => true);
  return members.map((member) => {
    const mine = open.filter((task) => ownedByMember(task, member));
    const counted = mine.filter(counts);
    const doneToday = input.done.filter((task) => task.status === 'done' && ownedByMember(task, member) && finishedAt(task) >= input.dayStart && counts(task)).length;
    const now = nowOf(member, mine, input);
    return { member, doneToday, ...(now ? { now } : {}), open: counted.length, stuck: counted.filter((task) => isStuck(task, input.now)).length };
  });
}

export interface ActivityTotals { doneToday: number; working: number; open: number; stuck: number }

/** The line above the rows: done today, members working now, open and stuck work across everyone. */
export function activityTotals(rows: readonly ActivityRow[]): ActivityTotals {
  return rows.reduce<ActivityTotals>((sum, row) => ({
    doneToday: sum.doneToday + row.doneToday,
    working: sum.working + (row.now ? 1 : 0),
    open: sum.open + row.open,
    stuck: sum.stuck + row.stuck,
  }), { doneToday: 0, working: 0, open: 0, stuck: 0 });
}
