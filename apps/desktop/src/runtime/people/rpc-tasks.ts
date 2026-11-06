// What a person's device may call (F-52), part 3: tasks. A person's For you holds their own to-dos
// (assigneeKind 'human', assigneeId = them); they read the tasks of their chats and those they own,
// made or handed on; they create tasks in their chats for themselves, a colleague of that chat, the
// owner, the team or an agent of their spaces (scope assignAgents), delegate their own work the same
// way, take unassigned team work of a chat they are in (wave 2: "me" as its owner), and finish only their own work – recorded as theirs ('reported_by_human', by their id), never
// as the owner's answer or approval; a form asking for a password or key is never theirs to answer
// (secrets go into the owner's vault). Ids are seen from the person's perspective.
// Owns: these person variants. Never: the owner's handlers, or a change to work that is not theirs.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { isPersonId, type Person } from '../../shared/model/people.ts';
import type { Task, TaskFilter, TaskStatus, TaskView } from '../../shared/model/tasks.ts';
import { formsOf } from '../secrets/capture.ts';
import { MAX_DECLINE_REASON, declineAnswer } from '../tasks/decline.ts';
import { bad, capJson, id, input, notFound, onlyKeys, optBool, optId, optNum, optOneOf, optStrings, optText, text } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { mayReadTask, membership } from './access.ts';
import { realId, viewTaskFor } from './perspective.ts';
import { caller, usableAgent } from './rpc-base.ts';
import { claimFor, claimable } from './rpc-work.ts';

const STATUSES: readonly TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked', 'done', 'cancelled'];
const OWN_STATUSES = ['open', 'working', 'blocked', 'cancelled'] as const;
const MAX_NOTES = 50_000;

function readable(ctx: HandlerContext, person: Person, taskId: string): TaskView {
  const task = ctx.services.tasks.get(taskId);
  if (!task || !mayReadTask(ctx.services.db, person.id, task)) notFound('Task', { taskId });
  return task!;
}

/** Work that is the person's: given to them, or (for edits) made by them. */
function own(task: Task, person: Person, options: { created?: boolean } = {}): boolean {
  return (task.assigneeKind === 'human' && task.assigneeId === person.id) || (options.created === true && task.createdBy === person.id);
}

/** An assignee the person names (their view) → the stored one; checks scopes (TaskService checks chat membership). */
function assigneeOf(ctx: HandlerContext, person: Person, kind: string | undefined, viewIdOf: string | undefined): { assigneeKind: Task['assigneeKind']; assigneeId?: string } {
  if (kind === undefined || kind === 'team') return { assigneeKind: 'team' };
  if (kind === 'human') {
    const target = viewIdOf === undefined ? person.id : realId(person.id, viewIdOf);
    if (target === HUMAN_ID) return { assigneeKind: 'human' }; // the owner's To-do list
    if (!isPersonId(target)) bad('assigneeId', 'a person');
    return { assigneeKind: 'human', assigneeId: target };
  }
  if (kind === 'agent') {
    if (!viewIdOf) bad('assigneeId', 'an agent id');
    if (!person.scopes.assignAgents) throw new WorkforceError('forbidden', 'You may not give tasks to agents here.');
    if (!usableAgent(ctx, person, viewIdOf)) throw new WorkforceError('forbidden', 'You may not work with this agent.', { details: { agentId: viewIdOf } });
    return { assigneeKind: 'agent', assigneeId: viewIdOf };
  }
  return bad('assigneeKind', 'team, human or agent');
}

function filterOf(person: Person, params: unknown): TaskFilter {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'status', 'assigneeKind', 'assigneeId', 'spaceId', 'search', 'includeSteps', 'limit', 'completedSince']);
  const status = optStrings(o, 'status', { maxItems: STATUSES.length, max: 20 });
  if (status?.some((value) => !(STATUSES as readonly string[]).includes(value))) bad('status', STATUSES.join(', '));
  const assigneeId = optId(o, 'assigneeId');
  return {
    conversationId: optId(o, 'conversationId'), status: status as TaskStatus[] | undefined, assigneeKind: optOneOf(o, 'assigneeKind', ['team', 'agent', 'human'] as const),
    assigneeId: assigneeId === undefined ? undefined : realId(person.id, assigneeId), search: optText(o, 'search', { max: 200, allowEmpty: true }),
    includeSteps: optBool(o, 'includeSteps'), limit: optNum(o, 'limit', { min: 1, max: 1000 }), completedSince: optNum(o, 'completedSince', { min: 0 }),
    readableByPerson: person.id,
  };
}

