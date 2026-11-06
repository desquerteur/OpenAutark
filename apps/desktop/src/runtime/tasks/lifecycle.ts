// Side effects of task changes (the TaskService writes the rows, this decides who hears of it):
// - created / assigned: the agent owner is woken (also for a task an agent opens for itself, so work that did not
//   finish in the creating turn resumes); unowned team work first gets an owner from one decision-model pick
//   (tasks/route-pick.ts, B-078 D11); unsure or without a model it wakes the chat lead, else the responsible manager,
//   who decides who does it (tasks/owners.ts); a to-do an agent gives the person notifies;
// - status changes: a quiet status line, queued wakes dropped on cancel (a to-do's timers and mini-app takes too);
//   finished work reopened by someone else, or work the person moved back on, wakes its owner (tasks/transitions.ts);
// - a child settled (done, cancelled, blocked, removed): the parent that waited on it continues (transitions.ts);
//   else the agent that delegated it (created or assigned it) hears once;
// - done: the person is notified (not for a quiet finish), the agent that created or assigned it hears once, the one
//   verification step runs (tasks/verification.ts), the owner's own follow-ups end;
// - done, cancelled or removed: what comes after it (Task.dependsOn) goes on (tasks/depends.ts);
// - removed: wakes, schedules and mini-app takes go; the anchor message becomes a tombstone line;
// - the person cancelling, finishing or removing a task stops a turn still running on it.
// B-059 #86: a "Done:"/"Blocked:" line written during the acting agent's turn in the task's chat carries meta.fromRun.
// B-076 (owner 05.11.: a click is just the click): a to-do the person answered or declined ends quietly – no
// "Done:"/"Cancelled:" line and no word to the agent that asked; the person's own line says it (answer-receipt.ts).
// Owns: wakes, notifications and status lines that follow a task change.
// Never: shows unchecked work as verified, wakes anyone for checklist steps of the same owner, or archived agents.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { StatusLine } from '../../shared/model/chat.ts';
import type { Task, TaskStatus } from '../../shared/model/tasks.ts';
import type { WakeQueue } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { isPaused, joinChat, mayBringIn, responsibleManager, stopRuns } from './owners.ts';
import { childResolved, reopened, wakeOwner, type Resolution } from './transitions.ts';
import { dropTimers } from './timers.ts';
import { releaseAppFiles } from './app-files.ts';
import { TaskVerification } from './verification.ts';
import { dependencyEnded } from './depends.ts';
import { routeTeamWork } from './route-pick.ts';
import { isPersonId } from '../../shared/model/people.ts';

export { uncheckedNote } from './verification.ts';
export const FINISHED: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);
export const NO_AGENT_LINE = 'No agent can pick this up yet';
export const NO_MEMBER_LINE = 'No agent in this chat can pick this up yet';

export class TaskLifecycle {
  private readonly t: TaskServiceImpl;
  private readonly verification: TaskVerification;
  constructor(tasks: TaskServiceImpl) { this.t = tasks; this.verification = new TaskVerification(tasks); }

  created(task: Task): void {
    if (task.parentId || task.waitingOn?.kind === 'task') return; // what comes after other tasks starts when they ended (depends.ts)
    if (task.assigneeKind === 'agent' && task.assigneeId) wakeOwner(this.t, task);
    else if (task.assigneeKind === 'team') routeTeamWork(this.t, task, () => this.wakeLead(task, task.createdBy));
    else if (task.assigneeKind === 'human' && task.createdBy !== HUMAN_ID && !isPersonId(task.assigneeId)) { // F-52: a colleague's to-do is not the owner's
      this.t.s.notifications?.notify({ kind: 'todo', title: excerpt(task.title, 80), body: '', conversationId: task.conversationId, taskId: task.id });
    }
  }

