// System-made task transitions: work that waits on someone continues as soon as the wait ends.
// - Human steps: when the last open human step (a human.ask under the task) of an agent task that waits on the person
//   is answered, done, cancelled or removed, the task goes back to 'working', a quiet 'Continuing: …' line follows and
//   the owner is woken.
// - Delegated children: when a child the task waits on (waitingOn kind 'task' – `id` and `ids` – or kind 'agent'
//   naming the child or its assignee) is done, cancelled, blocked or removed, the owner is woken with reason 'child'
//   and the result (status, summary, evidence or the blocker); the task resumes after the last one.
// - Waits merge: a second child to wait on keeps the first one (waitingOn.ids) while it is still open.
// - Reopen: the person moving an agent task back to open/working adds a ledger fact and wakes the owner with the note;
//   anyone else reopening finished work wakes the owner too. ledger.cancelledBy remembers who cancelled.
// - humanWaitIn: the one task of an agent in a chat that waits on the person (chat/delivery.ts gives a message of the
//   person that taskId).
// Owns: those rules. Never: resumes paused work (only the person ends a pause, owners.ts), wakes anyone for checklist
// steps, resumes finished work, or wakes archived owners.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { Task, TaskLedger, TaskResult, TaskStatus, TaskView } from '../../shared/model/tasks.ts';
import type { TaskService } from '../contracts.ts';
import type { TaskServiceImpl } from './service.ts';
import { isPaused, withFact } from './owners.ts';

const FINISHED: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);
/** A delegated child that reached one of these no longer holds its parent. */
const RESOLVED: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'blocked']);
/** Statuses the human "reopens" from when setting an agent task open or working. */
const REOPENS: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'waiting', 'needs_you', 'blocked']);
const EVIDENCE_CAP = 8;

export const HUMAN_WROTE_NOTE = 'The person wrote while this task waits on them. If their message settles what it waits on, I set the task to working (tasks.update) and continue; otherwise I answer them and let it wait.';

export type Resolution = 'done' | 'cancelled' | 'blocked' | 'removed';

/** Wakes a task's agent owner (never an archived one). */
export function wakeOwner(t: TaskServiceImpl, task: Task, wake: { reason?: WakeReason; note?: string; coalesceKey?: string } = {}): void {
  const s = t.s;
  if (task.assigneeKind !== 'agent' || !task.assigneeId) return;
  const owner = s.org?.get(task.assigneeId);
  if (s.org && (!owner || owner.archivedAt !== undefined)) return; // archived owners never run again
  s.wakes.wake({
    agentId: task.assigneeId, reason: wake.reason ?? 'task', conversationId: task.conversationId, taskId: task.id,
    note: wake.note, coalesceKey: wake.coalesceKey ?? `task:${task.id}`,
  });
}

/** Waits on the person: needs_you, or waiting/blocked on the human – never a pause (status 'open'). */
export function waitsOnHuman(task: Pick<Task, 'status' | 'waitingOn'>): boolean {
  if (FINISHED.has(task.status) || task.status === 'open' || task.status === 'working') return false;
  return task.status === 'needs_you' || task.waitingOn?.kind === 'human';
}

/** The agent's only task in the chat that waits on the person (undefined for none or several). */
export function humanWaitIn(tasks: Pick<TaskService, 'list'>, conversationId: string, agentId: string): TaskView | undefined {
  const waiting = tasks.list({
    conversationId, assigneeKind: 'agent', assigneeId: agentId, status: ['needs_you', 'waiting', 'blocked'], includeSteps: true, limit: 20,
  }).filter(waitsOnHuman);
  return waiting.length === 1 ? waiting[0] : undefined;
}

/**
 * A child task reached done, cancelled or blocked, or was removed: a human step may end its
 * parent's wait on the person, a delegated child its parent's wait on that child. True when
 * the parent changed (it was emitted).
 */
export function childResolved(t: TaskServiceImpl, child: Task, how: Resolution, by: string, note?: string): boolean {
  if (!child.parentId) return false;
  const parent = t.repo.get(child.parentId);
  if (!parent || parent.assigneeKind !== 'agent' || !parent.assigneeId || FINISHED.has(parent.status) || isPaused(parent)) return false;
  const owner = t.s.org?.get(parent.assigneeId);
  if (t.s.org && (!owner || owner.archivedAt !== undefined)) return false; // blocked for the human until someone takes it over
  try {
    return child.assigneeKind === 'human' ? humanStepResolved(t, parent, child, how) : delegatedResolved(t, parent, child, how, note);
  } catch (error) {
    t.s.log?.warn('resuming the waiting task failed', { taskId: parent.id, childId: child.id, by, error: String(error) });
    return false;
  }
}

