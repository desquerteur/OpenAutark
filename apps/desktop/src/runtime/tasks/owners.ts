// Owner transitions of tasks:
// - an agent that is given a task (create/assign) joins the task's chat, so its chat tools work there – when the
//   person, the system or a member of that chat gives it; a chat-free task has no chat to join, a 1:1 is never joined (D7:
//   the task moves into the receiver's work room instead, moveTaskChat – agents/handoff.ts, the successor here);
// - an archived agent's unfinished tasks move to its successor: the agent named when it was archived (org/service.ts
//   archive puts it at the head of the archived agent's chain), else its next active manager, else a manager agent of
//   its space, else a company-wide manager. With no manager left a task stays 'blocked' for the person. Steps move
//   with their task; a task of the archived agent's 1:1 goes to the successor's own 1:1 with that partner (D7);
// - unowned team work goes to the responsible manager (same ranking), who decides who does it;
// - follow-up wakes ('retry'/'review') belong to the owner: after a reassignment the previous owner's are stale;
// - a person's Stop pauses the work on a task ('open', waiting on the human: "Paused by you"); their message in its
//   chat, an answer, setting it open/working or giving it an owner ends the pause. The person cancelling, finishing
//   or removing a task stops a turn still running on it.
// Owns: picking the successor / responsible manager, moving the work, and the pause/resume rules.
// Never: archives agents (org/service.ts does, then emits 'agent.removed'), completes or drops a task, or hands work
// to an archived agent.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { PAUSED_REASON, isPaused } from '../../shared/model/task-pause.ts';
import type { OrgService, RuntimeServices, WakeQueue } from '../contracts.ts';
import { workRoomFor } from '../chat/direct.ts';
import type { TaskServiceImpl } from './service.ts';

export { PAUSED_REASON, isPaused }; // shared with the views (shared/model/task-pause.ts)
const RESUME_NOTE = 'The human wrote in this chat, which ends the pause of this task. I read the new messages first, then continue unless they say otherwise.';
export const RESUMED_NOTE = 'The human resumed this task. I continue it.';

type OrgView = Pick<OrgService, 'get' | 'list' | 'managers'>;

const isManager = (agent: Agent) => agent.mode === 'manager' || agent.template === 'manager';

/** Only the human, the system or a (current) member of the chat may bring an agent into it (no chat: nobody is brought in). */
export function mayBringIn(t: TaskServiceImpl, conversationId: string | undefined, by: string): boolean {
  return Boolean(conversationId) && (by === HUMAN_ID || by === SYSTEM_ID || t.s.chats.members(conversationId!).some(member => member.memberId === by));
}

/**
 * Adds a new agent owner to the task's chat. Only the human, the system or a member brings an
 * agent in; no-op for members, unknown or archived agents, assignments by outside agents and a 1:1
 * (B-078 D7: it stays two; the work reaches the agent in the giver's 1:1 with it, chat/direct.ts workRoomFor).
 */
export function joinChat(t: TaskServiceImpl, conversationId: string | undefined, agentId: string, by: string): void {
  if (!conversationId) return; // B-054: a chat-free task – nobody joins anything
  if (t.s.chats.get(conversationId)?.settings.direct) return;
  const members = t.s.chats.members(conversationId);
  if (members.some(member => member.memberId === agentId)) return;
  if (!mayBringIn(t, conversationId, by)) return;
  const agent = t.s.org?.get(agentId);
  if (t.s.org && (!agent || agent.archivedAt)) return; // assign() reports unknown agents itself
  t.s.chats.setMembers(conversationId, { add: [agentId] }, by);
}

/**
 * Who takes over an archived agent's work: its next active manager, else a manager agent of
 * its space, else one without a space, else a top-level manager of another space.
 */
export function successorFor(org: OrgView, agentId: string): Agent | undefined {
  const boss = org.managers(agentId).find(agent => agent.id !== agentId && !agent.archivedAt);
  if (boss) return boss;
  return rankedManagers(org, org.get(agentId)?.spaceId, agentId)[0];
}

/**
 * Who picks up team work in a chat without a lead (e.g. the hidden To-do chat): the manager
 * the successor ranking prefers for that space (top-level first), else a secretary, else the
 * oldest top-level agent, else any active agent. Undefined only when there is no agent at all.
 */
export function responsibleManager(org: OrgView, spaceId?: string): Agent | undefined {
  const manager = rankedManagers(org, spaceId, undefined, !spaceId)[0];
  if (manager) return manager;
  const rank = (agent: Agent) => (agent.mode === 'secretary' || agent.template === 'secretary' ? 0 : 1) * 2 + (org.managers(agent.id).length ? 1 : 0);
  return org.list()
    .filter(agent => !agent.archivedAt)
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
}

