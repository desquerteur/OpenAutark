// End-to-end (T04): an outage neither stalls nor blocks a task, and its end resumes the task at
// once – over the real headless runtime (built app/runtime-cli.mjs) with the deterministic fake
// engine and real WebSocket RPC.
// Covers: with the only (demo) account disabled, the task turn cannot start and the task records
// 'unavailable' (no stall, no escalation, not blocked, next try at least about a minute later);
// enabling the account again (account.upserted / models.updated) re-wakes the task well before
// that backoff, and its next turn runs on the fake engine.
// Run: npm run build && node --test test/e2e/runtime-outage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

const lastOutcome = (task) => task.ledger?.tried?.at(-1)?.outcome;

test('an outage pauses a task without blocking it; the end of the outage resumes it', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const [demo] = await client.call('accounts.list');
  assert.ok(demo, 'demo mode seeds one fake-engine account');

  await client.call('accounts.update', { id: demo.id, enabled: false });
  const chat = await client.call('chats.create', { title: 'Outage', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  const task = await client.call('tasks.create', { conversationId: chat.id, title: 'Summarize the launch notes', assigneeKind: 'agent', assigneeId: manager.id });

  const failed = await client.waitFor('task.upserted', (item) => item.id === task.id && lastOutcome(item) === 'unavailable', 90_000);
  assert.equal(failed.ledger.stalls ?? 0, 0, 'an outage is no stall');
  assert.equal(failed.ledger.sinceProgress ?? 0, 0, 'and no attempt against the cap');
  assert.equal(failed.ledger.escalation ?? 'none', 'none');
  assert.notEqual(failed.status, 'blocked');
  assert.ok(failed.ledger.nextCheckAt - Date.now() > 30_000, 'the next try waits about a minute or longer');

  const enabledAt = Date.now();
  await client.call('accounts.update', { id: demo.id, enabled: true });
  const resumed = await client.waitFor('task.upserted', (item) => item.id === task.id
    && (item.ledger?.tried?.length ?? 0) > failed.ledger.tried.length && lastOutcome(item) !== 'unavailable', 50_000);
  assert.ok(Date.now() - enabledAt < 50_000, 're-woken by the event, not by the backoff');
  assert.notEqual(resumed.status, 'blocked');
  // The fake engine only echoes, so the task would keep continuing (paced); stop it here.
  await client.call('tasks.setStatus', { id: task.id, status: 'cancelled' });
});
