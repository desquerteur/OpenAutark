// End-to-end (C6): reply, edit and delete over the real headless runtime (built
// app/runtime-cli.mjs, deterministic fake engine that echoes its input, real WebSocket RPC).
// Covers: a reply's quote reaches the agent – its turn input names whom it answers,
// `(reply to <Manager> (me): "…")`; another chat's message is never kept as the quoted one; the
// person cannot edit the agent's answer (forbidden); the person's edit reaches the agent's next
// turn as "edited #<seq>; it now reads: …" with the current text; the person's deleted message
// leaves a "Message deleted" tombstone at its seq and the agent's next turn reads
// "deleted their message from <HH:MM> (#<seq>)".
// Run: npm run build && node --test test/e2e/runtime-reply.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the quote of a reply, an edit and a delete reach the agent', { timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;

  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds a manager');
  const chat = await client.call('chats.create', { title: 'Launch', agentIds: [manager.id] });
  const other = await client.call('chats.create', { title: 'Elsewhere', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, `chat:${other.id}`] });

  /** Sends as the person and resolves with the manager's next final answer in that chat. */
  const answer = async (params) => {
    const sent = await client.call('messages.send', params);
    const reply = await client.waitFor('message.updated', (message) => message.conversationId === params.conversationId
      && message.authorId === manager.id && message.state === 'final' && message.seq > sent.seq, 120_000);
    return { sent, reply };
  };

  const first = await answer({ conversationId: chat.id, body: 'Plan the launch for Friday' });
  assert.match(first.reply.body, /^Echo: /);

  // A reply: the quote reaches the agent.
  const replied = await answer({ conversationId: chat.id, body: 'Make it shorter', replyTo: first.reply.id });
  assert.equal(replied.sent.replyTo, first.reply.id);
  assert.match(replied.reply.body, new RegExp(`\\(reply to ${escape(manager.name)} \\(me\\): "Echo:`), replied.reply.body);
  assert.ok(replied.reply.body.includes('Make it shorter'), replied.reply.body);

  // Another chat's message is never the quoted one.
  const foreign = await answer({ conversationId: other.id, body: 'Salary list' });
  const stray = await answer({ conversationId: chat.id, body: 'Noted', replyTo: foreign.sent.id });
  assert.equal(stray.sent.replyTo, undefined);
  assert.ok(!stray.reply.body.includes('Salary'), stray.reply.body);

  // The person edits only their own messages.
  await assert.rejects(client.call('messages.edit', { id: first.reply.id, body: 'rewritten' }), (error) => error.code === 'forbidden');
  const edited = await client.call('messages.edit', { id: first.sent.id, body: 'Plan the launch for Monday' });
  assert.ok(edited.editedAt, 'marked as edited');
  const told = await answer({ conversationId: chat.id, body: 'Anything else?' });
  assert.ok(told.reply.body.includes(`edited #${first.sent.seq}; it now reads: "Plan the launch for Monday"`), told.reply.body);

  // The person's delete: a tombstone at its place, and the agent is told.
  await client.call('messages.delete', { id: replied.sent.id });
  const list = await client.call('messages.list', { conversationId: chat.id });
  assert.ok(!list.some((message) => message.id === replied.sent.id), 'the message is gone');
  const stone = list.find((message) => message.meta.status?.details?.tombstone === replied.sent.id);
  assert.deepEqual(stone && [stone.seq, stone.kind, stone.body, stone.silent], [replied.sent.seq, 'status', 'Message deleted', true]);
  const gone = await answer({ conversationId: chat.id, body: 'Thanks' });
  assert.match(gone.reply.body, new RegExp(`deleted their message from (\\d+ \\w+ )?\\d\\d:\\d\\d \\(#${replied.sent.seq}\\)`), gone.reply.body);
  assert.ok(!gone.reply.body.includes('Make it shorter'), 'the deleted text is not repeated');
});
