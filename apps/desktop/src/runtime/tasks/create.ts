// TaskService.create (split out of tasks/service.ts): checks, the row and its checklist steps in
// one transaction, the anchoring 'task' message for top-level work and the human to-do's armed
// widget. B-047 D4: an
// anchor made during a run in that chat carries meta.fromRun – the run named by the caller (an
// approval to-do), else the creating agent's running turn in this chat (dispatcher.activity) – so
// the chat can fold it into that run's steps.
// B-054 (owner 29.10.2026 "To-dos gehören ja nicht zum Chat … nur ein Übermittlungsweg"): a chat is only where a
// task is handed over. With a conversationId: as before (the chat must exist, the anchor is posted, an agent
// owner joins, a colleague must be a member). Without one: a chat-free task – no anchor, nobody joins; its
// space comes from input.spaceId (runtime callers only: a quick task's chosen space), else the parent, else the creating agent; its origin from the input, else from the creating
// run, else 'todo-list' (the person) or 'system'. A step without an explicit chat takes its parent's chat only
// when its creator is a current member there (or the system), else none – never out of a bounded (people's) chat:
// such a step is refused (F-52). A colleague (per_) gets chat-free work
// only from the owner (P3). The anchor is sent after the transaction; when that send throws, the inserted row
// and its steps are deleted again (compensation) and the error is re-thrown.
// B-078: an agent's new ask in a chat replaces its older open asks there (tasks/supersede.ts). D7: a task for an
// agent out of a 1:1 it is not in is handed over in the creator's own 1:1 with that agent (workRoomFor).
// Owns: building and inserting a new task. Never: gives a task to an unknown or archived agent, or takes an
// origin from an agent's or a person's text (runtime code sets it).

import { HUMAN_ID, SYSTEM_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Attachment, Message, MessageMeta } from '../../shared/model/chat.ts';
import type { CreateTaskInput, Task, TaskView } from '../../shared/model/tasks.ts';
import { ORIGINS, cleanOrigin, type Origin } from '../../shared/model/origin.ts';
import type { TaskServiceImpl } from './service.ts';
import { joinChat } from './owners.ts';
import { workRoomFor } from '../chat/direct.ts';
import { armTimer, prepareWidget } from './timers.ts';
import { isHumanActor, isPersonId } from '../../shared/model/people.ts';
import { checkPersonAssignee } from '../people/task-rules.ts';
import { activePerson } from '../people/repo.ts';
import { dayFieldsOf } from './patch-fields.ts';
import { taskSpace } from './space.ts';
import { applyDepends, checkDepends } from './depends.ts';
import { supersedeAsks } from './supersede.ts';

/** `anchorWith` (task center): who posts the anchor message and its files – the Inbox anchor of an agent's
 *  tasks.submit is the system's (the agent is no member there), a quick task's anchor carries its attachments,
 *  and `body` (B-041) stores the person's whole dictation once (the split rewrites the task into its parts). */
export interface CreateOptions {
  anchor?: Message; clientId?: string; runtimeWidget?: boolean;
  anchorWith?: { authorId: string; attachments?: Attachment[]; meta?: MessageMeta; body?: string };
  /** The run that caused the task (its anchor's meta.fromRun). */
  fromRun?: string;
}

/** The creating agent's running turns (none for the person or the system; a failing lookup is none). */
function runsOf(t: TaskServiceImpl, createdBy: string) {
  if (isHumanActor(createdBy) || createdBy === SYSTEM_ID) return [];
  try { return t.s.dispatcher?.activity().filter((run) => run.agentId === createdBy) ?? []; } catch { return []; }
}

/** The run the anchor belongs to: the caller's, else the creating agent's turn running in this chat. */
function runOf(t: TaskServiceImpl, options: CreateOptions, createdBy: string, conversationId: string): string | undefined {
  if (options.fromRun) return options.fromRun;
  return runsOf(t, createdBy).find((run) => run.conversationId === conversationId)?.runId;
}

