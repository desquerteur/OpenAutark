// Task tools: the "simplified Asana" seen from an agent – create, claim, assign, update and complete tasks with a
// result (summary, evidence, also handled, follow-ups), and list them. One task model: work is a task, steps are
// child tasks (parentId), the person's work is a task owned by 'human' (human.ask). Any agent may work on any task
// it can read (every task except one the person marked "Only me", tasks/access.ts). B-054: a task needs no chat –
// tasks.create hands it over in the run's chat or chatId (util.ts chatIfAny), else the parent's chat when the agent
// is in it, else in none, with the run's origin; a colleague (per_…) gets work through a chat with them.
// B-078 (honest tasks): a step I create for myself under my own task is a line of its plan (ledger.plan), not a
// task of its own that waits to be started; tasks.complete's alsoHandled is the team's report to everyone (Work).
// Owns: tasks.create, tasks.update, tasks.claim, tasks.assign, tasks.complete, tasks.list.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import type { Evidence, TaskStatus, TaskView } from '../../../shared/model/tasks.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { chatIfAny, clip, defineTool, internal, isMember, parseWhen, readChat, resolveChat } from './util.ts';
import { canReadTask } from '../../tasks/access.ts';
import { isPersonId } from '../../../shared/model/people.ts';

const STATUSES: TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked', 'done', 'cancelled'];

/** The task – only when the agent may read it; otherwise it does not exist for it. */
function requireTask(ctx: ToolContext, id: string): TaskView {
  const task = ctx.services.tasks.get(id);
  if (!task || !canReadTask(ctx.services, ctx.agent.id, task)) throw new WorkforceError('not_found', `Task ${id} not found.`);
  return task;
}

/** Short task line for listings. */
export function taskLine(task: TaskView): string {
  const who = task.assigneeKind === 'agent' ? task.assigneeId : task.assigneeKind;
  const steps = task.progress.total ? ` (${task.progress.done}/${task.progress.total})` : '';
  return `${task.id} [${task.status}] ${clip(task.title, 120)}${steps} · ${who}${task.dueAt ? ` · due ${new Date(task.dueAt).toISOString()}` : ''}`;
}

const createTask = defineTool<{ title: string; notes?: string; steps?: string[]; chatId?: string; assignee?: string; dueAt?: string; priority?: number; doneWhen?: string; mode?: string; parentId?: string; dependsOn?: string[] }>({
  name: 'tasks.create',
  description: 'Create a task: work for me (default), a colleague or the team. It is handed over in this run\'s chat, or in chatId; a run without a chat creates it on its own – tasks need no chat. assignee: "self" (default), "team" (the responsible manager decides who does it), an agent id or a colleague’s per_… id (given in a chat with them). doneWhen: a checkable done-condition. parentId: a step of that task (my own step under my own task becomes a line of its plan). dependsOn: tasks it comes after; its owner is woken when the last of them ended.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 300 }, notes: { type: 'string', maxLength: 20_000 },
      steps: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50 }, chatId: { type: 'string' },
      assignee: { type: 'string' }, dueAt: { type: 'string' }, priority: { type: 'integer', minimum: 0, maximum: 2 },
      doneWhen: { type: 'string', maxLength: 2000 }, mode: { type: 'string' }, parentId: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
    required: ['title'], additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`Create task "${clip(args.title, 80)}"`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const parent = args.parentId ? requireTask(ctx, args.parentId) : undefined;
    for (const after of args.dependsOn ?? []) requireTask(ctx, after);
    const conversationId = chatIfAny(ctx, args.chatId)
      ?? (parent?.conversationId && isMember(ctx, parent.conversationId) ? parent.conversationId : undefined);
    const assignee = args.assignee ?? 'self';
    if (assignee === 'human') return failure('Use human.ask for things the person does.');
    const person = isPersonId(assignee); // F-52: a human colleague in that chat (TaskService checks membership)
    if (person && !conversationId) return failure(`A colleague gets work through a chat with them: pass chatId (chat.send {to:"${assignee}"} opens my 1:1).`);
    const assigneeKind = assignee === 'team' ? 'team' : person ? 'human' : 'agent';
    const assigneeId = assignee === 'self' ? ctx.agent.id : assignee === 'team' ? undefined : assignee;
    if (assigneeId && !person && !ctx.services.org.get(assigneeId)) return failure(`Unknown agent ${assigneeId}.`);
    // B-078: my own step under my own task is a line of its plan – one list I work through in that task's turns.
    if (parent && ownPlanStep(parent, ctx.agent.id, assigneeId, args)) {
      const plan = [...(parent.ledger.plan ?? []).filter((line) => line !== args.title.trim()), args.title.trim()].slice(-20);
      ctx.services.tasks.update(parent.id, { ledger: { ...parent.ledger, plan } }, ctx.agent.id);
      return json({ ok: true, planOf: parent.id, plan, note: 'A step of my own task is a line of its plan; I work through the plan in this task\'s turns and finish the task with tasks.complete.' });
    }
    const task = ctx.services.tasks.create({
      conversationId, title: args.title, notes: args.notes, steps: args.steps, assigneeKind, assigneeId,
      dueAt: parseWhen(args.dueAt, ctx.services.clock.now()), priority: (args.priority ?? 0) as 0 | 1 | 2, doneWhen: args.doneWhen, mode: args.mode,
      parentId: args.parentId ?? undefined, createdBy: ctx.agent.id, dependsOn: args.dependsOn,
      ...(ctx.origin ? { origin: ctx.origin } : {}), // B-054: why it exists – the run's origin (runtime-written)
    });
    return json({ ok: true, taskId: task.id, status: task.status, steps: task.steps.map((step) => ({ id: step.id, title: step.title })) });
  },
});

