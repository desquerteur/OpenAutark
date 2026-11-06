// End-to-end (C3): per-chat notification levels over the real headless runtime (demo engine, temp
// profile) and real WebSocket RPC. The demo engine echoes the person's message, so "@CEO" in it
// makes the agent's reply mention the person: in a default chat that reply is announced as
// 'important' with toast:true; after Chat details › Notifications = Off the same kind of reply
// arrives with toast:false (no toast, no push); "Mentions and tasks" lets it through again.
// Run: npm run build && node --test test/e2e/runtime-chat-notifications.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime, waitForNew } from './lib/runtime-client.mjs';

test('a muted chat announces replies without a toast; Mentions lets @person through', { timeout: 240_000 }, async (t) => {
  const live = await startRuntime();
  t.after(() => live.stop());
  await live.client.call('events.subscribe', { topics: ['chats', 'system'] });
  const chat = (await live.client.call('chats.list'))[0];
  assert.ok(chat, 'the manager\'s first chat');

  /** Sends a message that the demo engine echoes with "@CEO" and returns the 'important' notify event of the reply. */
  const replyNote = async (body) => {
    const next = waitForNew(live.client, 'notify', (note) => note.conversationId === chat.id && note.kind === 'important', 90_000);
    await live.client.call('messages.send', { conversationId: chat.id, body });
    return next;
  };

  const loud = await replyNote('First check, @CEO');
  assert.equal(loud.toast, true, 'a default chat toasts a reply that mentions the person');

  await live.client.call('chats.update', { id: chat.id, settings: { notifications: 'off' } });
  const muted = await replyNote('Second check, @CEO');
  assert.equal(muted.toast, false, 'Off: no toast (and no push) for the same reply');

  await live.client.call('chats.update', { id: chat.id, settings: { notifications: 'mentions' } });
  const mentioned = await replyNote('Third check, @CEO');
  assert.equal(mentioned.toast, true, 'Mentions and tasks: a mention of the person comes through');
});