  /** Assigned, before the event: the quiet "Assigned to …" line. */
  assigning(task: Task, assignee: { kind: Task['assigneeKind']; id?: string }, by: string): void {
    if (task.parentId) return;
    const who = assignee.kind === 'team' ? 'the team' : assignee.kind === 'human' ? (assignee.id && isPersonId(assignee.id) ? this.t.nameOf(assignee.id) : 'you') : this.t.nameOf(assignee.id!);
    this.t.line(task, { type: 'note', text: `Assigned to ${who}: ${excerpt(task.title, 60)}`, details: { taskId: task.id, assignee } }, by);
  }

  /** Assigned, after the event: the new agent owner (or the lead for team work) is woken. */
  assigned(task: Task, assignee: { kind: Task['assigneeKind']; id?: string }, by: string): void {
    if (FINISHED.has(task.status)) return;
    if (assignee.kind === 'agent' && assignee.id !== by) wakeOwner(this.t, task);
    else if (assignee.kind === 'team') routeTeamWork(this.t, task, () => this.wakeLead(task, by));
  }

  statusChanged(task: Task, from: TaskStatus, by: string, note?: string): void {
    const status = task.status;
    if (!task.parentId && !(status === 'cancelled' && answeredTodo(task))) { // a decline is the person's own line
      const type: StatusLine['type'] = status === 'blocked' ? 'task_blocked' : 'note';
      const line = { type, text: `${statusLabel(status)}: ${excerpt(task.title, 60)}${note ? ` · ${excerpt(note, 80)}` : ''}`, details: { taskId: task.id, status } };
      if (status === 'blocked') runLine(this.t, task, line, by); else this.t.line(task, line, by);
    }
    if (status === 'cancelled') { this.t.s.wakes.cancelTask(task.id); stopRuns(this.t, task, by); }
    if (status === 'cancelled' && task.assigneeKind === 'human') {
      dropTimers(this.t.s, task.id, true); // a cancelled to-do never rings again
      releaseAppFiles(this.t.s, task.widget, []); // nor holds a mini-app's takes
    }
    reopened(this.t, task, from, by, note);
    if (task.parentId && (status === 'cancelled' || status === 'blocked')) this.settledChild(task, status, by, note);
    if (status === 'cancelled') dependencyEnded(this.t, task, 'cancelled');
  }

  /** A child settled: the parent that waits on it continues (true); else its delegator hears of it once. */
  private settledChild(task: Task, how: Resolution, by: string, note?: string): boolean {
    if (childResolved(this.t, task, how, by, note)) return true;
    this.tellDelegator(task, how, by, note);
    return false;
  }

  /**
   * The agents that created or assigned the work (not its owner, not who settled it) hear once how it ended – for a
   * child only delegated work (another owner than its task's), and never while its task is paused or finished.
   */
  private tellDelegator(task: Task, how: Resolution, by: string, note?: string): void {
    const parent = task.parentId ? this.t.repo.get(task.parentId) : undefined;
    if (parent && (FINISHED.has(parent.status) || isPaused(parent) || (task.assigneeKind === parent.assigneeKind && task.assigneeId === parent.assigneeId))) return;
    const what = how === 'done' ? `done${task.result?.summary ? `: ${excerpt(task.result.summary, 600)}` : ''}` : `${how}${note ? `: ${excerpt(note, 300)}` : ''}`;
    for (const agentId of new Set([task.createdBy, task.assignedBy ?? task.createdBy])) {
      if (agentId === HUMAN_ID || agentId === SYSTEM_ID || isPersonId(agentId) || agentId === task.assigneeId || agentId === by) continue;
      if (agentId === task.createdBy && answeredTodo(task)) continue; // the agent that asked reads the person's line itself (answer-receipt.ts)
      const agent = this.t.s.org?.get(agentId);
      if (this.t.s.org && (!agent || agent.archivedAt !== undefined)) continue;
      this.t.s.wakes.wake({
        agentId, reason: 'child', conversationId: task.conversationId, taskId: task.parentId ?? task.id, coalesceKey: `child:${task.id}`,
        ...(task.parentId ? { note: `Delegated work "${excerpt(task.title, 100)}" is ${what}` } : {}),
      });
    }
  }

