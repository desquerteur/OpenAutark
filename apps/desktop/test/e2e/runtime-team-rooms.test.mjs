// End-to-end (C1): agent-only rooms survive a runtime restart and a to-do opens no chat (B-054) – over the real headless runtime (demo engine, temp profile) and real
// WebSocket RPC, classified on the client with the same rule the window uses
// (shared/text/chat-sections.ts).
// Covers: an agent opens a room without the human (chat.create through the demo engine); the
// human leaves another chat; a to-do typed into the list is chat-free and adds no chat; after a restart
// chats.list {includeHidden:true} still has both rooms under Team activity (no unread), the default list holds
// neither of them, search still finds team-room messages and
// writing in a room the human left brings it back to the main list.
// Run: npm run build && node --test test/e2e/runtime-team-rooms.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { startRuntime } from './lib/runtime-client.mjs';
import { chatSection } from '../../src/shared/text/chat-sections.ts';

test('team rooms persist across a restart; a to-do opens no chat', { timeout: 240_000 }, async (t) => {
  let live = await startRuntime({ keepData: true });
  const dataDir = live.dataDir;
  t.after(async () => {
    if (live) await live.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  await live.client.call('events.subscribe', { topics: ['chats', 'tasks'] });
  const manager = (await live.client.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds a manager');
  const first = (await live.client.call('chats.list'))[0];
  assert.ok(first, 'the manager\'s first chat');

  // An agent opens a room without the human.
  await live.client.call('messages.send', {
    conversationId: first.id,
    body: `Open a work room [[tool:chat.create {"title":"Launch research","agentIds":["${manager.id}"]}]]`,
  });
  const room = await live.client.waitFor('conversation.upserted', (chat) => chat.title === 'Launch research', 90_000);
  assert.equal(chatSection(room), 'team', 'agent-only from the start');

  // The human leaves a chat they wrote in.
  const left = await live.client.call('chats.create', { title: 'Old project', agentIds: [manager.id] });
  await live.client.call('messages.send', { conversationId: left.id, body: 'Notes about the quarterly offsite' });
  await live.client.call('chats.members', { id: left.id, remove: ['human'] });

  // B-054: a to-do typed into the list is chat-free – it creates no chat.
  const chatsBefore = (await live.client.call('chats.list', { includeHidden: true })).length;
  const typed = await live.client.call('todos.add', { text: 'Sign the delivery note' });
  assert.equal(typed.conversationId, undefined, 'the to-do needs no chat');
  assert.equal((await live.client.call('chats.list', { includeHidden: true })).length, chatsBefore, 'no To-do chat is made');

  await live.stop();
  live = undefined;
  live = await startRuntime({ dataDir, keepData: true });

  const all = await live.client.call('chats.list', { includeHidden: true });
  const byId = new Map(all.map((chat) => [chat.id, chat]));
  assert.equal(chatSection(byId.get(first.id)), 'main');
  assert.equal(chatSection(byId.get(room.id)), 'team', 'the agent room is still under Team activity');
  assert.equal(chatSection(byId.get(left.id)), 'team', 'the room the human left too');
  assert.equal(byId.get(room.id).unread + byId.get(left.id).unread, 0, 'team rooms count no unread');

  const main = (await live.client.call('chats.list')).map((chat) => chat.id);
  assert.ok(main.includes(first.id));
  for (const id of [room.id, left.id]) assert.ok(!main.includes(id), `${id} is not in the default list`);

  const hits = await live.client.call('chats.search', { text: 'quarterly offsite' });
  assert.ok(hits.some((hit) => hit.message.conversationId === left.id), 'search still finds team-room messages');

  await live.client.call('messages.send', { conversationId: left.id, body: 'Back on this' });
  assert.equal(chatSection(await live.client.call('chats.get', { id: left.id })), 'main', 'writing brings the human back');
});
