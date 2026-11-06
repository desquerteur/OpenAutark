// End-to-end with a REAL provider login (opt-in, uses the person's plan for one tiny turn):
//   WORKFORCE_E2E_REAL=codex  node --test test/e2e/runtime-real.test.mjs   (or =claude)
// The headless runtime starts in a temp profile, detects the CLI login in its default home
// (official status command only – tokens are never read), pins the chat to that provider's
// cheapest listed model and checks that a real agent turn comes back as a final message.
// Skipped unless WORKFORCE_E2E_REAL is set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const provider = process.env.WORKFORCE_E2E_REAL;

test(`real ${provider ?? 'provider'} turn through the runtime`, { skip: !provider, timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime({ fake: false, keepData: process.env.WORKFORCE_E2E_KEEP === '1' });
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'providers'] });

  await client.call('accounts.detect', { force: true });
  const accounts = await client.call('accounts.list');
  const account = accounts.find((item) => item.provider === provider && item.state === 'ok');
  assert.ok(account, `a logged-in ${provider} CLI is detected`);
  for (const other of accounts) if (other.id !== account.id) await client.call('accounts.update', { id: other.id, enabled: false });

  const models = (await client.call('models.list', { refresh: true })).filter((model) => model.provider === provider && model.available);
  assert.ok(models.length, `${provider} lists models`);
  const order = { cheap: 0, strong: 1, frontier: 2 };
  const model = [...models].sort((a, b) => (order[a.tier] ?? 1) - (order[b.tier] ?? 1) || (a.relCost ?? 1) - (b.relCost ?? 1))[0];

  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await client.call('chats.create', { title: 'Real check', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  await client.call('models.setPolicy', { agentId: manager.id, conversationId: chat.id, policy: { pin: model.id, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort } });

  await client.call('messages.send', { conversationId: chat.id, body: 'Reply with exactly the word: pong' });
  const reply = await client.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.state === 'final', 240_000);
  t.diagnostic(`model ${model.id}: ${reply.body.slice(0, 200)}`);
  assert.match(reply.body, /pong/i);
  // A real workforce tool call (Codex: dynamic tools, Claude Code: the MCP hub).
  await client.call('messages.send', { conversationId: chat.id, body: 'Use your task tool to create a task titled "Real tool check" in this chat, then reply with: created' });
  const task = await client.waitFor('task.upserted', (item) => item.conversationId === chat.id && /real tool check/i.test(item.title), 240_000);
  t.diagnostic(`task ${task.id} owner ${task.assigneeId ?? '-'}`);
  await client.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.state === 'final' && /created/i.test(message.body), 240_000);
  const runs = await client.call('agents.runs', { id: manager.id });
  assert.ok(runs.some((run) => run.status === 'done'), 'the run is journaled as done');
});
