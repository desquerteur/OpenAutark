// B-078 D9/D11 – asks and honest task states (src/runtime/tasks/human.ts, supersede.ts, reply-answer.ts, working.ts,
// tools/builtin/human.ts, tools/builtin/tasks.ts): only important ask blocks (and "todo": true, timers) become to-dos;
// human.ask has no 'approval' – such a call gets the agent's own self-check note and no to-do; an important human.ask
// is priority 1; a newer question of the same agent in the same chat replaces its older open one (questions of the
// same turn stay); a typed reply to the asking message completes its open to-dos with the text; 'working' ends with
// the last live run; my own step under my own task becomes a line of its plan.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { SELF_CHECK_NOTE, humanTools } from '../../../src/runtime/tools/builtin/human.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { REPLACED_NOTE } from '../../../src/runtime/tasks/supersede.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

function fixture() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const ctx = (runId = 'run_1'): ToolContext => ({
    agent: h.org.get('ag_ava')!, runId, conversationId: chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  });
  const tool = (list: ToolDef[], name: string) => list.find((entry) => entry.name === name)!;
  const call = async (name: string, args: Record<string, unknown>, runId?: string) => {
    const out = await tool([...humanTools, ...taskTools], name).run(args as never, ctx(runId));
    const text = (out.content[0] as { text: string }).text;
    return { error: out.isError === true, data: (out.isError ? { text } : JSON.parse(text)) as Record<string, unknown> };
  };
  /** Ava posts `body`; its blocks are ingested as the turn's finish does. */
  const post = (body: string) => {
    const message = h.chats.send({ conversationId: chat.id, body, authorId: 'ag_ava', authorKind: 'agent' });
    const blocks = uiBlocksOf(body);
    return { message, todos: h.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index)) };
  };
  const ui = (json: string) => '```ui\n' + json + '\n```';
  return { ...h, chat, call, post, ui };
}

test('an ordinary quick reply stays in its message; an important one, "todo": true and a timer become to-dos', () => {
  const f = fixture();
  const quick = f.post(f.ui('{"type":"choice","question":"Blue or red?","options":["Blue","Red"]}'));
  assert.equal(quick.todos.length, 0, 'no to-do for a quick reply');
  const answered = f.tasks.answer({ messageId: quick.message.id, blockIndex: 0, answer: { choice: 'Blue' }, by: HUMAN_ID });
  assert.equal(answered, undefined, 'it is answered in the message, without a to-do');
  const important = f.post(f.ui('{"type":"confirm","instructions":"Plug in the camera","important":true}'));
  assert.equal(important.todos.length, 1);
  assert.equal(important.todos[0].priority, 1, 'important is priority 1 (the strip shows it)');
  assert.equal(f.post(f.ui('{"type":"upload","label":"Your ID","todo":true}')).todos.length, 1);
  assert.equal(f.post(f.ui('{"type":"timer","label":"Tea","duration":"PT5M"}')).todos.length, 1, 'a reminder rings from the list');
  assert.equal(f.post(f.ui('{"type":"choice","question":"Ship it?","options":["Yes","No"],"priority":"high"}')).todos[0].priority, 1, 'priority high reads as important');
});

test('human.ask: no approval reason – the self-check note comes back at once, no to-do; important is priority 1', async () => {
  const f = fixture();
  const permission = await f.call('human.ask', { title: 'May I clean the VPS disk?', reason: 'approval', widget: { type: 'approve', action: 'Clean the disk' } });
  assert.equal(permission.error, false);
  assert.equal(permission.data.todo, false);
  assert.equal(permission.data.note, SELF_CHECK_NOTE);
  assert.match(SELF_CHECK_NOTE, /^This is mine to decide/);
  assert.equal(f.tasks.todos().length, 0, 'nothing lands on My day');
  const unknown = await f.call('human.ask', { title: 'x', reason: 'whatever', widget: { type: 'confirm' } });
  assert.equal(unknown.error, true);
  const sign = await f.call('human.ask', { title: 'Sign the lease?', reason: 'identity', important: true, widget: { type: 'approve', action: 'Sign the lease' } });
  const todo = f.tasks.get(String(sign.data.todoId))!;
  assert.equal(todo.priority, 1);
  assert.equal(todo.widget?.type, 'choice', 'an approve widget becomes a yes/no choice');
  assert.equal(todo.widget?.important, true);
  assert.deepEqual((todo.widget?.options as Array<{ label?: string } | string>).map((option) => (typeof option === 'string' ? option : option.label)), ['Yes', 'No']);
  const description = humanTools[0].description;
  assert.match(description, /^I put one item/);
  assert.match(description, /is mine: I handle it and put it into my report/);
  assert.doesNotMatch(description, /approve,|may |only if/i);
});

