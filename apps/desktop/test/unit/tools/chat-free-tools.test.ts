// B-054 (owner 29.10.2026: tasks and to-dos belong to no chat): the work tools in a run without a chat.
// tasks.create, human.ask, schedules.routine and agents.delegate / agents.handoff create their work chat-free
// (with the run's origin) and open no chat; a colleague (per_…) without a chat is refused with the way to reach
// them; in a chat run the agent is a member of, the work is handed over there as before; a routine without a chat
// fires a chat-free task with the routine origin, one whose chat is gone ends; the chat-only tools say what to do
// instead (resolveChat's no-chat text).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { humanTools } from '../../../src/runtime/tools/builtin/human.ts';
import { scheduleTools } from '../../../src/runtime/tools/builtin/schedule.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import { delegate, handoff } from '../../../src/runtime/agents/handoff.ts';
import { ScheduleGone, fireSchedule, scheduleOrigin } from '../../../src/runtime/schedules/fire.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import type { Origin } from '../../../src/shared/model/origin.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../../../src/runtime/tools/types.ts';

const MAIL: Origin = { source: 'app:app_mail1', label: 'New mail in office@example.com' };
const ANNA = 'per_anna000000';
const tools: ToolDef[] = [...taskTools, ...humanTools, ...scheduleTools, ...chatTools];
const textOf = (out: ToolOutput) => out.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function rig(t: { after(fn: () => void): void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_lea', 'Lea'));
  Object.assign(f.org, { canManage: (viewer: string) => viewer === 'human' }); // no agent manages another here
  f.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', 0, 0)`, [ANNA]);
  f.services.settings.update({ profile: { timezone: 'UTC' } });
  (f.services as { modes: unknown }).modes = { list: () => [{ key: 'general', name: 'General' }, { key: 'video', name: 'Video' }] };
  const s = f.services as RuntimeServices;
  const ctx = (extra: Partial<ToolContext> = {}, agentId = 'ag_ava'): ToolContext => ({
    agent: f.org.get(agentId)!, runId: 'run_1', mode: 'general', services: s, signal: new AbortController().signal, status() {}, origin: MAIL, ...extra,
  }) as ToolContext;
  const call = async (name: string, args: Record<string, unknown>, extra: Partial<ToolContext> = {}, agentId?: string) => {
    let out: ToolOutput;
    try { out = await tools.find((tool) => tool.name === name)!.run(args as never, ctx(extra, agentId)); } catch (error) { return { error: true, text: `ERROR ${(error as Error).message}`, data: undefined }; }
    const text = textOf(out);
    return { error: out.isError === true, text, data: out.isError ? undefined : (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; } })() };
  };
  const chatCount = () => f.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n;
  return { f, s, ctx, call, chatCount };
}

test('tasks.create without a chat: a chat-free task with the run\'s origin, no chat opened', async (t) => {
  const { f, call, chatCount } = rig(t);
  const chats = chatCount();
  const out = await call('tasks.create', { title: 'Prepare the offer for Maria', doneWhen: 'Offer sent', dueAt: '+2d' });
  assert.equal(out.error, false, out.text);
  assert.doesNotMatch(out.text, /No chat given|Chat not found|needs a chat/);
  const task = f.tasks.get(String(out.data?.taskId))!;
  assert.equal(task.conversationId, undefined);
  assert.equal(task.messageId, undefined, 'no anchor card anywhere');
  assert.equal(task.assigneeId, 'ag_ava');
  assert.deepEqual(task.origin, MAIL, 'the run\'s origin');
  assert.equal(chatCount(), chats, 'no chat was opened');
});

test('tasks.create for a colleague without a chat is refused with the way to reach them', async (t) => {
  const { f, call } = rig(t);
  const before = f.tasks.list({}).length;
  const out = await call('tasks.create', { title: 'Check the contract', assignee: ANNA });
  assert.equal(out.error, true);
  assert.match(out.text, /A colleague gets work through a chat with them: pass chatId \(chat\.send \{to:"per_anna000000"\} opens my 1:1\)/);
  assert.equal(f.tasks.list({}).length, before, 'nothing was created');
});

test('tasks.create in a chat run: handed over there when the agent is a member, chat-free when it is not', async (t) => {
  const { f, call } = rig(t);
  const group = f.chats.create({ agentIds: ['ag_ava', 'ag_lea'], createdBy: 'human' });
  const inChat = await call('tasks.create', { title: 'Prepare the offer by Friday' }, { conversationId: group.id, origin: undefined });
  assert.equal(inChat.error, false, inChat.text);
  assert.equal(f.tasks.get(String(inChat.data?.taskId))!.conversationId, group.id);
  const foreign = f.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  const outside = await call('tasks.create', { title: 'Follow up' }, { conversationId: foreign.id });
  assert.equal(outside.error, false, outside.text);
  assert.equal(f.tasks.get(String(outside.data?.taskId))!.conversationId, undefined, 'never into a chat the agent is not in');
  const named = await call('tasks.create', { title: 'Into that chat', chatId: foreign.id });
  assert.equal(named.error, true, 'an explicit chat still needs membership');
});

