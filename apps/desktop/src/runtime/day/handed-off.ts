// What the person handed off, and handing an own to-do to the team (My day "Handed off", "Send to team").
// handedOff: the top-level tasks the member created that someone else owns – an agent, the team (still without an
// owner) or a colleague – open, plus those done since last evening (default; the end of working hours of the day
// before), each with its steps – for the owner never in a chat that became the people's own (F-52,
// people/access.ts chatHiddenFromOwner). sendToTeam: the person's own top-level to-do becomes team work where it is;
// the responsible manager is woken to decide who does it (tasks/lifecycle.ts wakeLead); its focus timer stops, its
// block leaves the calendar and its to-do widget goes (a timer stays the person's).
// Owns: those two reads/writes. Never: hands off someone else's to-do, an agent's step, or a finished to-do.

import { HUMAN_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { dayZone, daySettings, lastEvening } from './clock.ts';

const OPEN: TaskView['status'][] = ['open', 'working', 'waiting', 'needs_you', 'blocked'];

/** Work `ownerId` created that someone else owns (an agent, the team, a colleague) – a top-level task. */
export function isHandedOff(task: TaskView, ownerId: string): boolean {
  if (task.createdBy !== ownerId || task.parentId) return false;
  const mine = task.assigneeKind === 'human' && (ownerId === HUMAN_ID ? task.assigneeId === undefined || task.assigneeId === HUMAN_ID : task.assigneeId === ownerId);
  return !mine;
}

export function handedOff(s: Pick<RuntimeServices, 'tasks' | 'clock' | 'settings' | 'chats'>, ownerId: string, since?: number): TaskView[] {
  const from = since ?? lastEvening(s.clock.now(), dayZone(s), daySettings(s).workEnd);
  const open = s.tasks.list({ status: OPEN, limit: 1000 }).filter((task) => isHandedOff(task, ownerId));
  const done = s.tasks.list({ completedSince: from, limit: 200 }).filter((task) => task.status === 'done' && isHandedOff(task, ownerId));
  return [...open, ...done];
}

export type SendDeps = Pick<RuntimeServices, 'tasks' | 'log'> & Partial<Pick<RuntimeServices, 'calendar'>>;

export async function sendToTeam(s: SendDeps, taskId: string, by: string, stopTimer: (task: TaskView) => void): Promise<TaskView> {
  const task = s.tasks.get(taskId);
  if (!task) throw new WorkforceError('not_found', 'To-do not found.', { details: { taskId } });
  if (task.assigneeKind !== 'human' || (task.assigneeId !== undefined && task.assigneeId !== HUMAN_ID) || task.parentId || task.createdBy !== by) {
    throw new WorkforceError('bad_request', 'Only a to-do you wrote yourself can go to the team.', { details: { taskId } });
  }
  if (task.status === 'done' || task.status === 'cancelled') throw new WorkforceError('conflict', 'This to-do is already finished.', { details: { taskId } });
  if (task.widget?.type === 'timer') throw new WorkforceError('bad_request', 'A timer stays with you.', { details: { taskId } });
  if (task.timerStartedAt !== undefined) stopTimer(task);
  const block = s.calendar?.blocksFor([taskId]).get(taskId);
  if (block) {
    try { s.calendar!.remove(block.id, by); } catch (error) { s.log.warn('my day: the block of a to-do sent to the team stayed', { taskId, error: String(error) }); }
  }
  s.tasks.update(taskId, { widget: undefined, ...(task.private ? { private: false } : {}) }, by); // team work has no "Done" button of the person's
  s.tasks.assign(taskId, { kind: 'team' }, by); // the lifecycle wakes the responsible manager
  return s.tasks.get(taskId) ?? task;
}
