// End-to-end (T02): retries follow the task's owner and the human's Cancel stops the work, over
// the real headless runtime (built app/runtime-cli.mjs) with the deterministic fake engine and
// real WebSocket RPC. The fake engine's echo counts as progress, so an agent's own task keeps
// continuing about every second – which makes a missing stop visible within seconds.
// Covers: after a reassignment the previous owner starts no more turns on the task and the
// ledger notes the change; the new owner runs it; after the human cancels it nobody does.
// Run: npm run build && node --test test/e2e/runtime-task-owner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const QUIET_MS = 4000; // several continuation periods (1 s each)
const GRACE_MS = 1500; // a turn that was already starting when the change landed

test('retries follow the owner; the human cancel stops the work', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const rhea = await client.call('agents.create', { name: 'Rhea', managerId: manager.id });
  await client.call('events.subscribe', { topics: [`runs:${manager.id}`, `runs:${rhea.id}`] });

  /** Turns of an agent on the task that started after `since`. */
  const turnsOn = (taskId, agentId, since) => new Set(client.events
    .filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === agentId && frame.data.taskId === taskId && (frame.data.startedAt ?? 0) > since)
    .map((frame) => frame.data.id)).size;

  const chat = await client.call('chats.create', { title: 'Hosting', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  await client.call('messages.send', { conversationId: chat.id, body: 'Later [[tool:tasks.create {"title":"Compare hosting offers"}]]' });
  const task = await client.waitFor('task.upserted', (item) => item.title === 'Compare hosting offers', 90_000);
  assert.equal(task.assigneeId, manager.id);
  await client.waitFor('run.upserted', (run) => run.agentId === manager.id && run.taskId === task.id, 90_000);

  await t.test('after a reassignment the previous owner starts no more turns on the task', async () => {
    const reassigned = await client.call('tasks.update', { id: task.id, patch: { assigneeKind: 'agent', assigneeId: rhea.id } });
    const at = Date.now();
    assert.equal(reassigned.assigneeId, rhea.id);
    assert.ok(reassigned.ledger.facts?.some((fact) => /^Reassigned from .+ to Rhea\.$/.test(fact)), 'the ledger notes the new owner');
    await client.waitFor('run.upserted', (run) => run.agentId === rhea.id && run.taskId === task.id, 90_000);
    await sleep(QUIET_MS);
    assert.equal(turnsOn(task.id, manager.id, at + GRACE_MS), 0, 'no duplicate work by the previous owner');
    assert.ok(turnsOn(task.id, rhea.id, at) >= 1, 'the new owner works on it');
  });

  await t.test('after the human cancels the task nobody starts another turn on it', async () => {
    await client.call('tasks.setStatus', { id: task.id, status: 'cancelled' });
    const at = Date.now();
    await sleep(QUIET_MS);
    assert.equal(turnsOn(task.id, rhea.id, at + GRACE_MS), 0);
    assert.equal(turnsOn(task.id, manager.id, at), 0);
    assert.equal((await client.call('tasks.get', { id: task.id })).status, 'cancelled');
  });
});