  /** Removed (with `parts`, the tasks under it, gone with it): nothing of them stays planned; the anchor message becomes a quiet tombstone line. */
  removed(task: Task, by: string, parts: Task[] = []): void {
    const s = this.t.s;
    for (const gone of [task, ...parts]) {
      this.verification.forget(gone.id);
      s.wakes.cancelTask(gone.id);
      for (const schedule of s.scheduler?.list({ taskId: gone.id }) ?? []) s.scheduler!.remove(schedule.id);
      releaseAppFiles(s, gone.widget, []); // a removed mini-app to-do's takes go to the clean-up
    }
    stopRuns(this.t, task, by);
    if (task.parentId && !FINISHED.has(task.status)) this.settledChild(task, 'removed', by);
    for (const gone of [task, ...parts]) dependencyEnded(this.t, gone, 'removed');
    if (task.messageId && !task.parentId) {
      const anchor = s.chats.message(task.messageId);
      if (anchor?.kind === 'task') s.chats.removeMessage(task.messageId, SYSTEM_ID);
      if (anchor) this.t.line(task, { type: 'note', text: `Task removed: ${excerpt(task.title, 60)}`, details: { taskId: task.id } }, by);
    }
  }

  /** Done, before the event: quiet line (none for an answered to-do), notification for the person (not for a quiet finish), no more owner turns. */
  completing(task: Task, by: string, options: { notify?: boolean } = {}): void {
    const s = this.t.s;
    if (!task.parentId) {
      if (!answeredTodo(task)) runLine(this.t, task, { type: 'task_done', text: `Done: ${excerpt(task.title, 60)}`, details: { taskId: task.id, verification: task.result?.verification } }, by);
      if (task.createdBy === HUMAN_ID && by !== HUMAN_ID && options.notify !== false) {
        s.notifications?.notify({ kind: 'done', title: excerpt(task.title, 80), body: excerpt(task.result?.summary ?? '', 160), conversationId: task.conversationId, taskId: task.id });
      }
    }
    s.wakes.cancelTask(task.id, ['retry', 'task']);
    dropRechecks(s.wakes, task);
    stopRuns(this.t, task, by);
  }

  /** Done, after the event: who created or assigned it hears once, human step progress, the parent, verification. */
  completed(task: Task, by: string): void {
    const s = this.t.s;
    if (task.assigneeKind === 'human') dropTimers(s, task.id); // done early: the one-shot ring is gone
    if (!task.parentId) this.tellDelegator(task, 'done', by);
    this.humanProgress(task, by);
    if (task.parentId && !this.settledChild(task, 'done', by)) { const parent = this.t.repo.get(task.parentId); if (parent) this.t.emit(parent); }
    dependencyEnded(this.t, task, 'done');
    this.verification.start(task, by);
  }

  /** The person checked a step → the owner notices softly (normal wake, no interrupt) – the agent that asked reads their answer line instead. */
  humanProgress(task: Task, by: string): void {
    if (by !== HUMAN_ID || !task.parentId) return;
    const parent = this.t.repo.get(task.parentId);
    if (!parent || FINISHED.has(parent.status) || parent.assigneeKind !== 'agent' || !parent.assigneeId) return;
    if (answeredTodo(task) && parent.assigneeId === task.createdBy) return;
    this.t.s.wakes.wake({
      agentId: parent.assigneeId, reason: 'task', conversationId: parent.conversationId, taskId: parent.id,
      note: `The human marked a step as ${task.status}: ${excerpt(task.title, 80)}`, coalesceKey: `task:${parent.id}`,
    });
  }

  /** True when the chat's recent status lines about this task already said `text`. */
  private alreadySaid(task: Task, chat: string, text: string): boolean { return this.t.s.chats.messages(chat, { limit: 50 }).some(m => m.kind === 'status' && m.taskId === task.id && m.body === text); }

