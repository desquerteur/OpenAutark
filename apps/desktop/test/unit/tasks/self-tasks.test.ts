// Tests for self-tasks and lead-less team tasks (src/runtime/tasks/lifecycle.ts, owners.ts):
// a task an agent opens for itself is always woken once (coalesced, after the current turn),
// steps/human to-dos/finished tasks get no wake, a finished task reopened by someone else wakes
// its owner, progressing continuations are paced (20 an hour at 1 s, then 5 min), a routine fire
// plus the own-task wake run as one turn, and team work in a chat without a lead goes to the
// responsible manager (or says quietly that no agent can pick it up); an agent outside such a
// chat never brings anyone in.
// Owns: these assertions only. Never: real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import { fireSchedule } from '../../../src/runtime/schedules/fire.ts';
import { responsibleManager } from '../../../src/runtime/tasks/owners.ts';
import { NO_AGENT_LINE } from '../../../src/runtime/tasks/lifecycle.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_mara', 'Mara', { mode: 'manager', createdAt: 1 }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mara', createdAt: 2 }));
  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_tom'], createdBy: 'human' });
  const wakesFor = (taskId: string) => h.wakeRows().filter(row => row.task_id === taskId);
  const lines = (conversationId = chat.id) => h.chats.messages(conversationId).filter(m => m.kind === 'status').map(m => m.body);
  return { ...h, chat, wakesFor, lines };
}

function ctxFor(h: ReturnType<typeof setup>, agentId = 'ag_tom'): ToolContext {
  return {
    agent: h.org.require(agentId), runId: 'run_1', conversationId: h.chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext;
}

test('an agent creating its own task (tool default "self") leaves exactly one task wake, due now', async () => {
  const h = setup();
  const create = taskTools.find(t => t.name === 'tasks.create')!;
  const out = await create.run({ title: 'Research thumbnail styles', doneWhen: 'Three styles with examples' }, ctxFor(h));
  assert.equal(out.isError, undefined);
  const task = h.tasks.list({ conversationId: h.chat.id })[0];
  assert.equal(task.assigneeId, 'ag_tom');
  assert.equal(task.createdBy, 'ag_tom');
  const rows = h.wakesFor(task.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].agent_id, rows[0].reason, rows[0].conversation_id, rows[0].due_at], ['ag_tom', 'task', h.chat.id, h.clock.now()]);
});

test('own-task wakes coalesce under task:<id> (a later task wake for it merges)', () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', steps: ['Rough cut', 'Color'], assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  h.tasks.setStatus(task.steps[0].id, 'done', 'human'); // human progress wakes the owner with task:<id> too
  const rows = h.wakesFor(task.id);
  assert.equal(rows.length, 1, 'one coalesced wake');
  assert.equal(h.wakes.pending('ag_tom'), 1);
});

