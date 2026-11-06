// B-078 agent tools for sub-chats and threads (tools/builtin/chat-tree.ts, chat-rooms.ts chat.create parent): an agent
// puts a chat it is in under another one and back on top, opens the thread on a #seq or a message id (one per message),
// gets a first-person refusal it can act on, and chat.create takes a parent; the tool texts speak as the agent.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { chatTreeTools } from '../../../src/runtime/tools/builtin/chat-tree.ts';
import { chatRoomTools } from '../../../src/runtime/tools/builtin/chat-rooms.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const TOOLS: ToolDef[] = [...chatTreeTools, ...chatRoomTools];

function setup() {
  const h = harness();
  Object.assign(h.services, { settings: { get: () => ({ profile: { name: 'Sam', timezone: 'UTC' } }) } });
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_ben', 'Ben'));
  const ctx = (agentId = 'ag_ava', conversationId?: string) => ({
    agent: h.org.get(agentId)!, runId: `run_${agentId}`, conversationId, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  }) as ToolContext;
  const run = async (name: string, args: Record<string, unknown>, context = ctx()) => {
    const out = await TOOLS.find((item) => item.name === name)!.run(args as never, context);
    const text = (out.content[0] as { text: string }).text;
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* a plain line */ }
    return { failed: out.isError === true, text, data };
  };
  return { ...h, ctx, run };
}

test('chat.set_parent: under a chat I am in and back on top; refusals in my words', async () => {
  const h = setup();
  const main = h.chats.create({ title: 'Launch', agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID });
  const side = h.chats.create({ title: 'Venue', agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const out = await h.run('chat.set_parent', { chatId: side.id, parentId: main.id });
  assert.equal(out.failed, false, out.text);
  assert.equal(h.chats.get(side.id)!.settings.parentId, main.id);
  const deeper = await h.run('chat.set_parent', { chatId: h.chats.create({ title: 'X', agentIds: ['ag_ava'], createdBy: HUMAN_ID }).id, parentId: side.id });
  assert.match(deeper.text, /^Nothing was changed\. That chat is itself a sub-chat; I put this one under its top chat instead/);
  assert.equal((await h.run('chat.set_parent', { chatId: side.id })).data.parentId, null, 'without parentId: back on top');
  assert.equal(h.chats.get(side.id)!.settings.parentId, undefined);
  assert.equal((await h.run('chat.set_parent', { chatId: main.id, parentId: side.id }, h.ctx('ag_ben'))).failed, true, 'Ben is not in Venue');
});

test('chat.thread: on a #seq or a message id, one per message; chat.create takes a parent', async () => {
  const h = setup();
  const main = h.chats.create({ title: 'Launch', agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID });
  const line = h.chats.send({ conversationId: main.id, body: 'Book the venue for Friday', authorId: HUMAN_ID, authorKind: 'human' });
  const bySeq = await h.run('chat.thread', { seq: line.seq }, h.ctx('ag_ava', main.id));
  assert.equal(bySeq.failed, false, bySeq.text);
  assert.equal((await h.run('chat.thread', { messageId: line.id }, h.ctx('ag_ben'))).data.chatId, bySeq.data.chatId, 'one thread per message');
  assert.equal(bySeq.data.parentId, main.id);
  assert.match((await h.run('chat.thread', { seq: 99 }, h.ctx('ag_ava', main.id))).text, /No message #99/);
  assert.match((await h.run('chat.thread', {}, h.ctx('ag_ava', main.id))).text, /Name the message/);

  const sub = await h.run('chat.create', { title: 'Catering', members: ['ag_ben'], parent: main.id });
  assert.equal(sub.failed, false, sub.text);
  assert.equal(h.chats.get(sub.data.chatId as string)!.settings.parentId, main.id);
  const one = await h.run('chat.create', { members: ['ag_ben'], parent: main.id });
  assert.notEqual(h.chats.get(one.data.chatId as string)!.settings.direct, true, 'with a parent it is a group, never the default 1:1');
});

test('the tool texts speak as the agent and say what each chat kind is for', () => {
  for (const name of ['chat.set_parent', 'chat.thread', 'chat.create', 'chat.direct']) {
    const description = TOOLS.find((item) => item.name === name)!.description;
    assert.match(description, /\bI\b|\bMy\b/, `${name} speaks as me`);
    assert.doesNotMatch(description, /\b(may|allowed|only if|must)\b/i, `${name}: no permission language`);
  }
  const create = TOOLS.find((item) => item.name === 'chat.create')!.description;
  assert.match(create, /internal room of us agents/);
  assert.match(TOOLS.find((item) => item.name === 'chat.direct')!.description, /It stays two/);
});