test('tasks.create with a parent: the parent\'s chat when the agent is in it, else none', async (t) => {
  const { f, call } = rig(t);
  const group = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const parent = f.tasks.create({ conversationId: group.id, title: 'Launch', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const step = await call('tasks.create', { title: 'Write the copy', parentId: parent.id, steps: ['Draft', 'Polish'] }); // with steps of its own: a task (B-078: a bare own step is a plan line)
  assert.equal(step.error, false, step.text);
  assert.equal(f.tasks.get(String(step.data?.taskId))!.conversationId, group.id);
  const free = await call('tasks.create', { title: 'Chat-free root' });
  const child = await call('tasks.create', { title: 'Its step', parentId: String(free.data?.taskId), steps: ['One'] });
  assert.equal(child.error, false, child.text);
  assert.equal(f.tasks.get(String(child.data?.taskId))!.conversationId, undefined);
});

test('human.ask without a chat: a chat-free to-do on the owner\'s My day', async (t) => {
  const { f, call, chatCount } = rig(t);
  const chats = chatCount();
  const out = await call('human.ask', { title: 'Which newsletter text?', reason: 'taste', widget: { type: 'choice', question: 'Which one?', options: ['A', 'B'] } });
  assert.equal(out.error, false, out.text);
  const todo = f.tasks.get(String(out.data?.todoId))!;
  assert.equal(todo.conversationId, undefined);
  assert.equal(todo.assigneeKind, 'human');
  assert.equal(todo.assigneeId, undefined, 'the owner');
  assert.deepEqual(todo.origin, MAIL);
  assert.equal(chatCount(), chats);
});

test('schedules.routine without a chat fires a chat-free task with the routine origin; a reminder carries its origin', async (t) => {
  const { f, s, call } = rig(t);
  const out = await call('schedules.routine', { title: 'Morning check', task: { title: 'Morning check' }, when: { once: '+1h' } });
  assert.equal(out.error, false, out.text);
  const schedule = f.scheduler.get(String(out.data?.scheduleId))!;
  assert.equal(schedule.conversationId, undefined);
  fireSchedule(schedule, f.clock.now(), s);
  const task = f.tasks.list({}).find((item) => item.title === 'Morning check')!;
  assert.ok(task, 'the routine created its task');
  assert.equal(task.conversationId, undefined);
  assert.deepEqual(task.origin, { source: `schedule:${schedule.id}`, label: 'Routine "Morning check"' });
  const wake = f.wakes.list('ag_ava').find((item) => item.taskId === task.id && item.reason === 'schedule')!;
  assert.equal(wake.reason, 'schedule');
  assert.equal(wake.conversationId, undefined);
  assert.deepEqual(wake.origin, scheduleOrigin(schedule));

  const reminder = await call('schedules.remind', { note: 'Check the reply', when: { once: '+2h' } });
  const stored = f.scheduler.get(String(reminder.data?.scheduleId))!;
  fireSchedule(stored, f.clock.now(), s);
  assert.deepEqual(f.wakes.list('ag_ava').find((item) => item.note === 'Check the reply')?.origin, { source: `schedule:${stored.id}`, label: 'Reminder' });

  const gone = { ...schedule, id: 'sch_gone', conversationId: 'cv_removed' } as Schedule;
  assert.throws(() => fireSchedule(gone, f.clock.now(), s), ScheduleGone, 'a routine whose chat was set and is gone ends');
  assert.throws(() => f.scheduler.create({ ownerId: 'ag_ava', kind: 'message', title: 'x', spec: { at: f.clock.now() + 3_600_000 }, payload: {} }), /is posted in a chat: pass chatId/);
});

test('agents.delegate without a chat: a chat-free child, nobody joins any chat, the wake carries only the task', (t) => {
  const { f, ctx, chatCount } = rig(t);
  const parent = f.tasks.create({ title: 'Summarise the Travel Desk items', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const chats = chatCount();
  const out = delegate(ctx({ taskId: parent.id }), { to: 'ag_lea', title: 'Look up the prices' });
  const child = f.tasks.get(out.taskId)!;
  assert.equal(child.conversationId, undefined);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.assigneeId, 'ag_lea');
  assert.equal(out.chatId, undefined);
  const wake = f.wakes.list('ag_lea').find((item) => item.taskId === child.id)!;
  assert.equal(wake.reason, 'handoff');
  assert.equal(wake.conversationId, undefined);
  assert.equal(f.tasks.get(parent.id)!.status, 'waiting', 'the delegator\'s task waits on the child');
  const own = delegate(ctx({ taskId: parent.id }), { to: 'video', title: 'Cut the clip' });
  assert.equal(own.chatId, undefined, 'mode work gets a work chat only from a source chat');
  assert.equal(chatCount(), chats, 'no chat was opened');
});

test('agents.handoff of a chat-free task: handed on without any chat', (t) => {
  const { f, ctx } = rig(t);
  const task = f.tasks.create({ title: 'Answer Maria', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const out = handoff(ctx({ taskId: task.id }), { to: 'ag_lea', next: 'Send the offer' });
  assert.equal(out.to, 'ag_lea');
  assert.equal(f.tasks.get(task.id)!.assigneeId, 'ag_lea');
  const wake = f.wakes.list('ag_lea').find((item) => item.taskId === task.id)!;
  assert.equal(wake.conversationId, undefined);
});

test('chat-only tools say what to do instead in a run without a chat', async (t) => {
  const { call } = rig(t);
  const read = await call('chat.read', {});
  assert.match(read.text, /^ERROR This run is in no chat\. .*chat\.send \{to\}\. Tasks and to-dos need no chat\./);
});

test('B-054 fix: agents.delegate takes a colleague by a unique name', async (t) => {
  const { f, ctx } = rig(t);
  const out = delegate(ctx({ origin: undefined }), { to: 'lea', title: 'Find the venue' });
  assert.equal(out.to, 'ag_lea');
  assert.equal(f.tasks.get(out.taskId)?.assigneeId, 'ag_lea');
  assert.throws(() => delegate(ctx(), { to: 'Nobody', title: 'x' }), /agents\.list has the agent ids/);
});