  /**
   * Unowned (team) work: the chat lead decides who does it; without one – and for chat-free work – the responsible
   * manager (it joins a chat as SYSTEM only when `by` may bring an agent in, owners.ts mayBringIn).
   */
  wakeLead(task: Task, by: string): void {
    const s = this.t.s;
    const chat = task.conversationId;
    if (!chat) {
      const manager = s.org ? responsibleManager(s.org, task.spaceId) : undefined;
      if (manager && manager.id !== task.createdBy) s.wakes.wake({ agentId: manager.id, reason: 'task', taskId: task.id, coalesceKey: `task:${task.id}` });
      return;
    }
    let lead = s.chats.lead(chat);
    if (!lead) {
      const allowed = mayBringIn(this.t, chat, by);
      const manager = allowed && s.org ? responsibleManager(s.org, s.chats.get(chat)?.spaceId) : undefined;
      if (manager) joinChat(this.t, chat, manager.id, SYSTEM_ID);
      if (!manager || !s.chats.members(chat).some(member => member.memberId === manager.id)) {
        const text = allowed ? NO_AGENT_LINE : NO_MEMBER_LINE;
        if (!this.alreadySaid(task, chat, text)) this.t.line(task, { type: 'note', text, details: { taskId: task.id } }, SYSTEM_ID);
        return;
      }
      lead = manager.id;
    }
    if (lead !== task.createdBy) {
      s.wakes.wake({ agentId: lead, reason: 'task', conversationId: task.conversationId, taskId: task.id, coalesceKey: `task:${task.id}` });
    }
  }

  /** A pause ended (owners.ts resumeTask): the owner – or the lead for team work – continues. */
  resumed(task: Task, by: string, note: string): void {
    if (task.parentId) return;
    if (task.assigneeKind === 'agent' && task.assigneeId) wakeOwner(this.t, task, { note });
    else if (task.assigneeKind === 'team') this.wakeLead(task, by);
  }
}

/** B-059 #86: the task line, with meta.fromRun when `by` has a turn running in the task's chat (never a split's) – else the plain line. */
function runLine(t: TaskServiceImpl, task: Task, line: StatusLine, by: string): void {
  let fromRun: string | undefined;
  try { fromRun = t.s.dispatcher?.activity().find((run) => run.agentId === by && run.conversationId === task.conversationId && !run.split)?.runId; } catch { /* no run known */ }
  if (!fromRun || !task.conversationId) { t.line(task, line, by); return; }
  try { t.s.chats.status(task.conversationId, line, { authorId: by, taskId: task.parentId ?? task.id, fromRun }); } catch (error) {
    t.s.log?.warn('task status line failed', { taskId: task.id, error: String(error) });
  }
}

/**
 * A to-do the person answered through its widget (TaskService.answer) or declined: their own line in the chat says it
 * and reaches the agent that asked (tasks/answer-receipt.ts), so its end adds no status line and no second word.
 */
function answeredTodo(task: Task): boolean {
  if (task.assigneeKind !== 'human' || task.result?.answer === undefined) return false;
  return task.widget !== undefined || task.status === 'cancelled';
}

/** Finished work: the owner's unclaimed 'review' wakes for it end. Team work: the lead's reminders end. */
export function dropRechecks(wakes: WakeQueue, task: Pick<Task, 'id' | 'assigneeKind' | 'assigneeId'>): void {
  if (task.assigneeKind === 'team') { wakes.cancelTask(task.id, ['review']); return; }
  if (task.assigneeKind !== 'agent' || !task.assigneeId) return;
  const ids = wakes.list(task.assigneeId).filter(wake => wake.claimedAt === undefined && wake.taskId === task.id && wake.reason === 'review').map(wake => wake.id);
  if (ids.length) wakes.done(ids);
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'open': return 'Reopened';
    case 'working': return 'Working';
    case 'waiting': return 'Waiting';
    case 'needs_you': return 'Needs you';
    case 'blocked': return 'Blocked';
    case 'cancelled': return 'Cancelled';
    default: return 'Done';
  }
}