/**
 * Active managers ranked for a space: same space, no space, top-level elsewhere (shallow first
 * within a rank; `topFirst` puts the shallowest first across ranks).
 */
function rankedManagers(org: OrgView, space: string | undefined, exclude?: string, topFirst = false): Agent[] {
  return org.list()
    .filter(agent => agent.id !== exclude && !agent.archivedAt && isManager(agent))
    .map(agent => {
      const depth = org.managers(agent.id).length;
      const rank = space && agent.spaceId === space ? 0 : !agent.spaceId ? 1 : depth === 0 ? 2 : 3;
      return { agent, rank, depth };
    })
    .filter(entry => entry.rank < 3) // a sub-manager of another space is not responsible here
    .sort((a, b) => (topFirst ? a.depth - b.depth : 0) || a.rank - b.rank || a.depth - b.depth
      || a.agent.createdAt - b.agent.createdAt || a.agent.id.localeCompare(b.agent.id))
    .map(entry => entry.agent);
}

/**
 * B-078 D7: moves a task (with its steps in the same chat) into `chatId` – the receiver's work room when the task's
 * chat is a 1:1 it is not in. Its anchor message stays where the work was handed over; rev is bumped so a stale copy
 * cannot write over it. No event: the assign or mutate that follows announces the task.
 */
export function moveTaskChat(s: Pick<RuntimeServices, 'db' | 'clock'>, taskId: string, chatId: string): void {
  s.db.run(
    `UPDATE tasks SET conversation_id = ?, rev = rev + 1, updated_at = ?
     WHERE id = ? OR (parent_id = ? AND conversation_id = (SELECT conversation_id FROM tasks WHERE id = ?))`,
    [chatId, s.clock.now(), taskId, taskId, taskId]);
}

/**
 * B-078 D7: brings a new agent owner to a task given by `by`: into the task's chat (joinChat), or – out of a 1:1 the
 * agent is not in – the task moves into `by`'s own 1:1 with the agent (workRoomFor), so its wakes and answers land
 * where it is a member. Returns the chat the task is in now. For tasks/service.ts assign (before its mutate).
 */
export function routeOwner(t: TaskServiceImpl, task: Pick<Task, 'id' | 'conversationId'>, agentId: string, by: string): string | undefined {
  const chatId = task.conversationId;
  if (chatId && t.s.chats.get(chatId)?.settings.direct && mayBringIn(t, chatId, by)) {
    let room: string | undefined;
    try {
      room = workRoomFor(t.s, chatId, by, agentId);
    } catch (error) {
      t.s.log?.warn('no work room for the new owner', { taskId: task.id, error: String(error) }); // the task stays in its chat
    }
    if (room && room !== chatId) { moveTaskChat(t.s, task.id, room); return room; }
  }
  joinChat(t, chatId, agentId, by);
  return chatId;
}

/**
 * B-078 D7: where an archived agent's successor works on a task of the 1:1 the archived agent had with someone:
 * the successor's own 1:1 with that partner (chat/direct.ts workRoomFor); any other chat, or a 1:1 the successor is
 * in, stays as it is.
 */
function successorRoom(t: TaskServiceImpl, task: Task, goneId: string, successorId: string): string | undefined {
  const chatId = task.conversationId;
  const chat = chatId ? t.s.chats.get(chatId) : undefined;
  if (!chatId || !chat?.settings.direct) return chatId;
  const others = t.s.chats.members(chatId).filter((member) => member.leftAt === undefined && member.memberId !== goneId).map((member) => member.memberId);
  const partner = (chat.settings.directPair ?? others).find((id) => id !== goneId);
  if (!partner || partner === successorId) return chatId;
  try {
    return workRoomFor(t.s, chatId, partner, successorId);
  } catch (error) {
    t.s.log?.warn('no work room for the successor', { taskId: task.id, error: String(error) });
    return chatId;
  }
}

/** 'agent.removed': moves the archived agent's unfinished tasks to its successor (or blocks them). */
export function handOver(t: TaskServiceImpl, agentId: string): void {
  const org = t.s.org;
  const gone = org?.get(agentId);
  if (!org || !gone?.archivedAt) return;
  const owned = t.repo.openFor(agentId);
  if (!owned.length) return;
  const successor = successorFor(org, agentId);
  // Steps of a task that moves too follow it (first, so the task's event shows them moved).
  // A child task under someone else's task – work delegated to the archived agent – moves on
  // its own: its new owner is woken, or it is blocked for the human; it is never left silent.
  const moving = new Set(owned.filter(task => !task.parentId).map(task => task.id));
  const follows = (task: Task) => task.parentId !== undefined && moving.has(task.parentId);
  for (const task of [...owned.filter(follows), ...owned.filter(task => !follows(task))]) {
    t.s.wakes.cancel(agentId, { taskId: task.id });
    try {
      if (successor) moveTo(t, task, successor.id, gone, follows(task));
      else if (!follows(task)) block(t, task, gone.name);
    } catch (error) {
      t.s.log?.warn('task handover failed', { taskId: task.id, agentId, error: String(error) });
    }
  }
}

