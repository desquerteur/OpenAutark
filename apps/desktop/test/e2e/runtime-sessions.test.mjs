// End-to-end: durable native sessions over the real headless runtime (demo engine, temp
// profile), driven over WebSocket RPC like the desktop window and the PWA.
// A chat answers again after the runtime restarts between two turns: the session binding is
// stored in the database (no state that only lived in the old process), the next turn resumes
// that same session with only the new message, and the session cursor follows the chat.
// Run: npm run build && node --test test/e2e/runtime-sessions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRuntime } from './lib/runtime-client.mjs';

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

/** The stored session binding of an agent in a chat (read while no runtime is running). */
function binding(dataDir, agentId, conversationId) {
  // Read-write open: a runtime stopped hard (Windows) leaves its WAL behind, which needs recovery.
  const db = new DatabaseSync(path.join(dataDir, 'workforce.db'));
  try {
    return db.prepare('SELECT engine, session_ref, cursor_seq FROM engine_sessions WHERE agent_id = ? AND conversation_id = ?').get(agentId, conversationId);
  } finally {
    db.close();
  }
}

test('a chat still answers after a runtime restart between two turns, on the same session', { timeout: 240_000 }, async (t) => {
  let live = await startRuntime({ keepData: true });
  const dataDir = live.dataDir;
  // One cleanup: stop whichever runtime still runs, then remove the temp profile.
  t.after(async () => {
    if (live) await live.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  const manager = (await live.client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await live.client.call('chats.create', { title: 'Across restarts', agentIds: [manager.id] });
  await live.client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await live.client.call('messages.send', { conversationId: chat.id, body: 'First question before the restart' });
  await live.client.waitFor('message.updated', finalFrom(chat.id, manager.id, /First question before the restart/), 90_000);
  // B-076: the run is booked a few ms after its final line; a stop in between leaves it "interrupted", and its retry after
  // the restart would take the next message along. The test is about resuming the session, so the run ends first.
  for (let i = 0; i < 100; i++) {
    const runs = await live.client.call('agents.runs', { id: manager.id, limit: 5 });
    if (!runs.some((run) => run.status === 'running' || run.status === 'queued')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await live.stop();
  live = undefined;

  const before = binding(dataDir, manager.id, chat.id);
  assert.ok(before, 'the session binding is stored in the database');
  assert.ok(!String(before.session_ref).startsWith('seed:'), 'no reference to state of the old process');
  assert.ok(Number(before.cursor_seq) > 0);

  live = await startRuntime({ dataDir, keepData: true });
  await live.client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await live.client.call('messages.send', { conversationId: chat.id, body: 'Second question after the restart' });
  const reply = await live.client.waitFor('message.updated', finalFrom(chat.id, manager.id, /Second question after the restart/), 90_000);
  assert.ok(!reply.body.includes('First question before the restart'), 'the resumed session gets only the new message');
  await live.stop();
  live = undefined;

  const after = binding(dataDir, manager.id, chat.id);
  assert.equal(after.session_ref, before.session_ref, 'the same native session continued');
  assert.ok(Number(after.cursor_seq) > Number(before.cursor_seq), 'its cursor followed the chat');
});
