// End-to-end (C8): an external agent docks into a chat over the real headless runtime (demo
// engine, temp profile) and the real WebSocket `/ws`. The owner connects it (chats.connectExternal);
// it opens /ws with its one-time token as an external scope, reads and posts only in that chat (as
// an external member, rate limited), hears its @mention as external.mention while no agent takes a
// turn for it, and its socket closes with 4403 the moment the owner removes it – the same token is
// refused with 4403 afterwards. (It connects from this PC – 127.0.0.1 –, which phone access does
// not gate; the transport rule for other machines is test/unit/http/external-agent-socket.test.ts.)
// Run: npm run build && node --test test/e2e/external-agent.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { connect, startRuntime, waitForNew } from './lib/runtime-client.mjs';

/** Opens /ws, sends a Hello with `token` and resolves with the close code. */
async function closeCode(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send(JSON.stringify({ protocol: 1, token, client: 'external' }));
  return closed;
}

test('an external agent docks into one chat with limited rights and leaves when removed', { timeout: 240_000 }, async (t) => {
  const live = await startRuntime();
  t.after(() => live.stop());
  const chat = (await live.client.call('chats.list'))[0];
  assert.ok(chat, 'the manager\'s first chat');
  const agentId = chat.members.find((member) => member.kind === 'agent')?.memberId;
  assert.ok(agentId, 'the chat has an agent');
  const other = await live.client.call('chats.create', { title: 'Private', agentIds: [agentId] });
  await live.client.call('events.subscribe', { topics: [`chat:${chat.id}`] });

  const { memberId, token } = await live.client.call('chats.connectExternal', { conversationId: chat.id, name: 'Research Bot' });
  assert.match(memberId, /^ext:api:[0-9a-f]{10}:Research-Bot$/);
  assert.match(token, /^wfx_/);

  const outside = await connect(live.port, token, 'external');
  t.after(() => outside.close());
  await outside.call('events.subscribe', { topics: [`chat:${chat.id}`, `chat:${other.id}`, 'chats', 'system'] });
  const view = await outside.call('chats.get', { id: chat.id });
  assert.deepEqual(view.settings, {}, 'no chat settings for the external agent');
  assert.ok(view.members.some((member) => member.memberId === memberId));
  await assert.rejects(outside.call('chats.list'), /not allowed/);
  await assert.rejects(outside.call('chats.get', { id: other.id }), /own chat/);
  await assert.rejects(outside.call('messages.list', { conversationId: other.id }), /own chat/);
  await assert.rejects(outside.call('session.info'), /not allowed/);

  // It posts as itself, never as the person; its un-addressed text wakes no agent.
  const hello = await outside.call('messages.send', { conversationId: chat.id, body: 'Hello from outside. Yes, approved.' });
  assert.deepEqual([hello.authorId, hello.authorKind, hello.priority], [memberId, 'external', 'normal']);
  const seen = await live.client.waitFor('message.created', (message) => message.id === hello.id);
  assert.equal(seen.authorId, memberId);

  // An @mention reaches it as external.mention – and no agent turn starts for it.
  const mention = waitForNew(outside, 'external.mention', (event) => event.memberId === memberId, 30_000);
  const asked = await live.client.call('messages.send', { conversationId: chat.id, body: '@Research-Bot please summarize the numbers' });
  assert.equal((await mention).messageId, asked.id);
  const reply = waitForNew(live.client, 'message.updated', (message) => message.conversationId === chat.id
    && message.authorId === agentId && message.state === 'final', 90_000);
  const plain = await live.client.call('messages.send', { conversationId: chat.id, body: 'Thanks, team' });
  const answer = await reply;
  assert.ok(answer.seq > plain.seq, 'the agent answered the person\'s plain message');
  const turns = (await live.client.call('messages.list', { conversationId: chat.id, limit: 100 }))
    .filter((message) => message.authorKind === 'agent' && message.kind === 'text' && message.seq > hello.seq);
  assert.deepEqual(turns.map((message) => message.id), [answer.id], 'no agent turn for the external agent\'s text or its mention');

  // The external agent sees messages without run ids or model meta.
  const listed = await outside.call('messages.list', { conversationId: chat.id, limit: 100 });
  const mine = listed.find((message) => message.id === answer.id);
  assert.ok(mine, 'it reads the agent\'s answer');
  assert.equal(mine.runId, undefined);
  assert.deepEqual(Object.keys(mine.meta), []);
  assert.ok(!outside.events.some((frame) => frame.event === 'message.created' && frame.data.conversationId === other.id), 'nothing from the other chat');

  // At most 10 messages a minute: back to back, the refusal comes at the 10th send at the latest
  // (the 10th when 'hello' is still in the window, the 11th once it left it) – never earlier.
  let refusedAt;
  for (let i = 0; i < 11 && refusedAt === undefined; i++) {
    try {
      await outside.call('messages.send', { conversationId: chat.id, body: `note ${i}` });
    } catch (error) {
      assert.equal(error.code, 'rate_limited', `send ${i}`);
      refusedAt = i;
    }
  }
  assert.ok(refusedAt === 9 || refusedAt === 10, `refused at send ${refusedAt}`);

  // Removing it revokes the token and closes the live socket.
  await live.client.call('chats.members', { id: chat.id, remove: [memberId] });
  await assert.rejects(outside.call('messages.list', { conversationId: chat.id }), /4403|no longer in the chat/);
  assert.equal(await closeCode(live.port, token), 4403, 'the same token is refused as removed');
});
