// RPC handlers: tasks (board/chat tasks), the human "For you" list (todos) and schedules.
// The human completing a to-do with a widget is an *answer* (stored, receipt posted, author
// woken); other tasks complete with a human-reported result.
// Owns: param checks and scope rules. Never: business logic – it delegates to the task
// service and the scheduler. A device without the 'tasks' capability may only finish
// human to-dos, not agents' work. Changing, deleting or running schedules needs 'manage'; a
// snoozed to-do's recorded end follows its paused, resumed or deleted ring (tasks/timers.ts).
// The owner sees and may change every task, a person's to-dos included.
// B-054: a task is its own row – tasks.create without conversationId makes a chat-free task
// (the origin is runtime-written; a client never sends one). tasks.share ("Share to chat…") lives in
// handlers/task-links.ts.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { validateBlock } from '../../../shared/blocks/validate.ts';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import type { CreateTaskInput, ScheduleSpec, Task, TaskFilter, TaskStatus, TaskView } from '../../../shared/model/tasks.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { answerWithSecrets } from '../../secrets/capture.ts';
import { makeMine } from '../../tasks/human.ts';
import { MAX_DECLINE_REASON, declineAnswer, removeTodo } from '../../tasks/decline.ts';
import { snoozeChanged } from '../../tasks/timers.ts';
import { POST_PRIORITIES, rewordPost } from '../../schedules/post.ts';
import { registerTaskLinks } from './task-links.ts';
import { PREVIEW_MAX, previewTimes } from '../../schedules/preview.ts';
import {
  bad, capJson, id, ids, input, notFound, num, onlyKeys, optBool, optId, optIds, optNum, optObj, optOneOf, optStrings, optText, text,
} from '../params.ts';
import type { Obj } from '../params.ts';
import { scopeHas, secureScope, type HandlerContext, type HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const TASKS = { capability: 'tasks' } as const;
const MANAGE = { capability: 'manage' } as const;
const STATUSES: readonly TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked', 'done', 'cancelled'];
const ASSIGNEES = ['team', 'agent', 'human'] as const;
const REASONS = ['physical', 'identity', 'credential', 'approval', 'taste', 'review'] as const;
const PRIORITIES = [0, 1, 2] as const;
const MAX_NOTES = 50_000;
const PATCH_KEYS = ['title', 'notes', 'dueAt', 'priority', 'doneWhen', 'dependsOn', 'mode', 'assigneeKind', 'assigneeId', 'sort'] as const;

function taskOrThrow(services: RuntimeServices, taskId: string): TaskView {
  return services.tasks.get(taskId) ?? notFound('Task', { taskId });
}

function priorityOf(o: Obj): Task['priority'] | undefined {
  const value = optNum(o, 'priority', { min: 0, max: 2 });
  return value === undefined ? undefined : PRIORITIES[value];
}

function widgetOf(o: Obj): UiBlock | undefined {
  if (o.widget === undefined || o.widget === null) return undefined;
  const result = validateBlock(o.widget);
  if (!result.ok) bad('widget', `a valid block (${result.error})`);
  return result.block;
}

function filterOf(params: unknown): TaskFilter {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'status', 'assigneeKind', 'assigneeId', 'spaceId', 'search', 'includeSteps', 'limit', 'completedSince']);
  const status = optStrings(o, 'status', { maxItems: STATUSES.length, max: 20 });
  if (status?.some((value) => !(STATUSES as readonly string[]).includes(value))) bad('status', `statuses from ${STATUSES.join(', ')}`);
  return {
    conversationId: optId(o, 'conversationId'), status: status as TaskStatus[] | undefined, assigneeKind: optOneOf(o, 'assigneeKind', ASSIGNEES),
    assigneeId: optId(o, 'assigneeId'), spaceId: optId(o, 'spaceId'), search: optText(o, 'search', { max: 200, allowEmpty: true }),
    includeSteps: optBool(o, 'includeSteps'), limit: optNum(o, 'limit', { min: 1, max: 1000 }),
    completedSince: optNum(o, 'completedSince', { min: 0 }),
  };
}