export function registerPersonTasks(table: HandlerTable): void {
  table.addPerson('todos.list', (params, ctx) => {
    const person = caller(ctx);
    return ctx.services.tasks.todos(optNum(input(params), 'limit', { min: 1, max: 200 }) ?? 50, person.id).map((task) => viewTaskFor(ctx.services, person.id, task));
  });
  table.addPerson('tasks.list', (params, ctx) => {
    const person = caller(ctx);
    return ctx.services.tasks.list(filterOf(person, params)).filter((task) => mayReadTask(ctx.services.db, person.id, task)).map((task) => viewTaskFor(ctx.services, person.id, task));
  });
  table.addPerson('tasks.get', (params, ctx) => {
    const person = caller(ctx);
    return viewTaskFor(ctx.services, person.id, readable(ctx, person, id(input(params))));
  });
  table.addPerson('tasks.create', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['conversationId', 'title', 'notes', 'steps', 'assigneeKind', 'assigneeId', 'dueAt', 'priority', 'doneWhen', 'parentId', 'clientId']);
    const conversationId = id(o, 'conversationId');
    if (!membership(ctx.services.db, person.id, conversationId)) notFound('Chat', { conversationId });
    const parentId = optId(o, 'parentId');
    if (parentId) readable(ctx, person, parentId);
    const assignee = assigneeOf(ctx, person, optText(o, 'assigneeKind', { max: 10 }), optId(o, 'assigneeId'));
    const priority = optNum(o, 'priority', { min: 0, max: 2 });
    const view = ctx.services.tasks.create({
      conversationId, title: text(o, 'title', { max: 300 }), notes: optText(o, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }),
      steps: optStrings(o, 'steps', { maxItems: 100, max: 300 }), ...assignee, dueAt: optNum(o, 'dueAt', { min: 0 }),
      priority: priority === undefined ? undefined : ([0, 1, 2] as const)[priority], doneWhen: optText(o, 'doneWhen', { max: 2000, multiline: true }),
      parentId, clientId: optText(o, 'clientId', { max: 100 }), createdBy: person.id,
    });
    return viewTaskFor(ctx.services, person.id, view);
  });
  table.addPerson('tasks.update', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'rev', 'patch']);
    const task = readable(ctx, person, id(o));
    const raw = input(o.patch);
    // Wave 2: "me" as the owner of unassigned team work of their chat takes it (rpc-work.ts claimFor).
    const toSelf = raw.assigneeKind === 'human' && (raw.assigneeId === undefined || raw.assigneeId === null || raw.assigneeId === HUMAN_ID)
      && Object.keys(raw).every((key) => key === 'assigneeKind' || key === 'assigneeId');
    if (!own(task, person, { created: true }) && toSelf && claimable(ctx, person, task)) return viewTaskFor(ctx.services, person.id, claimFor(ctx, person, task));
    if (!own(task, person, { created: true })) throw new WorkforceError('forbidden', 'Only your own tasks can be changed.', { details: { taskId: task.id } });
    onlyKeys(raw, ['title', 'notes', 'dueAt', 'priority', 'doneWhen', 'assigneeKind', 'assigneeId'], 'patch');
    const patch: Partial<Task> = {};
    if ('title' in raw) patch.title = text(raw, 'title', { max: 300 });
    if ('notes' in raw) patch.notes = optText(raw, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }) ?? '';
    if ('dueAt' in raw) patch.dueAt = optNum(raw, 'dueAt', { min: 0 });
    if ('priority' in raw) { const value = optNum(raw, 'priority', { min: 0, max: 2 }) ?? 0; patch.priority = ([0, 1, 2] as const)[value]; }
    if ('doneWhen' in raw) patch.doneWhen = optText(raw, 'doneWhen', { max: 2000, multiline: true });
    if ('assigneeKind' in raw || 'assigneeId' in raw) Object.assign(patch, assigneeOf(ctx, person, optText(raw, 'assigneeKind', { max: 10 }) ?? task.assigneeKind, optId(raw, 'assigneeId')));
    return viewTaskFor(ctx.services, person.id, ctx.services.tasks.update(task.id, patch, person.id, optNum(o, 'rev', { min: 0 })));
  });
  table.addPerson('tasks.setStatus', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    const task = readable(ctx, person, id(o));
    const status = optOneOf(o, 'status', OWN_STATUSES) ?? bad('status', OWN_STATUSES.join(', '));
    if (!own(task, person, { created: status === 'cancelled' })) throw new WorkforceError('forbidden', 'Only your own tasks can be changed.', { details: { taskId: task.id } });
    return viewTaskFor(ctx.services, person.id, ctx.services.tasks.setStatus(task.id, status, person.id, optText(o, 'note', { max: 2000, multiline: true })));
  });
  table.addPerson('tasks.complete', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'answer', 'note', 'clientId']);
    const task = readable(ctx, person, id(o));
    if (!own(task, person)) throw new WorkforceError('forbidden', 'Only your own to-dos and tasks can be finished here.', { details: { taskId: task.id } });
    capJson('answer', o.answer, 256 * 1024);
    const note = optText(o, 'note', { max: 2000, multiline: true });
    const clientId = optText(o, 'clientId', { max: 100 });
    if (task.widget) {
      // Secrets go into the owner's vault and to agents: only the owner enters them (asks for them go to the owner, people/ask-target.ts).
      if (formsOf(ctx.services, { taskId: task.id }).length) {
        throw new WorkforceError('forbidden', 'This form asks for a password or key. Only the owner of the organisation enters those.', { details: { taskId: task.id, reason: 'owner_secret' } });
      }
      const typed = o.answer !== undefined ? o.answer : { done: true, ...(note ? { note } : {}) };
      const view = ctx.services.tasks.answer({ taskId: task.id, answer: typed, by: person.id, clientId });
      return viewTaskFor(ctx.services, person.id, view ?? readable(ctx, person, task.id));
    }
    return viewTaskFor(ctx.services, person.id, ctx.services.tasks.complete(task.id, { summary: note?.trim() || 'Done', evidence: [], verification: 'reported_by_human' }, person.id));
  });
  table.addPerson('todos.decline', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'reason', 'clientId']);
    const task = readable(ctx, person, id(o));
    if (!own(task, person) || !task.widget) throw new WorkforceError('forbidden', 'Only your own to-dos can be declined.', { details: { taskId: task.id } });
    const reason = optText(o, 'reason', { max: MAX_DECLINE_REASON, allowEmpty: true });
    const view = ctx.services.tasks.answer({ taskId: task.id, answer: declineAnswer(reason), by: person.id, clientId: optText(o, 'clientId', { max: 100 }), decline: true });
    return viewTaskFor(ctx.services, person.id, view ?? readable(ctx, person, task.id));
  });
}
