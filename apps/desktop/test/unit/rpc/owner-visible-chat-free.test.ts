// B-054 RPC (handlers/tasks.ts, task-links.ts): a task without a chat – tasks.create without conversationId makes one
// (a client cannot send an origin); the owner and her phones list, open and change it. The owner sees every task, the
// people's own chats included. tasks.share posts a live reference and refuses "Only me" tasks and archived chats.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from './s1-helpers.ts';

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const theirs = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'ag_ava', humans: false, settings: { peopleChat: true } });
  return { ...f, chat, theirs, owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE) };
}

test('tasks.create without a chat makes a chat-free task the owner and her phone see and change', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const before = f.chats.list({ includeHidden: true }).length;
  const task = await f.phone.call<TaskView>('tasks.create', { title: 'Summarise the Travel Desk items', assigneeKind: 'agent', assigneeId: 'ag_ava' });
  assert.equal(task.conversationId, undefined);
  assert.equal(task.messageId, undefined, 'no anchor card');
  assert.equal(f.chats.list({ includeHidden: true }).length, before, 'no chat was made for it');
  assert.ok((await f.owner.call<TaskView[]>('tasks.list')).some((entry) => entry.id === task.id));
  assert.equal((await f.phone.call<TaskView>('tasks.get', { id: task.id })).id, task.id);
  assert.equal((await f.phone.call<TaskView>('tasks.update', { id: task.id, patch: { title: 'Summarise the items' } })).title, 'Summarise the items');
});

test('a client cannot set the origin – it is runtime-written', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const refused = await f.owner.request('tasks.create', { title: 'x', origin: { source: 'app:mail', label: 'New mail' } });
  assert.equal(refused.error?.code, 'bad_request');
});

test("the owner lists and opens every task, those of the people's own chats too", async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const theirs = f.tasks.create({ conversationId: f.theirs.id, title: 'Their work', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'ag_ava' });
  const free = f.tasks.create({ title: 'Morning check', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'ag_ava' });
  const listed = (await f.owner.call<TaskView[]>('tasks.list')).map((entry) => entry.id);
  assert.ok(listed.includes(theirs.id));
  assert.ok(listed.includes(free.id));
  assert.equal((await f.owner.call<TaskView>('tasks.get', { id: theirs.id })).id, theirs.id);
});

test('tasks.share posts a reference and never moves the task into the chat', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const task = f.tasks.create({ title: 'Prepare the offer', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const ref = await f.phone.call<Message>('tasks.share', { id: task.id, conversationId: f.chat.id });
  assert.equal(ref.kind, 'task');
  assert.equal(ref.taskId, task.id);
  assert.equal(ref.authorId, 'human');
  assert.equal(f.tasks.get(task.id)?.conversationId, undefined, 'sharing never moves the task into the chat');
});

test('tasks.share refuses "Only me" tasks and archived or unknown chats', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const task = f.tasks.create({ title: 'Private errand', assigneeKind: 'human', createdBy: 'human' });
  f.db.run('UPDATE tasks SET private = 1 WHERE id = ?', [task.id]);
  assert.equal((await f.owner.request('tasks.share', { id: task.id, conversationId: f.chat.id })).error?.code, 'bad_request', '"Only me"');
  const open = f.tasks.create({ title: 'Book the venue', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  const archived = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  f.chats.archive(archived.id);
  assert.equal((await f.owner.request('tasks.share', { id: open.id, conversationId: archived.id })).error?.code, 'bad_request');
  assert.equal((await f.owner.request('tasks.share', { id: open.id, conversationId: 'conv_missing' })).error?.code, 'not_found');
  assert.ok(!f.db.get("SELECT 1 FROM messages WHERE kind = 'task' AND task_id = ?", [open.id]), 'nothing was posted');
});