function createInput(params: unknown): CreateTaskInput {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'title', 'notes', 'steps', 'assigneeKind', 'assigneeId', 'dueAt', 'priority', 'doneWhen', 'dependsOn', 'mode', 'parentId', 'widget', 'humanReason', 'clientId', 'model']); // model: accepted from older clients, not used
  return {
    conversationId: optId(o, 'conversationId'), title: text(o, 'title', { max: 300 }), notes: optText(o, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }),
    steps: optStrings(o, 'steps', { maxItems: 100, max: 300 }), assigneeKind: optOneOf(o, 'assigneeKind', ASSIGNEES), assigneeId: optId(o, 'assigneeId'),
    dueAt: optNum(o, 'dueAt', { min: 0 }), priority: priorityOf(o), doneWhen: optText(o, 'doneWhen', { max: 2000, multiline: true }),
    mode: optText(o, 'mode', { max: 60 }), parentId: optId(o, 'parentId'), widget: widgetOf(o), humanReason: optOneOf(o, 'humanReason', REASONS),
    clientId: optText(o, 'clientId', { max: 100 }), dependsOn: optIds(o, 'dependsOn', 50),
  };
}

/** Patch for tasks.update: null clears optional fields (JSON has no undefined). */
function patchOf(value: unknown): Partial<Task> {
  const o = input(value);
  onlyKeys(o, PATCH_KEYS, 'patch');
  const patch: Partial<Task> = {};
  if ('title' in o) patch.title = text(o, 'title', { max: 300 });
  if ('notes' in o) patch.notes = optText(o, 'notes', { max: MAX_NOTES, allowEmpty: true, multiline: true }) ?? '';
  if ('dueAt' in o) patch.dueAt = optNum(o, 'dueAt', { min: 0 });
  if ('priority' in o) patch.priority = priorityOf(o) ?? 0;
  if ('doneWhen' in o) patch.doneWhen = optText(o, 'doneWhen', { max: 2000, multiline: true });
  if ('dependsOn' in o) patch.dependsOn = optIds(o, 'dependsOn', 50) ?? [];
  if ('mode' in o) patch.mode = optText(o, 'mode', { max: 60 });
  if ('assigneeKind' in o) patch.assigneeKind = optOneOf(o, 'assigneeKind', ASSIGNEES);
  if ('assigneeId' in o) patch.assigneeId = optId(o, 'assigneeId');
  if ('sort' in o) patch.sort = optNum(o, 'sort', { integer: false, min: -1e15, max: 1e15 });
  for (const key of Object.keys(patch) as Array<keyof Task>) {
    // Keys the service must not clear stay out when null was sent for them.
    if (patch[key] === undefined && (key === 'assigneeKind' || key === 'sort' || key === 'title')) delete patch[key];
  }
  return patch;
}

/** Human finishes a task: widget to-dos are answered (secret form fields stored first), everything else completes as reported. */
async function complete(params: unknown, ctx: HandlerContext): Promise<TaskView> {
  const o = input(params);
  onlyKeys(o, ['id', 'answer', 'note', 'clientId']);
  const taskId = id(o);
  const note = optText(o, 'note', { max: 2000, multiline: true });
  const clientId = optText(o, 'clientId', { max: 100 });
  const { tasks } = ctx.services;
  const task = taskOrThrow(ctx.services, taskId);
  if (ctx.scope.kind === 'device' && !ctx.scope.capabilities.includes('tasks') && task.assigneeKind !== 'human') {
    throw new WorkforceError('forbidden', 'This device can only finish your own to-dos.');
  }
  capJson('answer', o.answer, 256 * 1024);
  if (task.widget) {
    const typed = o.answer !== undefined ? o.answer : { done: true, ...(note ? { note } : {}) };
    const view = await answerWithSecrets(ctx.services, { taskId }, typed, { secure: secureScope(ctx.scope) },
      (answer) => tasks.answer({ taskId, answer, by: HUMAN_ID, clientId }));
    return view ?? taskOrThrow(ctx.services, taskId);
  }
  return tasks.complete(taskId, {
    summary: note?.trim() || 'Done', evidence: [], verification: 'reported_by_human', ...(o.answer !== undefined ? { answer: o.answer } : {}),
  }, HUMAN_ID);
}