function moveTo(t: TaskServiceImpl, task: Task, successorId: string, gone: Agent, silent: boolean): void {
  const previous = gone.name;
  // D7: out of the archived agent's 1:1 the work goes to the successor's own 1:1 with that partner (steps follow their
  // task there: moveTaskChat takes them along, so a step that comes first finds its chat already moved or moves it).
  const room = successorRoom(t, task, gone.id, successorId);
  if (room && room !== task.conversationId) moveTaskChat(t.s, task.parentId && silent ? task.parentId : task.id, room);
  if (silent) {
    // The owner of the task is woken for the task, not per step.
    joinChat(t, task.conversationId, successorId, SYSTEM_ID);
    t.emit(t.mutate(task.id, draft => { draft.assigneeId = successorId; }));
    return;
  }
  t.mutate(task.id, draft => { draft.ledger = withFact(draft, `Taken over from ${previous} (archived).`); });
  t.assign(task.id, { kind: 'agent', id: successorId }, SYSTEM_ID);
  emitParent(t, task);
}

function block(t: TaskServiceImpl, task: Task, previous: string): void {
  const note = `Owner archived: ${previous}`;
  const now = t.s.clock.now();
  t.mutate(task.id, draft => {
    draft.ledger = withFact(draft, `${previous} was archived; no manager could take this over.`);
    draft.waitingOn = { kind: 'human', reason: note, since: now };
  });
  if (task.status === 'blocked') t.emit(t.require(task.id));
  else t.setStatus(task.id, 'blocked', SYSTEM_ID, note);
  t.s.notifications?.notify({ kind: 'blocker', title: excerpt(task.title, 80), body: note, conversationId: task.conversationId, taskId: task.id });
  emitParent(t, task);
}

/** A delegated child task changed on its own: its parent's step list shows the change. */
function emitParent(t: TaskServiceImpl, task: Task): void {
  const parent = task.parentId ? t.repo.get(task.parentId) : undefined;
  if (parent) t.emit(parent);
}

export function withFact(task: Task, fact: string): Task['ledger'] {
  return { ...task.ledger, facts: [...(task.ledger.facts ?? []), fact].slice(-20) };
}

// ------------------------------------------------------------- whose turn (T02)

// isPaused (shared/model/task-pause.ts): open and waiting on the human; no automatic turns until resumed.

/** The agent's part in a task: its owner, the lead that routes unassigned team work, or neither. */
export function roleOf(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, agentId: string): 'owner' | 'lead' | 'other' {
  if (task.assigneeKind === 'team') return 'lead';
  if (task.assigneeKind === 'human') return 'other';
  return !task.assigneeId || task.assigneeId === agentId ? 'owner' : 'other';
}

/** A follow-up wake of an agent for a task it does not own (any more); a manager's review of its report's task is not stale. */
export function staleFollowUp(org: Pick<OrgService, 'managers'> | undefined, task: Pick<Task, 'assigneeKind' | 'assigneeId'>, agentId: string, reason: WakeReason): boolean {
  if ((reason !== 'retry' && reason !== 'review') || roleOf(task, agentId) !== 'other') return false;
  if (reason === 'retry' || !task.assigneeId) return true;
  return !org?.managers(task.assigneeId).some(manager => manager.id === agentId);
}

/** Wakes that only continue work: dropped when the human stops it (answers and messages stay). */
const CONTINUATIONS: ReadonlySet<WakeReason> = new Set(['retry', 'review', 'task', 'schedule']);

/**
 * Removes an agent's unclaimed wakes for a task: the stale follow-ups, or (`all`, after a human
 * Stop) every wake that only continues the work. An answer or a message stays.
 */
export function dropFollowUps(s: { wakes: WakeQueue; org?: Pick<OrgService, 'managers'> }, task: Pick<Task, 'id' | 'assigneeKind' | 'assigneeId'>, agentId: string, all = false): void {
  const ids = s.wakes.list(agentId)
    .filter(wake => wake.claimedAt === undefined && wake.taskId === task.id)
    .filter(wake => (all ? CONTINUATIONS.has(wake.reason) : staleFollowUp(s.org, task, agentId, wake.reason)))
    .map(wake => wake.id);
  if (ids.length) s.wakes.done(ids); // deletes the rows; a scheduler timer armed for them finds nothing due
}

