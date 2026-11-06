// The focus timer and the person's estimate of a to-do (B-041 track A2, the My day concept §4.3,
// §4.5): day.focus starts the timer (timerStartedAt; one runs at a time – starting another stops the running one)
// and stops it (its time joins spentMs); checking a to-do off or cancelling it stops it too (a task.upserted
// listener of the day service), and a finished to-do's measured time teaches the estimates once (≥ 1 min;
// day/estimates.ts 'actual'). day.setEstimate stores the person's minutes ('person') and teaches them as the
// correction that wins. Only the person's own list (assignee 'human', the owner's). A to-do given to someone else
// by any path (Work's owner field, Make it mine, sendToTeam) stops its running timer at once – its time so far
// joins spentMs and nothing is learned – and day.focus 'stop' clears a running timer whoever owns the task now.
// Owns: those writes. Never: touches an agent's task, a colleague's to-do, or the to-do's blocks.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { FocusAction } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';

export type FocusDeps = Pick<RuntimeServices, 'clock' | 'tasks' | 'log'> & Partial<Pick<RuntimeServices, 'estimates'>>;

const MIN = 60_000;
const MAX_LEARNED = 500;
const finished = (task: Pick<TaskView, 'status'>) => task.status === 'done' || task.status === 'cancelled';

/** On the person's own list (the owner's): assignee 'human', no other person's id. */
const isOwn = (task: Pick<TaskView, 'assigneeKind' | 'assigneeId'>) => task.assigneeKind === 'human' && (task.assigneeId === undefined || task.assigneeId === 'human');

/** The person's own to-do (the owner's list), or an error the RPC can show. */
export function ownTodo(s: Pick<RuntimeServices, 'tasks'>, taskId: string): TaskView {
  const task = s.tasks.get(taskId);
  if (!task) throw new WorkforceError('not_found', 'To-do not found.', { details: { taskId } });
  if (!isOwn(task)) {
    throw new WorkforceError('bad_request', 'Only your own to-dos have a focus timer and an estimate.', { details: { taskId } });
  }
  return task;
}

export class FocusTimer {
  private readonly s: FocusDeps;
  /** Finished to-dos whose time was learned in this run (a re-sent view of the same to-do teaches nothing more). */
  private readonly learned = new Set<string>();

  constructor(s: FocusDeps) { this.s = s; }

  focus(taskId: string, action: FocusAction, by: string): TaskView {
    const now = this.s.clock.now();
    const running = action === 'stop' ? this.s.tasks.get(taskId) : undefined;
    if (running?.timerStartedAt !== undefined) return this.stopped(running, now, by); // whoever owns it now
    const task = ownTodo(this.s, taskId);
    if (action === 'stop') return task.timerStartedAt === undefined ? task : this.stopped(task, now, by);
    if (finished(task)) throw new WorkforceError('conflict', 'This to-do is already finished.', { details: { taskId } });
    if (task.timerStartedAt !== undefined) return task;
    for (const other of this.s.tasks.todos(1000)) {
      if (other.id !== taskId && other.timerStartedAt !== undefined) this.stopped(other, now, by);
    }
    return this.s.tasks.update(taskId, { timerStartedAt: now }, by);
  }

  setEstimate(taskId: string, minutes: number, by: string): TaskView {
    const task = ownTodo(this.s, taskId);
    if (task.status === 'cancelled') throw new WorkforceError('conflict', 'This to-do was cancelled.', { details: { taskId } });
    const value = Math.min(Math.max(Math.round(minutes), 1), 24 * 60);
    const view = this.s.tasks.update(taskId, { estimateMin: value, estimateSource: 'person' }, by);
    this.s.estimates?.learn(task.assigneeId ?? 'human', task.title, value, 'person');
    return view;
  }

  /** task.upserted: a to-do finished with its timer running stops it at its finish; a done one teaches its time once. */
  onTask(task: TaskView): void {
    if (task.timerStartedAt !== undefined && !isOwn(task)) { // given to someone else: the timer stops, nothing is learned
      try { this.stopped(task, this.s.clock.now(), SYSTEM_ID); } catch (error) {
        this.s.log.warn('my day: the focus timer of a reassigned to-do did not stop', { taskId: task.id, error: String(error) });
      }
      return;
    }
    if (task.assigneeKind !== 'human' || !finished(task)) return;
    if (task.timerStartedAt !== undefined) {
      try { this.stopped(task, Math.max(task.timerStartedAt, task.completedAt ?? this.s.clock.now()), SYSTEM_ID); } catch (error) {
        this.s.log.warn('my day: the focus timer of a finished to-do did not stop', { taskId: task.id, error: String(error) });
      }
      return; // the stopped view comes back through this listener
    }
    if (task.status !== 'done' || (task.spentMs ?? 0) < MIN || this.learned.has(task.id)) return;
    this.learned.add(task.id);
    if (this.learned.size > MAX_LEARNED) this.learned.delete(this.learned.values().next().value!);
    this.s.estimates?.learn(task.assigneeId ?? 'human', task.title, task.spentMs! / MIN, 'actual');
  }

  private stopped(task: TaskView, at: number, by: string): TaskView {
    const spent = (task.spentMs ?? 0) + Math.max(0, at - (task.timerStartedAt ?? at));
    return this.s.tasks.update(task.id, { spentMs: spent, timerStartedAt: undefined }, by);
  }
}