test('a newer question of the same agent in the same chat replaces its older open one; one turn\'s questions stay together', async () => {
  const f = fixture();
  const first = await f.call('human.ask', { title: 'Which logo?', reason: 'taste', widget: { type: 'choice', question: 'Which logo?', options: ['A', 'B'] } }, 'run_1');
  const sibling = await f.call('human.ask', { title: 'Which colour?', reason: 'taste', widget: { type: 'choice', question: 'Which colour?', options: ['Red', 'Blue'] } }, 'run_1');
  const timer = await f.call('human.ask', { title: 'Tea', reason: 'physical', widget: { type: 'timer', label: 'Tea', duration: 'PT10M' } }, 'run_1');
  f.clock.advance(60_000);
  f.running.push({ agentId: 'ag_ava', runId: 'run_2', conversationId: f.chat.id, note: '', startedAt: f.clock.now() });
  f.clock.advance(1000);
  const newer = await f.call('human.ask', { title: 'Which logo now?', reason: 'taste', widget: { type: 'choice', question: 'Which logo now?', options: ['C', 'D'] } }, 'run_2');
  const status = (id: unknown) => f.tasks.get(String(id))!.status;
  assert.equal(status(first.data.todoId), 'cancelled');
  assert.equal(status(sibling.data.todoId), 'cancelled');
  assert.deepEqual(f.tasks.get(String(first.data.todoId))!.ledger.facts, [REPLACED_NOTE]);
  assert.notEqual(status(timer.data.todoId), 'cancelled', 'a reminder is no question');
  assert.equal(status(newer.data.todoId), 'open');
  const again = await f.call('human.ask', { title: 'And the font?', reason: 'taste', widget: { type: 'choice', question: 'Font?', options: ['Serif', 'Sans'] } }, 'run_2');
  assert.equal(status(newer.data.todoId), 'open', 'the same turn asks two things');
  assert.equal(status(again.data.todoId), 'open');
  assert.equal(f.chats.messages(f.chat.id).some((message) => /^Cancelled:/.test(message.body)), false, 'quietly: no status line');
});

test('in a group chat a newer question to a colleague leaves the open question to the owner (and the reverse)', () => {
  const f = fixture();
  const ask = (title: string, assigneeId?: string) => f.tasks.create({
    conversationId: f.chat.id, title, assigneeKind: 'human', ...(assigneeId ? { assigneeId } : {}), createdBy: 'ag_ava',
    widget: { type: 'choice', question: title, options: ['A', 'B'] },
  });
  const toOwner = ask('Which logo?');
  f.clock.advance(1000);
  const toAnna = ask('Which venue?', 'per_anna');
  assert.equal(f.tasks.get(toOwner.id)!.status, 'open', 'the owner\'s question stays');
  f.clock.advance(1000);
  ask('Which logo now?');
  assert.equal(f.tasks.get(toOwner.id)!.status, 'cancelled', 'the owner\'s own older question is replaced');
  assert.equal(f.tasks.get(toAnna.id)!.status, 'open', 'the colleague\'s question stays');
});