/** A step I would create for myself under a task I own (no steps, schedule or dependency of its own): a plan line. */
function ownPlanStep(parent: TaskView, me: string, assigneeId: string | undefined, args: { notes?: string; steps?: string[]; dependsOn?: string[]; dueAt?: string; doneWhen?: string }): boolean {
  if (parent.assigneeKind !== 'agent' || parent.assigneeId !== me || assigneeId !== me) return false;
  if (parent.status === 'done' || parent.status === 'cancelled') return false;
  return !args.steps?.length && !args.dependsOn?.length && !args.dueAt && !args.doneWhen && !(args.notes && args.notes.trim().length > 300);
}

const updateTask = defineTool<{ taskId: string; title?: string; notes?: string; dueAt?: string; priority?: number; doneWhen?: string; status?: string; note?: string; rev?: number; plan?: string[]; fact?: string; dependsOn?: string[] }>({
  name: 'tasks.update',
  description: 'Change a task\'s details, or its status with a short note (finish with tasks.complete). plan: the steps I intend (replaces the old plan). fact: one line I learned, kept across turns and handoffs. dependsOn: the tasks it comes after (replaces the list).',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 300 }, notes: { type: 'string', maxLength: 20_000 },
      dueAt: { type: 'string' }, priority: { type: 'integer', minimum: 0, maximum: 2 }, doneWhen: { type: 'string' },
      status: { type: 'string', enum: STATUSES.filter((status) => status !== 'done') }, note: { type: 'string', maxLength: 2000 }, rev: { type: 'integer' },
      plan: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, maxItems: 20 },
      fact: { type: 'string', minLength: 1, maxLength: 500 },
      dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
    required: ['taskId'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Update task ${args.taskId}`, args.taskId),
  async run(args, ctx) {
    const current = requireTask(ctx, args.taskId);
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.dueAt !== undefined) patch.dueAt = parseWhen(args.dueAt, ctx.services.clock.now());
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.doneWhen !== undefined) patch.doneWhen = args.doneWhen;
    if (args.dependsOn !== undefined) { for (const after of args.dependsOn) requireTask(ctx, after); patch.dependsOn = args.dependsOn; }
    if (args.plan !== undefined || args.fact !== undefined) {
      // Merged into the current ledger (other ledger fields stay); facts are kept once, newest last, at most 20.
      const ledger = { ...current.ledger };
      if (args.plan !== undefined) ledger.plan = args.plan.map((step) => step.trim()).filter(Boolean).slice(0, 20);
      if (args.fact?.trim()) ledger.facts = [...(ledger.facts ?? []).filter((fact) => fact !== args.fact!.trim()), args.fact.trim()].slice(-20);
      patch.ledger = ledger;
    }
    let view = Object.keys(patch).length ? ctx.services.tasks.update(args.taskId, patch, ctx.agent.id, args.rev) : current;
    if (args.status) view = ctx.services.tasks.setStatus(args.taskId, args.status as TaskStatus, ctx.agent.id, args.note);
    return json({ ok: true, taskId: view.id, status: view.status, rev: view.rev });
  },
});

const claimTask = defineTool<{ taskId: string }>({
  name: 'tasks.claim',
  description: 'Take ownership of an open team task. Fails if someone else already has it.',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Claim task ${args.taskId}`, args.taskId),
  async run(args, ctx) {
    requireTask(ctx, args.taskId);
    const ok = ctx.services.tasks.claim(args.taskId, ctx.agent.id);
    return ok ? json({ ok: true, taskId: args.taskId }) : failure('Someone else already owns this task.');
  },
});