/** assign(): the owner changes – the ledger notes it. */
export function changeOwner(t: TaskServiceImpl, draft: Task, before: Task): void {
  const who = (task: Task) => (task.assigneeKind === 'agent' && task.assigneeId ? t.nameOf(task.assigneeId) : task.assigneeKind === 'team' ? 'the team' : 'you');
  draft.ledger = withFact(draft, `Reassigned from ${who(before)} to ${who(draft)}.`);
}

/** claim(): team work got an owner – the ledger notes it, the lead's follow-ups stop. */
export function claimedTeamWork(t: TaskServiceImpl, id: string, agentId: string): Task {
  const task = t.mutate(id, draft => { draft.ledger = withFact(draft, `Claimed by ${t.nameOf(agentId)}.`); });
  t.s.wakes.cancelTask(id, ['review']);
  return task;
}

/** The human stopped the work: 'open', waiting on the human, quiet 'Paused' line. Undefined when nothing changed. */
export function pauseTask(t: TaskServiceImpl, id: string, by: string): Task | undefined {
  const before = t.require(id);
  if (before.status === 'done' || before.status === 'cancelled' || isPaused(before)) return undefined;
  const since = t.s.clock.now();
  const task = t.mutate(id, draft => {
    draft.status = 'open';
    draft.waitingOn = { kind: 'human', reason: PAUSED_REASON, since };
  });
  if (!task.parentId) t.line(task, { type: 'note', text: `Paused: ${excerpt(task.title, 60)}`, details: { taskId: id, status: 'open' } }, by);
  return task;
}

/** Ends a pause: agent work goes back to 'working', team work stays open for its lead. Undefined when not paused. */
export function resumeTask(t: TaskServiceImpl, id: string, by: string): Task | undefined {
  const before = t.require(id);
  if (!isPaused(before)) return undefined;
  const now = t.s.clock.now();
  const task = t.mutate(id, draft => {
    delete draft.waitingOn;
    if (draft.assigneeKind === 'agent') { draft.status = 'working'; draft.startedAt ??= now; }
  });
  if (!task.parentId) t.line(task, { type: 'note', text: `Resumed: ${excerpt(task.title, 60)}`, details: { taskId: id, status: task.status } }, by);
  return task;
}

/**
 * 'message.created': the human's text message resumes the work paused in that chat, an answer
 * only the task its to-do belongs to (the owner is woken). A new task, an unrelated answer or a
 * scheduled message (written earlier, posted automatically) leaves the pause alone. A quiet (silent)
 * line never ends the owner's pause (B-050 K4: silent from a human wakes nobody).
 */
export function resumeOnHumanMessage(t: TaskServiceImpl, message: Message): void {
  if (message.silent || message.authorKind !== 'human' || message.authorId !== HUMAN_ID || message.meta?.via === 'schedule') return; // F-52: only the owner ends the owner's pause
  let only: string | undefined;
  if (message.kind === 'answer') {
    const todoId = message.meta?.answer?.taskId ?? message.taskId;
    const todo = todoId ? t.repo.get(todoId) : undefined;
    if (!todo) return;
    only = todo.parentId ?? todo.id;
  } else if (message.kind !== 'text') return;
  for (const task of t.repo.list({ conversationId: message.conversationId, status: ['open'], limit: 50 })) {
    if (!isPaused(task) || (only !== undefined && task.id !== only)) continue;
    try { t.resume(task.id, HUMAN_ID, RESUME_NOTE); } catch (error) {
      t.s.log?.warn('resuming a paused task failed', { taskId: task.id, error: String(error) });
    }
  }
}

/** The human ended a task (cancel, finish, remove): a turn still running on it stops now. */
export function stopRuns(t: TaskServiceImpl, task: Task, by: string): void {
  const dispatcher = t.s.dispatcher;
  if (by !== HUMAN_ID || task.parentId || typeof dispatcher?.activity !== 'function') return;
  try { (t.s as Partial<Pick<import('../contracts.ts').RuntimeServices, 'splits'>>).splits?.stop({ taskId: task.id }, by); } catch (error) { t.s.log?.warn('stopping the task\'s splits failed', { taskId: task.id, error: String(error) }); } // B-057: the splits its turns made stop too
  let running: Array<{ agentId: string; conversationId?: string }>;
  try { running = dispatcher.activity().filter(run => run.taskId === task.id); } catch { return; }
  for (const run of running) {
    dispatcher.interrupt(run.agentId, run.conversationId).catch((error: unknown) => {
      t.s.log?.warn('stopping the task turn failed', { taskId: task.id, agentId: run.agentId, error: String(error) });
    });
  }
}