/** A chat-free task's origin: the caller's, else the creating run's (or that run's task's), else the To-do area / the system. */
function originFor(t: TaskServiceImpl, input: CreateTaskInput & { createdBy: string }): Origin {
  const given = cleanOrigin(input.origin);
  if (given) return given;
  for (const run of runsOf(t, input.createdBy).filter((entry) => !entry.conversationId)) {
    const from = cleanOrigin(run.origin) ?? (run.taskId ? cleanOrigin(t.repo.get(run.taskId)?.origin) : undefined);
    if (from) return from;
  }
  return input.createdBy === HUMAN_ID ? { ...ORIGINS.todoList } : { ...ORIGINS.system };
}

/** The chat to hand the task over in: the given one, else (a sub-task) the parent's when its creator is a member there. */
function chatFor(t: TaskServiceImpl, input: CreateTaskInput & { createdBy: string }, parent: Task | undefined): string | undefined {
  if (input.conversationId) return input.conversationId;
  const inherited = parent?.conversationId;
  if (!inherited) return undefined;
  if (input.createdBy === SYSTEM_ID) return inherited;
  let member = false;
  try { member = t.s.chats.members(inherited).some((entry) => entry.memberId === input.createdBy && !entry.leftAt); } catch { member = false; }
  if (member) return inherited;
  return undefined;
}

/** D7's work room for a new agent task; a creator without a 1:1 of its own (an outside agent) keeps the given chat. */
function workRoom(t: TaskServiceImpl, given: string | undefined, by: string, agentId: string): string | undefined {
  try { return workRoomFor(t.s, given, by, agentId); } catch (error) {
    t.s.log?.warn('no work room for the new task', { by, agentId, error: String(error) });
    return given;
  }
}

/**
 * F-52: a colleague gets a task in a chat they are in; chat-free work only from the owner (P3). Shared with
 * TaskService.assign.
 */
export function checkPersonWorkFor(t: TaskServiceImpl, personId: string, conversationId: string | undefined, by: string): void {
  const name = t.s.people?.nameOf(personId);
  if (conversationId) { checkPersonAssignee(t.s.db, personId, conversationId, name); return; }
  if (!activePerson(t.s.db, personId)) throw new WorkforceError('not_found', 'This person is no longer in the organisation.', { details: { personId } });
  if (by !== HUMAN_ID) {
    throw new WorkforceError('conflict', `${name ?? 'This person'} gets work through a chat with them. Give the task in a chat with them.`, { details: { personId } });
  }
}