const assignTask = defineTool<{ taskId: string; assignee: string; note?: string }>({
  name: 'tasks.assign',
  description: 'Give a task to an agent id, a colleague’s per_… id, back to the team ("team") or to myself ("self").',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, assignee: { type: 'string' }, note: { type: 'string' } }, required: ['taskId', 'assignee'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`Assign task ${args.taskId} to ${args.assignee}`, args.taskId),
  async run(args, ctx) {
    const task = requireTask(ctx, args.taskId);
    if (args.assignee === 'human') return failure('Use human.ask for things the person does.');
    const id = args.assignee === 'self' ? ctx.agent.id : args.assignee;
    const person = isPersonId(id); // F-52: a colleague
    if (id !== 'team' && !person && !ctx.services.org.get(id)) return failure(`Unknown agent ${id}.`);
    // Open unowned work for oneself is the atomic claim (it fails when someone else just took it).
    if (id === ctx.agent.id && task.assigneeKind === 'team' && task.status === 'open') {
      return ctx.services.tasks.claim(task.id, id) ? json({ ok: true, taskId: task.id, assignee: id }) : failure('Someone else already owns this task.');
    }
    const view = ctx.services.tasks.assign(args.taskId, id === 'team' ? { kind: 'team' } : person ? { kind: 'human', id } : { kind: 'agent', id }, ctx.agent.id);
    return json({ ok: true, taskId: view.id, assignee: view.assigneeId ?? view.assigneeKind });
  },
});

const completeTask = defineTool<{ taskId: string; summary: string; evidence?: Evidence[]; alsoHandled?: string[]; followUps?: Array<{ label: string; scheduleId?: string; taskId?: string }>; notify?: boolean }>({
  name: 'tasks.complete',
  description: 'Finish a task with a documented result: summary, evidence, alsoHandled and the follow-ups I scheduled. I check the result against its doneWhen first. alsoHandled is our team\'s report to everyone (the Work view shows it): one line each for side work nobody asked for, things I fixed on the way (a full disk, a renewal, a failed job) and facts everyone should know. notify: false: the "Done" line stays in the chat without a notification.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string' }, summary: { type: 'string', minLength: 1, maxLength: 4000 },
      evidence: {
        type: 'array', maxItems: 30,
        items: { type: 'object', properties: { kind: { type: 'string', enum: ['file', 'link', 'tool', 'check', 'note', 'screenshot'] }, label: { type: 'string', minLength: 1 }, ref: { type: 'string' } }, required: ['kind', 'label'] },
      },
      alsoHandled: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 20 },
      followUps: { type: 'array', maxItems: 20, items: { type: 'object', properties: { label: { type: 'string', minLength: 1 }, scheduleId: { type: 'string' }, taskId: { type: 'string' } }, required: ['label'] } },
      notify: { type: 'boolean' },
    },
    required: ['taskId', 'summary'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Complete task ${args.taskId}`, args.taskId),
  async run(args, ctx) {
    requireTask(ctx, args.taskId);
    const view = ctx.services.tasks.complete(args.taskId, {
      summary: args.summary, evidence: args.evidence ?? [], alsoHandled: args.alsoHandled, followUps: args.followUps,
      verification: 'claimed_by_agent', ...(args.notify === false ? { notify: false } : {}), // B-047 D4: a quiet finish
    }, ctx.agent.id);
    return json({ ok: view.status === 'done', taskId: view.id, status: view.status });
  },
});

const listTasks = defineTool<{ chatId?: string; status?: string[]; mine?: boolean; search?: string; limit?: number }>({
  name: 'tasks.list',
  description: 'List tasks (my own with mine=true, or of a chat). Default: unfinished tasks.',
  inputSchema: {
    type: 'object',
    properties: { chatId: { type: 'string' }, status: { type: 'array', items: { type: 'string', enum: STATUSES } }, mine: { type: 'boolean' }, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    additionalProperties: false,
  },
  category: 'read',
  describe: () => internal('List tasks'),
  async run(args, ctx) {
    if (args.chatId) resolveChat(ctx, args.chatId, { read: true });
    const status = (args.status as TaskStatus[] | undefined) ?? ['open', 'working', 'waiting', 'needs_you', 'blocked'];
    const tasks = ctx.services.tasks.list({
      conversationId: args.chatId, status, assigneeId: args.mine ? ctx.agent.id : undefined,
      assigneeKind: args.mine ? 'agent' : undefined, search: args.search, limit: 300, readableBy: ctx.agent.id,
    }).slice(0, args.limit ?? 30);
    return text(tasks.length ? tasks.map(taskLine).join('\n') : 'No tasks.');
  },
});

export const taskTools: ToolDef[] = [createTask, updateTask, claimTask, assignTask, completeTask, listTasks];