/** update(): a new wait on a child keeps the children still waited on (waitingOn.ids). */
export function mergeWait(t: TaskServiceImpl, current: Task['waitingOn'], next: Task['waitingOn']): Task['waitingOn'] {
  if (!next || next.kind !== 'task' || !next.id || current?.kind !== 'task') return next;
  const open = (id: string) => { const task = t.repo.get(id); return task !== undefined && !RESOLVED.has(task.status); };
  const ids = [...new Set([...waitedIds(current), ...waitedIds(next)])].filter(id => id === next.id || open(id));
  return withIds(next, ids);
}

/** Inside setStatus' write: the person reopening an agent task is a ledger fact, and its stall count starts again. */
export function reopenFact(draft: Task, from: TaskStatus, by: string, note: string | undefined): void {
  if (!humanReopen(draft, from, by)) return;
  draft.ledger = { ...withFact(draft, `Reopened by the human${note ? `: ${excerpt(note, 200)}` : '.'}`), stalls: 0 };
}

/** Remembers who cancelled (ledger.cancelledBy); any other status forgets it. */
export function markCancel(draft: Task, status: TaskStatus, by: string): void {
  if (status === 'cancelled') { draft.ledger = { ...draft.ledger, cancelledBy: by }; return; }
  if (draft.ledger?.cancelledBy === undefined) return;
  const { cancelledBy: _gone, ...rest } = draft.ledger;
  draft.ledger = rest;
}

/** After a status change: finished work reopened by someone else, or work the human moved back on, wakes its owner. */
export function reopened(t: TaskServiceImpl, task: Task, from: TaskStatus, by: string, note?: string): void {
  if (task.parentId || task.assigneeKind !== 'agent' || !task.assigneeId || task.assigneeId === by) return;
  if (task.status !== 'open' && task.status !== 'working') return;
  if (!FINISHED.has(from) && !humanReopen(task, from, by)) return;
  const who = by === HUMAN_ID ? 'The human' : by === SYSTEM_ID ? 'The system' : t.nameOf(by);
  wakeOwner(t, task, { note: `${who} reopened this task${note ? `: ${excerpt(note, 500)}` : '.'}` });
}

// ------------------------------------------------------------- internals

function humanReopen(task: Pick<Task, 'status' | 'assigneeKind' | 'assigneeId' | 'parentId'>, from: TaskStatus, by: string): boolean {
  return by === HUMAN_ID && REOPENS.has(from) && (task.status === 'open' || task.status === 'working')
    && task.assigneeKind === 'agent' && Boolean(task.assigneeId) && !task.parentId;
}

/** (a) The last open human step of a task waiting on the person is settled: the owner continues. */
function humanStepResolved(t: TaskServiceImpl, parent: Task, step: Task, how: Resolution): boolean {
  if (how === 'blocked' || !waitsOnHuman(parent)) return false; // a blocked to-do is not settled
  const open = t.repo.children(parent.id).some(item => item.id !== step.id && item.assigneeKind === 'human' && !FINISHED.has(item.status));
  if (open) return false;
  const label = how === 'done' ? 'Done' : how === 'removed' ? 'Removed' : 'Cancelled';
  const resumed = resume(t, parent, `Human step ${label.toLowerCase()}: ${excerpt(step.title, 120)}`);
  // B-076: an answered ask is the person's line in the chat – the note says so instead of calling it a done step.
  const answered = how === 'done' && Boolean(step.widget);
  wakeOwner(t, resumed, {
    note: answered
      ? `The person answered my ask "${excerpt(step.title, 80)}" (their line is in the chat); nothing on this task waits on them any more – I continue the task.`
      : `Nothing on this task waits on the person any more (${label.toLowerCase()}: ${excerpt(step.title, 80)}). I continue the task.`,
  });
  return true;
}

/** (b) A child the task waits on is settled: its result goes back; the task resumes after the last one. */
function delegatedResolved(t: TaskServiceImpl, parent: Task, child: Task, how: Resolution, note?: string): boolean {
  if (!waitsOn(parent, child)) return false;
  const remaining = parent.waitingOn!.kind === 'task'
    ? waitedIds(parent.waitingOn).filter(id => id !== child.id && !RESOLVED.has(t.repo.get(id)?.status ?? 'done'))
    : [];
  const fact = childFact(t, child, how, note);
  let updated: Task;
  if (remaining.length) {
    updated = t.mutate(parent.id, draft => {
      draft.waitingOn = withIds({ ...draft.waitingOn!, id: remaining[remaining.length - 1] }, remaining);
      draft.ledger = withFact(draft, fact);
    });
    t.emit(updated);
  } else {
    updated = resume(t, parent, fact);
  }
  wakeOwner(t, updated, { reason: 'child', note: checkpointNote(t, child, how, note, remaining), coalesceKey: `child:${child.id}` });
  return true;
}

