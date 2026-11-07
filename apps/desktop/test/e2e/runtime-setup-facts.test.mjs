// End-to-end (O2): the Manager's live setup facts over the real headless runtime (built
// app/runtime-cli.mjs) with the deterministic fake engine and real WebSocket RPC.
// Covers: the first Manager turn calls app.status and its answer carries '## App status (live)'
// with the real state (first run not finished, the seed Manager, the demo account, the demo model named for decisions
// as the chat model that stands in) and no account base URL; once onboarding is finished (settings.json onboarding) the
// next turn reports it.
// B-044 first run: onboarding.start (the end of the first-run cards) sets step 'done' and posts the app's start
// text in the Manager's first chat as the person's line (B-066); the Manager answers it as an ordinary message.
// Run: npm run build && node --test test/e2e/runtime-setup-facts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

test('the first Manager turn sees the live setup facts', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds a manager');
  const chat = await client.call('chats.create', { title: 'Setup', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });

  await client.call('messages.send', { conversationId: chat.id, body: 'What is connected? [[tool:app.status {}]]' });
  const first = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /## App status/), 90_000);
  assert.match(first.body, /app\.status → ## App status \(live\)/);
  assert.match(first.body, /- First run: not finished/);
  assert.match(first.body, /- Agents: 1 active \(manager Manager\)/);
  assert.match(first.body, /- Accounts: Demo engine \(compatible/);
  assert.ok(!first.body.includes('127.0.0.1:9'), 'no account base URL in the setup facts');
  // B-072: decisions and search by meaning by the model that answers, never the stored "auto"
  assert.match(first.body, /- Decisions: [^\n]+ \(a chat model; no decision model connected\) · Search by meaning: /);
  assert.doesNotMatch(first.body, /Decision model: auto|Embedding model: auto/);

  await client.call('settings.update', { onboarding: { completed: true, step: 'done' } });
  await client.call('messages.send', { conversationId: chat.id, body: 'Again [[tool:app.status {}]]' });
  const second = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /First run: finished/), 90_000);
  assert.match(second.body, /## App status \(live\)/);
});

test("B-044: onboarding.start posts the start text in the Manager's first chat and it answers", { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager);
  assert.equal((await client.call('settings.get')).onboarding.step, 'profile', 'a new installation starts with the setup assistant (AF-002: About you first)');
  await client.call('events.subscribe', { topics: ['chats'] });
  const { conversationId } = await client.call('onboarding.start');
  await client.call('events.subscribe', { topics: [`chat:${conversationId}`] });
  assert.equal((await client.call('settings.get')).onboarding.step, 'done');
  // The wake runs on its own after onboarding.start returns; with the fast fake engine the turn can
  // finish before the chat subscription above, so its events are gone – the chat history has it then
  // (as the app's chat view reads it on open). Armed before the read: a later finish is the event.
  const isReply = (message) => message.conversationId === conversationId && message.authorId === manager.id && message.state === 'final';
  const event = client.waitFor('message.updated', isReply, 90_000);
  event.catch(() => undefined); // awaited below only when the history has no reply yet
  const earlier = (await client.call('messages.list', { conversationId, limit: 20 })).find(isReply);
  const reply = earlier ?? await event;
  assert.ok(reply.body.trim().length > 0, 'the Manager answered');
  const lines = await client.call('messages.list', { conversationId, limit: 20 });
  const own = lines.filter((message) => message.authorKind === 'human');
  assert.equal(own.length, 1, "the app's start text, once, as the person's line");
  assert.match(own[0].body, /^Automatic message from the app, /); // B-076 start text
  const runs = await client.call('agents.runs', { id: manager.id }).catch(() => []);
  if (Array.isArray(runs) && runs.length) assert.ok(runs.some((run) => run.trigger === 'message'), "the Manager's run came from that message");
});
