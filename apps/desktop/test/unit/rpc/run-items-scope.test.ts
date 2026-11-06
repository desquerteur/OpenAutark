// runs.items for phones (C5): a device with 'chat' reads the items of runs that worked in a chat
// it can open – also a hidden team room or an archived chat – and (B-054 P10) of a run without a
// chat whose task, if any, still exists; not of a chat-free run on a task that is gone, of a run whose chat
// is gone, or of an unknown run; 'manage' devices and the owner read every
// run; a To-do-only link reads none. Chat-only devices get no run stream (runs:<agentId> stays
// 'manage'), so their live line follows the agent's activity on 'org'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { newId } from '../../../src/shared/ids.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { RunItem } from '../../../src/shared/model/runs.ts';
import { allowedScope } from '../../../src/runtime/rpc/table.ts';
import { mayReceive, maySubscribe } from '../../../src/runtime/rpc/scopes.ts';
import { OWNER, PHONE, TODO_ONLY, TestClient, rpcFixture, s1Table } from './s1-helpers.ts';

const MANAGER_PHONE: ClientScope = { kind: 'device', deviceId: 'dev_full', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'] };

function setup() {
  const f = rpcFixture();
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  /** A finished run with one tool call and its result (conversationId undefined = no chat). */
  const run = (conversationId: string | undefined, taskId?: string) => {
    const started = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', conversationId, ...(taskId ? { taskId } : {}), trigger: conversationId ? 'message' : 'event' });
    f.services.runs.item(started.id, { kind: 'tool_call', name: 'files.read', data: { callId: 'c1', args: { path: 'brief.md' } } });
    f.services.runs.item(started.id, { kind: 'tool_result', data: { callId: 'c1', ok: true, preview: 'Brief' } });
    f.services.runs.finish(started.id, { status: 'done' });
    return started.id;
  };
  return {
    ...f, chat, run,
    owner: new TestClient(f.server, OWNER), phone: new TestClient(f.server, PHONE),
    manager: new TestClient(f.server, MANAGER_PHONE), todo: new TestClient(f.server, TODO_ONLY),
  };
}

test('runs.items is a chat-tier method; a To-do-only link may not call it', () => {
  const rule = s1Table().get('runs.items')!.scope;
  assert.deepEqual(rule, { capability: 'chat' });
  assert.ok(allowedScope(rule, PHONE));
  assert.ok(allowedScope(rule, MANAGER_PHONE));
  assert.ok(!allowedScope(rule, TODO_ONLY));
  assert.ok(!allowedScope(rule, { kind: 'device', deviceId: 'dev_tasks', capabilities: ['todo', 'tasks'] }));
});

test('a chat phone reads the items of a run in a chat it can open', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const runId = f.run(f.chat.id);
  const items = await f.phone.call<RunItem[]>('runs.items', { runId });
  assert.deepEqual(items.map((entry) => entry.kind), ['tool_call', 'tool_result']);
  assert.equal(items[0].name, 'files.read');
  assert.deepEqual(await f.owner.call<RunItem[]>('runs.items', { runId }), items, 'the same items the owner sees');
});

test('hidden team rooms and archived chats stay readable (the person can open both)', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const room = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'ag_ava' });
  f.chats.update(room.id, { settings: { hiddenFromList: true } }, 'ag_ava');
  const archived = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  f.chats.archive(archived.id);
  for (const conversationId of [room.id, archived.id]) {
    assert.equal((await f.phone.call<RunItem[]>('runs.items', { runId: f.run(conversationId) })).length, 2, conversationId);
  }
});

test("B-054 P10: a chat phone reads a chat-free run of the owner's world, with or without a chat-free task", async (t) => {
  const f = setup();
  t.after(f.cleanup);
  assert.equal((await f.phone.call<RunItem[]>('runs.items', { runId: f.run(undefined) })).length, 2, 'a mail or event run without a task');
  const task = f.services.tasks.create({ title: 'Answer Maria', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  assert.equal(task.conversationId, undefined, 'a chat-free task');
  assert.equal((await f.phone.call<RunItem[]>('runs.items', { runId: f.run(undefined, task.id) })).length, 2, 'a chat-free task run');
});

test('B-054 P10: a chat-free run on a task that is gone stays closed', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const gone = f.run(undefined, 'task_gone');
  const refused = await f.phone.request('runs.items', { runId: gone });
  assert.equal(refused.error?.code, 'forbidden', 'a task that is gone');
  assert.equal(refused.error?.details?.runId, gone);
  assert.ok(!JSON.stringify(refused).includes('brief.md'), 'nothing of the run leaks into the refusal');
  assert.equal((await f.manager.call<RunItem[]>('runs.items', { runId: gone })).length, 2, "'manage' reads it as before");
});

test('a chat phone may not read runs of a removed chat, or unknown runs', async (t) => {
  const f = setup();
  t.after(f.cleanup);

  const gone = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const goneRun = f.run(gone.id);
  assert.equal((await f.phone.call<RunItem[]>('runs.items', { runId: goneRun })).length, 2, 'readable while the chat exists');
  f.chats.remove(gone.id);
  assert.equal((await f.phone.request('runs.items', { runId: goneRun })).error?.code, 'forbidden', 'not once the chat is gone');

  const foreign = f.services.runs.start({ id: newId('run'), agentId: 'ag_ava', conversationId: 'conv_elsewhere', trigger: 'message' }).id;
  assert.equal((await f.phone.request('runs.items', { runId: foreign })).error?.code, 'forbidden', 'a chat id that names no chat');
  assert.equal((await f.phone.request('runs.items', { runId: 'run_missing' })).error?.code, 'not_found');
  assert.equal((await f.phone.request('runs.items', {})).error?.code, 'bad_request');
});

test("'manage' devices and the owner read every run; a To-do-only link none", async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const background = f.run(undefined);
  const inChat = f.run(f.chat.id);
  for (const client of [f.owner, f.manager]) {
    assert.equal((await client.call<RunItem[]>('runs.items', { runId: background })).length, 2);
    assert.equal((await client.call<RunItem[]>('runs.items', { runId: inChat })).length, 2);
  }
  for (const runId of [background, inChat]) assert.equal((await f.todo.request('runs.items', { runId })).error?.code, 'forbidden', runId);
});

test("chat-only phones get no run stream; the agent's activity on 'org' carries the live run", () => {
  assert.ok(!maySubscribe(PHONE, 'runs:ag_ava'), 'runs:<agentId> stays with manage');
  assert.ok(maySubscribe(MANAGER_PHONE, 'runs:ag_ava'));
  assert.ok(maySubscribe(PHONE, 'org') && mayReceive(PHONE, 'org', 'agent.activity', { active: [] }));
});