/** Reorders within the slots the tasks already occupy, so other tasks keep their places. */
function reorder(params: unknown, ctx: HandlerContext): { ok: true } {
  const order = ids(input(params), 'ids', 500);
  const tasks = order.map((taskId) => taskOrThrow(ctx.services, taskId));
  const slots = tasks.map((task) => task.sort).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 0.001;
  tasks.forEach((task, index) => {
    if (task.sort !== slots[index]) ctx.services.tasks.update(task.id, { sort: slots[index] }, HUMAN_ID);
  });
  return { ok: true };
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- tasks
  table.add('tasks.list', (params, ctx) => ctx.services.tasks.list(filterOf(params)), TASKS);
  table.add('tasks.get', (params, ctx) => taskOrThrow(ctx.services, id(input(params))), TASKS);
  table.add('tasks.create', (params, ctx) => ctx.services.tasks.create({ ...createInput(params), createdBy: HUMAN_ID }), TASKS);
  table.add('tasks.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'rev', 'patch']);
    return ctx.services.tasks.update(taskOrThrow(ctx.services, id(o)).id, patchOf(o.patch), HUMAN_ID, optNum(o, 'rev', { min: 0 }));
  }, TASKS);
  table.add('tasks.setStatus', (params, ctx) => {
    const o = input(params);
    const task = taskOrThrow(ctx.services, id(o));
    return ctx.services.tasks.setStatus(task.id, optOneOf(o, 'status', STATUSES) ?? bad('status', STATUSES.join(', ')), HUMAN_ID, optText(o, 'note', { max: 2000, multiline: true }));
  }, TASKS);
  table.add('tasks.complete', (params, ctx) => complete(params, ctx), TODO);
  table.add('tasks.reorder', (params, ctx) => reorder(params, ctx), TASKS);
  table.add('tasks.delete', (params, ctx) => {
    ctx.services.tasks.remove(taskOrThrow(ctx.services, id(input(params))).id, HUMAN_ID);
    return { ok: true };
  }, TASKS);

  registerTaskLinks(table, taskOrThrow); // B-054: tasks.share

  // ---------------------------------------------------------------- human to-dos
  table.add('todos.list', (params, ctx) => ctx.services.tasks.todos(optNum(input(params), 'limit', { min: 1, max: 200 }) ?? 50), TODO);
  table.add('todos.add', (params, ctx) => {
    const o = input(params);
    return ctx.services.tasks.addTodo(text(o, 'text', { max: 4000, multiline: true }), optId(o, 'conversationId'));
  }, TODO);
  table.add('todos.changeWidget', (params, ctx) => {
    const o = input(params);
    return ctx.services.tasks.changeWidget(taskOrThrow(ctx.services, id(o)).id, text(o, 'type', { max: 40 }));
  }, TODO);
  // Snooze (F03): by to-do id or by the chat block it came from; minutes from now or an exact time.
  table.add('todos.snooze', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'messageId', 'blockIndex', 'minutes', 'until']);
    const minutes = optNum(o, 'minutes', { min: 1, max: 30 * 24 * 60 });
    const until = optNum(o, 'until', { min: 0 });
    if ((minutes === undefined) === (until === undefined)) bad('minutes', 'either minutes or until');
    const when = until ?? ctx.services.clock.now() + minutes! * 60_000;
    const ref = o.id !== undefined ? id(o) : { messageId: id(o, 'messageId'), blockIndex: num(o, 'blockIndex', { min: 0, max: 1000 }) };
    if (typeof ref === 'string') taskOrThrow(ctx.services, ref);
    return ctx.services.tasks.snooze(ref, when);
  }, TODO);
  table.add('todos.stopRepeating', (params, ctx) => {
    return ctx.services.tasks.stopRepeating(taskOrThrow(ctx.services, id(input(params))).id, HUMAN_ID);
  }, TODO);
  // "Give to me": the person's own unfinished work becomes their to-do ('tasks').
  table.add('tasks.makeMine', (params, ctx) => makeMine(ctx.services, taskOrThrow(ctx.services, id(input(params))).id), TASKS);
  // F06 "Can't do this…": the person declines a to-do (cancelled, receipt, its author woken with the
  // reason). Remove: only to-dos the person added.
  table.add('todos.decline', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'reason', 'clientId']);
    const taskId = taskOrThrow(ctx.services, id(o)).id;
    const reason = optText(o, 'reason', { max: MAX_DECLINE_REASON, allowEmpty: true });
    const view = ctx.services.tasks.answer({ taskId, answer: declineAnswer(reason), by: HUMAN_ID, clientId: optText(o, 'clientId', { max: 100 }), decline: true });
    return view ?? taskOrThrow(ctx.services, taskId);
  }, TODO);
  table.add('todos.remove', (params, ctx) => {
    removeTodo(ctx.services.tasks, taskOrThrow(ctx.services, id(input(params))).id);
    return { ok: true };
  }, TODO);

  // ---------------------------------------------------------------- schedules
  table.add('schedules.list', (params, ctx) => {
    const o = input(params);
    return ctx.services.scheduler.list({ conversationId: optId(o, 'conversationId'), ownerId: optId(o, 'ownerId') });
  }, TASKS);
  table.add('schedules.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'active', 'spec', 'title', 'body', 'priority', 'mentions']);
    const scheduleId = id(o);
    const current = ctx.services.scheduler.get(scheduleId) ?? notFound('Schedule', { scheduleId });
    const patch: Parameters<RuntimeServices['scheduler']['update']>[1] = {};
    const active = optBool(o, 'active');
    if (active !== undefined) patch.active = active;
    const spec = optObj(o, 'spec');
    if (spec) patch.spec = spec as ScheduleSpec; // validated by the scheduler
    // T11: rewording the person's own message or task post (schedules/post.ts refuses agents' ones).
    const reword = { body: optText(o, 'body', { max: 100_000, multiline: true }), priority: optOneOf(o, 'priority', POST_PRIORITIES), mentions: optIds(o, 'mentions', 50) };
    if (reword.body !== undefined || reword.priority !== undefined || reword.mentions !== undefined) Object.assign(patch, rewordPost(current, reword));
    const title = optText(o, 'title', { max: 120 });
    if (title !== undefined) patch.title = title;
    const updated = ctx.services.scheduler.update(scheduleId, patch, HUMAN_ID); // B-044: the person's pause only the person lifts
    snoozeChanged(ctx.services, updated);
    return updated;
  }, MANAGE);
  /** T11: read-only next-run preview for the schedule dialog (the chat tier schedules messages). */
  table.add('schedules.preview', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['spec', 'count', 'runs']);
    const spec = optObj(o, 'spec') ?? bad('spec', 'a schedule spec ({at} | {cron} | {everyMs} | {times})');
    const options = { count: optNum(o, 'count', { min: 1, max: PREVIEW_MAX }), runs: optNum(o, 'runs', { min: 0 }) };
    return { times: previewTimes(spec as ScheduleSpec, ctx.services.clock.now(), options) };
  }, { capability: 'chat' });
  table.add('schedules.delete', (params, ctx) => {
    const scheduleId = id(input(params));
    const schedule = ctx.services.scheduler.get(scheduleId) ?? notFound('Schedule', { scheduleId });
    ctx.services.scheduler.remove(scheduleId);
    snoozeChanged(ctx.services, schedule);
    return { ok: true };
  }, MANAGE);
  table.add('schedules.runNow', (params, ctx) => {
    ctx.services.scheduler.runNow(id(input(params)));
    return { ok: true };
  }, MANAGE);
}