export function createTask(t: TaskServiceImpl, input: CreateTaskInput & { createdBy: string }, options: CreateOptions = {}): TaskView {
  const s = t.s;
  if (input.conversationId && !s.chats.get(input.conversationId)) {
    throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId: input.conversationId } });
  }
  if (!input.title?.trim()) throw new WorkforceError('bad_request', 'A task needs a title.');
  const clientId = options.clientId ?? (input.clientId ? `cli:${input.clientId}` : undefined);
  if (clientId) {
    const existing = t.repo.byClientId(clientId);
    if (existing) return t.views([existing])[0];
  }
  const assigneeKind = input.assigneeKind ?? (input.assigneeId ? 'agent' : 'team');
  const toPerson = assigneeKind === 'human' && isPersonId(input.assigneeId); // F-52: a colleague's task, not the owner's To-do list
  const parent = input.parentId ? t.repo.get(input.parentId) : undefined;
  if (input.parentId && !parent) throw new WorkforceError('not_found', 'Parent task not found.');
  if (assigneeKind === 'agent' && input.assigneeId && s.org) {
    const owner = s.org.get(input.assigneeId);
    if (!owner || owner.archivedAt !== undefined) throw new WorkforceError('not_found', 'Agent not found.');
  }
  // D7: work for an agent out of a 1:1 it is not in is handed over in the creator's own 1:1 with it (chat/direct.ts).
  const given = chatFor(t, input, parent);
  const conversationId = assigneeKind === 'agent' && input.assigneeId ? workRoom(t, given, input.createdBy, input.assigneeId) : given;
  if (toPerson) checkPersonWorkFor(t, input.assigneeId!, conversationId, input.createdBy);
  const now = s.clock.now();
  const armed = input.widget && assigneeKind === 'human' ? prepareWidget(input.widget, now, options.runtimeWidget ? SYSTEM_ID : input.createdBy) : undefined;
  const task: Task = {
    id: newId('task', now), title: input.title.trim(), notes: input.notes ?? '',
    status: 'open', assigneeKind, createdBy: input.createdBy, priority: input.priority ?? 0, ledger: {},
    attempts: 0, sort: now, rev: 0, createdAt: now, updatedAt: now,
  };
  if (conversationId) {
    task.conversationId = conversationId;
    const given = cleanOrigin(input.origin);
    if (given) task.origin = given;
  } else {
    const spaceId = input.spaceId ?? (parent ? taskSpace(s, parent) : s.org?.get(input.createdBy)?.spaceId);
    if (spaceId) task.spaceId = spaceId;
    task.origin = originFor(t, input);
  }
  if (assigneeKind !== 'team' && input.assigneeId) task.assigneeId = input.assigneeId;
  if (input.dueAt !== undefined || armed?.dueAt !== undefined) task.dueAt = input.dueAt ?? armed?.dueAt;
  if (input.doneWhen) task.doneWhen = input.doneWhen;
  if (input.mode) task.mode = input.mode;
  if (input.widget) task.widget = armed?.widget ?? input.widget;
  if (input.humanReason) task.humanReason = input.humanReason;
  Object.assign(task, dayFieldsOf(input)); // B-041 day fields (estimate, window, prep, private …)
  if (input.dependsOn?.length) applyDepends(t.repo, task, checkDepends(t.repo, undefined, parent?.id, input.dependsOn), now);
  if (parent) { task.parentId = parent.id; task.goal = parent.title; }
  if (options.anchor) task.messageId = options.anchor.id;
  const steps = (input.steps ?? []).map(line => line.trim()).filter(Boolean);
  if (assigneeKind === 'agent' && task.assigneeId) joinChat(t, task.conversationId, task.assigneeId, input.createdBy);
  s.db.tx(() => {
    t.repo.insert(task, clientId);
    steps.forEach((title, index) => {
      t.repo.insert({
        ...task, id: newId('task', now), title, notes: '', parentId: task.id, goal: task.title, messageId: undefined,
        widget: undefined, doneWhen: undefined, sort: index, ledger: {}, status: 'open', waitingOn: undefined, dependsOn: undefined,
        // Steps keep only 'private' of the B-041 day fields.
        estimateMin: undefined, estimateSource: undefined, spentMs: undefined, timerStartedAt: undefined, window: undefined, prep: undefined,
      });
    });
  });
  // Top-level tasks handed over in a chat are anchored by a 'task' message there (steps, block to-dos and
  // chat-free tasks are not).
  if (!parent && !options.anchor && task.conversationId) anchorTask(t, task, input, options, task.conversationId);
  armTimer(s, task);
  const view = t.emit(task);
  if (parent) { const fresh = t.repo.get(parent.id); if (fresh) t.emit(fresh); } // its steps changed: Work's card and detail show the new one at once
  t.life.created(task);
  supersedeAsks(t, task); // B-078: an agent's newer question replaces its older open ones at the same place
  return view;
}

/** Posts the anchor (outside the transaction: delivery side effects never fire for a rolled-back message). */
function anchorTask(t: TaskServiceImpl, task: Task, input: CreateTaskInput & { createdBy: string }, options: CreateOptions, conversationId: string): void {
  const s = t.s;
  try {
    const author = options.anchorWith?.authorId ?? input.createdBy;
    const fromRun = runOf(t, options, input.createdBy, conversationId);
    const meta = { ...(options.anchorWith?.meta ?? {}), ...(fromRun ? { fromRun } : {}) };
    const message = s.chats.send({
      conversationId, body: options.anchorWith?.body ?? task.title, kind: 'task', taskId: task.id,
      authorId: author, authorKind: isHumanActor(author) ? 'human' : author === SYSTEM_ID ? 'system' : 'agent',
      ...(options.anchorWith?.attachments?.length ? { attachments: options.anchorWith.attachments } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    task.messageId = message.id;
    t.repo.save(task, task.rev);
  } catch (error) {
    // Compensation: no task without its handover message – the row and its steps go (steps by cascade).
    try { t.repo.delete(task.id); } catch (cleanup) { s.log?.warn('task not removed after a failed anchor', { taskId: task.id, error: String(cleanup) }); }
    throw error;
  }
}