/** Back to work: 'working', no wait, a ledger fact and a quiet 'Continuing: …' line. */
function resume(t: TaskServiceImpl, parent: Task, fact: string): Task {
  const now = t.s.clock.now();
  const resumed = t.mutate(parent.id, draft => {
    draft.status = 'working';
    draft.startedAt ??= now;
    delete draft.waitingOn;
    draft.ledger = { ...withFact(draft, fact), stalls: 0 };
  });
  if (!resumed.parentId) {
    t.line(resumed, { type: 'note', text: `Continuing: ${excerpt(resumed.title, 60)}`, details: { taskId: resumed.id, status: 'working' } }, SYSTEM_ID);
  }
  t.emit(resumed);
  return resumed;
}

/** The wait with `ids` only when it holds more than one child. */
function withIds(wait: NonNullable<Task['waitingOn']>, ids: string[]): NonNullable<Task['waitingOn']> {
  const { ids: _old, ...rest } = wait;
  return ids.length > 1 ? { ...rest, ids } : rest;
}

export function waitedIds(wait: Task['waitingOn']): string[] {
  if (!wait || wait.kind !== 'task') return [];
  return [...new Set([...(wait.ids ?? []), ...(wait.id ? [wait.id] : [])])];
}

function waitsOn(parent: Task, child: Task): boolean {
  const wait = parent.waitingOn;
  if (!wait) return false;
  if (wait.kind === 'task') return waitedIds(wait).includes(child.id);
  // kind 'agent': the child itself, or its assignee when that is not the parent's own owner.
  return wait.kind === 'agent' && (wait.id === child.id || (wait.id !== undefined && wait.id === child.assigneeId && wait.id !== parent.assigneeId));
}

function childFact(t: TaskServiceImpl, child: Task, how: Resolution, note?: string): string {
  const title = excerpt(child.title, 80);
  if (how === 'done') return `Delegated work done: ${title}${child.result?.summary ? ` – ${excerpt(child.result.summary, 120)}` : ''}`;
  if (how === 'blocked') return `Delegated work blocked: ${title} – ${excerpt(blocker(child, note), 120)}`;
  return `Delegated work ${how}: ${title}${note && how === 'cancelled' ? ` – ${excerpt(note, 120)}` : ''}${child.assigneeId ? ` (${t.nameOf(child.assigneeId)})` : ''}`;
}

/** The return checkpoint for the parent's owner. */
function checkpointNote(t: TaskServiceImpl, child: Task, how: Resolution, note: string | undefined, remaining: string[]): string {
  // A placeholder of work delegated to a linked PC (devices/remote-agents.ts) names the remote agent, not its delegator.
  const remote = /^Delegated to (.+?) \(a linked PC\)\./.exec(child.notes ?? '')?.[1];
  const who = remote ?? (child.assigneeId ? t.nameOf(child.assigneeId) : 'The team');
  const title = `"${excerpt(child.title, 120)}"`;
  const lines: string[] = [];
  if (how === 'done') {
    lines.push(`${who} finished ${title} (${verificationLabel(child.result)}).`);
    if (child.result?.summary) lines.push(`Result: ${excerpt(child.result.summary, 1200)}`);
    const evidence = (child.result?.evidence ?? []).slice(0, EVIDENCE_CAP);
    if (evidence.length) lines.push(`Evidence:\n${evidence.map(item => `- ${excerpt(item.label, 160)}${item.ref ? `: ${excerpt(item.ref, 300)}` : ''}`).join('\n')}`);
  } else if (how === 'blocked') {
    lines.push(`${who} is blocked on ${title}: ${excerpt(blocker(child, note), 400)}`);
  } else {
    lines.push(`${title} (${who}) was ${how}${note && how === 'cancelled' ? `: ${excerpt(note, 300)}` : '.'}`);
  }
  if (remaining.length) {
    const names = remaining.map(id => t.repo.get(id)?.title).filter((name): name is string => Boolean(name)).map(name => `"${excerpt(name, 60)}"`);
    lines.push(`Still waiting for ${remaining.length} more delegated task${remaining.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}.`);
  } else {
    lines.push('Nothing delegated is open any more: I continue the task.');
  }
  return lines.join('\n');
}

function blocker(child: Task, note?: string): string {
  return note?.trim() || child.waitingOn?.reason || 'no reason given';
}

function verificationLabel(result: TaskResult | undefined): string {
  switch (result?.verification) {
    case 'verified': return 'verified';
    case 'reported_by_human': return 'reported by the person';
    default: return result?.verificationNote ? `claimed; ${excerpt(result.verificationNote, 120)}` : 'claimed, not checked yet';
  }
}