test('no wake for steps, human to-dos, finished or cancelled own tasks', () => {
  const h = setup();
  const parent = h.tasks.create({ conversationId: h.chat.id, title: 'Launch video', assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  h.wakes.cancel('ag_tom');
  const step = h.tasks.create({ conversationId: h.chat.id, title: 'Export', parentId: parent.id, assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  assert.equal(h.wakesFor(step.id).length, 0, 'steps are worked inside their task');
  const todo = h.tasks.create({ conversationId: h.chat.id, title: 'Record the voice-over', assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_tom' });
  assert.equal(h.wakesFor(todo.id).length, 0, 'human to-dos wake no agent');

  // Created and finished in the same turn: the pending own-task wake is dropped.
  const quick = h.tasks.create({ conversationId: h.chat.id, title: 'Rename the file', assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  assert.equal(h.wakesFor(quick.id).length, 1);
  h.tasks.complete(quick.id, { summary: 'Renamed', evidence: [{ kind: 'note', label: 'renamed' }], verification: 'claimed_by_agent' }, 'ag_tom');
  assert.equal(h.wakesFor(quick.id).length, 0, 'a done task needs no further turn');

  const dropped = h.tasks.create({ conversationId: h.chat.id, title: 'Old idea', assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  h.tasks.setStatus(dropped.id, 'cancelled', 'ag_tom');
  assert.equal(h.wakesFor(dropped.id).length, 0);
});

test('a finished own task reopened by the person wakes its owner with the note; the owner reopening it does not', () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Draft the launch plan', assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  const finish = () => h.tasks.complete(task.id, { summary: 'Drafted', evidence: [{ kind: 'note', label: 'plan' }], verification: 'claimed_by_agent' }, 'ag_tom');
  finish();
  assert.equal(h.wakesFor(task.id).length, 0);
  h.tasks.setStatus(task.id, 'open', 'human', 'Add the budget');
  assert.deepEqual(h.wakesFor(task.id).map(row => [row.agent_id, row.reason, row.note]), [['ag_tom', 'task', 'The human reopened this task: Add the budget']]);
  finish();
  h.tasks.setStatus(task.id, 'working', 'ag_tom'); // inside its own turn: the turn's follow-up continues it
  assert.equal(h.wakesFor(task.id).length, 0);
});

test('an own task that keeps progressing continues after 1 s, every time', () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Plan the launch', assigneeId: 'ag_tom', createdBy: 'ag_tom' });
  /** One finished turn with real progress (agents/turn-progress.ts), then the delay of the next. */
  const turn = () => {
    h.wakes.done(h.wakes.claim('ag_tom', Number.MAX_SAFE_INTEGER).map(w => w.id));
    h.ownership.afterTurn({ agentId: 'ag_tom', taskId: task.id, runId: 'run_x', progressed: true, outcome: 'done' });
    const [next] = h.wakes.list('ag_tom').filter(w => w.claimedAt === undefined && w.taskId === task.id);
    const delay = next.dueAt - h.clock.now();
    h.clock.advance(delay);
    return delay;
  };
  const delays = Array.from({ length: 21 }, turn);
  assert.deepEqual(delays, Array(21).fill(1000), 'no pace limit: work that moves goes on');
});

test('a routine fire and the own-task wake form one dispatcher group (one turn)', () => {
  const h = setup();
  const schedule = h.scheduler.create({
    ownerId: 'ag_tom', conversationId: h.chat.id, kind: 'routine', title: 'Comments', spec: { at: h.clock.now() + 60_000 },
    payload: { taskTemplate: { title: 'Answer YouTube comments' }, note: 'Daily comments' },
  });
  fireSchedule(schedule, h.clock.now(), h.services);
  const task = h.tasks.list({ conversationId: h.chat.id }).find(t => t.title === 'Answer YouTube comments')!;
  assert.equal(task.assigneeId, 'ag_tom');
  const claimed = h.wakes.claim('ag_tom');
  assert.deepEqual(claimed.map(w => w.reason).sort(), ['schedule', 'task']);
  const groups = groupWakes(claimed);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].taskId, task.id);
});

test('a team task in a chat without a lead goes to the top manager: joins as system and is woken', () => {
  const h = setup();
  h.org.add(agent('ag_sub', 'Sam', { mode: 'manager', managerId: 'ag_mara', createdAt: 0 }));
  const todoChat = h.chats.create({ title: 'Errands', agentIds: [], createdBy: 'human' }).id; // a chat without agents
  assert.equal(h.chats.lead(todoChat), undefined);
  const task = h.tasks.create({ conversationId: todoChat, title: 'Book a venue for the meetup', assigneeKind: 'team', createdBy: 'human' });
  assert.ok(h.chats.members(todoChat).some(m => m.memberId === 'ag_mara'), 'the manager joined the chat');
  assert.equal(h.chats.lead(todoChat), 'ag_mara');
  const rows = h.wakesFor(task.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].agent_id, rows[0].reason], ['ag_mara', 'task']);
  assert.equal(h.tasks.get(task.id)!.status, 'open');
});

test('a team task re-assigned to "team" in a lead-less chat also reaches the responsible manager', () => {
  const h = setup();
  const todoChat = h.chats.create({ title: 'Errands', agentIds: [], createdBy: 'human' }).id; // a chat without agents
  const todo = h.tasks.create({ conversationId: todoChat, title: 'Renew the domain', assigneeKind: 'human', createdBy: 'human' });
  h.tasks.assign(todo.id, { kind: 'team' }, 'human');
  assert.deepEqual(h.wakesFor(todo.id).map(row => row.agent_id), ['ag_mara']);
});

test('an agent outside a lead-less chat brings nobody in by routing its work to "team"', async () => {
  const h = setup(); // ag_tom is a member of "Launch" only; "Errands" has no agents
  const todoChat = h.chats.create({ title: 'Errands', agentIds: [], createdBy: 'human' }).id; // a chat without agents
  const agentsIn = () => h.chats.members(todoChat).filter(m => m.kind === 'agent').map(m => m.memberId);
  const todo = h.tasks.create({ conversationId: todoChat, title: 'Renew the passport', assigneeKind: 'human', createdBy: 'human' });
  const assign = taskTools.find(t => t.name === 'tasks.assign')!;
  // Any agent may hand work on; outside the chat it brings nobody in (owners.ts mayBringIn).
  await assign.run({ taskId: todo.id, assignee: 'team' }, ctxFor(h));
  assert.deepEqual(agentsIn(), [], 'no manager was added to the person\'s chat');
  assert.equal(h.chats.lead(todoChat), undefined);
  assert.equal(h.wakesFor(todo.id).length, 0, 'nobody is woken for a chat they cannot act in');
  assert.equal(h.tasks.get(todo.id)!.status, 'open');

  // The person routing it to the team still reaches the responsible manager.
  h.tasks.assign(todo.id, { kind: 'team' }, 'human');
  assert.deepEqual(agentsIn(), ['ag_mara']);
  assert.deepEqual(h.wakesFor(todo.id).map(row => row.agent_id), ['ag_mara']);
});

test('no agents at all: a quiet "no agent" line, the task stays open, nothing throws', () => {
  const h = harness();
  const todoChat = h.chats.create({ title: 'Errands', agentIds: [], createdBy: 'human' }).id; // a chat without agents
  const task = h.tasks.create({ conversationId: todoChat, title: 'Find a tax advisor', assigneeKind: 'team', createdBy: 'human' });
  assert.equal(h.tasks.get(task.id)!.status, 'open');
  assert.equal(h.wakes.pending(), 0);
  const lines = h.chats.messages(todoChat).filter(m => m.kind === 'status').map(m => m.body);
  assert.ok(lines.includes(NO_AGENT_LINE), lines.join(' | '));

  // Routing it again (assign to team, a finished dependency) does not repeat the line.
  h.tasks.assign(task.id, { kind: 'team' }, 'human');
  h.tasks.assign(task.id, { kind: 'team' }, 'human');
  const again = h.chats.messages(todoChat).filter(m => m.kind === 'status' && m.body === NO_AGENT_LINE);
  assert.equal(again.length, 1, 'said once while it is still the latest line about the task');
});

test('responsibleManager: top-level manager first, the space manager for a space, then secretary, then any agent', () => {
  const h = harness();
  assert.equal(responsibleManager(h.org), undefined);
  h.org.add(agent('ag_work', 'Wes', { createdAt: 1 }));
  assert.equal(responsibleManager(h.org)?.id, 'ag_work', 'without a manager any active agent picks it up');
  h.org.add(agent('ag_sec', 'Sue', { mode: 'secretary', createdAt: 5 }));
  assert.equal(responsibleManager(h.org)?.id, 'ag_sec', 'a secretary before other agents');
  h.org.add(agent('ag_top', 'Mara', { mode: 'manager', spaceId: 'sp_company', createdAt: 9 }));
  h.org.add(agent('ag_sub', 'Sam', { mode: 'manager', managerId: 'ag_top', createdAt: 3 }));
  h.org.add(agent('ag_brand', 'Bea', { template: 'manager', managerId: 'ag_top', spaceId: 'sp_brand', createdAt: 4 }));
  assert.equal(responsibleManager(h.org)?.id, 'ag_top', 'the top-level manager first');
  assert.equal(responsibleManager(h.org, 'sp_brand')?.id, 'ag_brand', 'a chat in a space goes to that space\'s manager');
  h.org.add(agent('ag_top', 'Mara', { mode: 'manager', spaceId: 'sp_company', createdAt: 9, archivedAt: 10 }));
  assert.equal(responsibleManager(h.org)?.id, 'ag_sub', 'archived managers are skipped');
});

test('tasks.update keeps a plan (replaced, at most 20 steps) and facts (once each, newest last)', async () => {
  const h = setup();
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the trailer', assigneeId: 'ag_tom', createdBy: 'human' });
  const update = taskTools.find(t => t.name === 'tasks.update')!;
  await update.run({ taskId: task.id, plan: [' Rough cut ', 'Music', ''], fact: 'Footage is 4K' }, ctxFor(h));
  await update.run({ taskId: task.id, fact: 'Client wants 60 s' }, ctxFor(h));
  await update.run({ taskId: task.id, fact: 'Footage is 4K' }, ctxFor(h));
  const ledger = h.tasks.get(task.id)!.ledger;
  assert.deepEqual(ledger.plan, ['Rough cut', 'Music']);
  assert.deepEqual(ledger.facts, ['Client wants 60 s', 'Footage is 4K']);
  await update.run({ taskId: task.id, plan: Array.from({ length: 20 }, (_, i) => `Step ${i}`) }, ctxFor(h));
  assert.equal(h.tasks.get(task.id)!.ledger.plan!.length, 20);
  assert.deepEqual(h.tasks.get(task.id)!.ledger.facts, ['Client wants 60 s', 'Footage is 4K'], 'a new plan keeps the facts');
});