test('a typed reply to the asking message answers its open to-dos with the text', () => {
  const f = fixture();
  const { message, todos } = f.post(f.ui('{"type":"choice","question":"Which day?","options":["Monday","Friday"],"important":true}'));
  f.chats.send({ conversationId: f.chat.id, body: 'Friday, but after 3 pm', authorId: HUMAN_ID, authorKind: 'human', replyTo: message.id });
  const done = f.tasks.get(todos[0].id)!;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result?.answer, { text: 'Friday, but after 3 pm' });
  assert.equal(f.chats.messages(f.chat.id).filter((item) => item.kind === 'answer').length, 0, 'no second receipt: the line is the answer');
  // A side remark (no reply) and a reminder stay open.
  const other = f.post(f.ui('{"type":"confirm","instructions":"Charge the camera","important":true}'));
  f.chats.send({ conversationId: f.chat.id, body: 'ok', authorId: HUMAN_ID, authorKind: 'human' });
  assert.equal(f.tasks.get(other.todos[0].id)!.status, 'open');
  const timer = f.post(f.ui('{"type":"timer","label":"Tea","duration":"PT5M"}'));
  f.chats.send({ conversationId: f.chat.id, body: 'thanks', authorId: HUMAN_ID, authorKind: 'human', replyTo: timer.message.id });
  assert.notEqual(f.tasks.get(timer.todos[0].id)!.status, 'done');
});

test('a reply to a message with two asks answers only the ask whose quick answer it is; free text answers none', () => {
  const f = fixture();
  const two = f.post(f.ui('{"type":"choice","question":"Which venue?","options":["Hall A","Hall B"],"important":true}') + '\n'
    + f.ui('{"type":"choice","question":"Budget cap?","options":["5k","10k"],"important":true}'));
  assert.equal(two.todos.length, 2);
  f.chats.send({ conversationId: f.chat.id, body: 'not sure yet', authorId: HUMAN_ID, authorKind: 'human', replyTo: two.message.id });
  assert.deepEqual(two.todos.map((todo) => f.tasks.get(todo.id)!.status), ['open', 'open'], 'free text to two asks: the agent sorts it out');
  f.chats.send({ conversationId: f.chat.id, body: 'Hall B', authorId: HUMAN_ID, authorKind: 'human', replyTo: two.message.id });
  assert.equal(f.tasks.get(two.todos[0].id)!.status, 'done', 'the venue is answered');
  assert.equal(f.tasks.get(two.todos[1].id)!.status, 'open', 'the budget question stays');
  f.chats.send({ conversationId: f.chat.id, body: 'up to 7k', authorId: HUMAN_ID, authorKind: 'human', replyTo: two.message.id });
  assert.deepEqual(f.tasks.get(two.todos[1].id)!.result?.answer, { text: 'up to 7k' }, 'one ask left: free text answers it');
});

test('"working" ends with the last live run on the task', () => {
  const f = fixture();
  const task = f.tasks.create({ conversationId: f.chat.id, title: 'Build the page', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: HUMAN_ID });
  f.tasks.setStatus(task.id, 'working', 'ag_ava');
  const run = { agentId: 'ag_ava', runId: 'run_9', conversationId: f.chat.id, taskId: task.id, note: '', startedAt: f.clock.now() };
  f.bus.emit('agent.activity', { active: [run] });
  assert.equal(f.tasks.get(task.id)!.status, 'working', 'while the run is live');
  f.bus.emit('agent.activity', { active: [] });
  assert.equal(f.tasks.get(task.id)!.status, 'open', 'nobody works on it now');
  assert.equal(f.chats.messages(f.chat.id).some((message) => /^Reopened:/.test(message.body)), false, 'quietly');
});

test('my own step under my own task is a line of its plan, not a task that waits to be started', async () => {
  const f = fixture();
  const parent = f.tasks.create({ conversationId: f.chat.id, title: 'Launch the site', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: HUMAN_ID });
  const step = await f.call('tasks.create', { title: 'Write the imprint', parentId: parent.id });
  assert.equal(step.data.planOf, parent.id);
  assert.deepEqual(f.tasks.get(parent.id)!.ledger.plan, ['Write the imprint']);
  assert.equal(f.tasks.get(parent.id)!.steps.length, 0, 'no child task');
  f.org.add(agent('ag_tom', 'Tom'));
  const delegated = await f.call('tasks.create', { title: 'Cut the video', parentId: parent.id, assignee: 'ag_tom' });
  assert.ok(delegated.data.taskId, 'work for a colleague stays a task');
});
