// End-to-end (T01): own tasks and lead-less team tasks are picked up, over the real headless
// runtime (built app/runtime-cli.mjs) with the deterministic fake engine and real WebSocket RPC.
// Covers: an agent's own task (tasks.create, default assignee self) gets a turn of its own after
// the creating turn; a chat-free team task (no owner) wakes the responsible manager, who decides (tasks/lifecycle.ts
// wakeLead – no router any more), and opens no chat.
// Run: npm run build && node --test test/e2e/runtime-self-tasks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from './lib/runtime-client.mjs';

test('own tasks and lead-less team tasks get a turn', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');

  await t.test('an agent\'s own task is resumed after the creating turn', async () => {
    const chat = await client.call('chats.create', { title: 'Own work', agentIds: [manager.id] });
    await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
    await client.call('messages.send', {
      conversationId: chat.id,
      body: 'Later [[tool:tasks.create {"title":"Compare hosting offers","doneWhen":"Three offers compared"}]]',
    });
    const task = await client.waitFor('task.upserted', (item) => item.title === 'Compare hosting offers', 90_000);
    assert.equal(task.assigneeKind, 'agent');
    assert.equal(task.assigneeId, manager.id, 'tasks.create defaults to the creating agent');
    await client.waitFor('task.upserted', (item) => item.id === task.id && item.running === true, 90_000);
    // The fake engine only echoes, so the task would keep continuing (paced); stop it here.
    await client.call('tasks.setStatus', { id: task.id, status: 'cancelled' });
  });

  await t.test('a chat-free team task wakes the responsible manager and opens no chat (B-054)', async () => {
    await client.call('events.subscribe', { topics: [`runs:${manager.id}`] });
    const before = (await client.call('chats.list', { includeHidden: true })).length;
    const task = await client.call('tasks.create', { title: 'Find three venues for the meetup', assigneeKind: 'team' });
    assert.equal(task.conversationId, undefined, 'the task needs no chat');
    const run = await client.waitFor('run.upserted', (item) => item.agentId === manager.id && item.taskId === task.id, 90_000);
    assert.ok(run, 'the manager runs a turn on it');
    const current = await client.call('tasks.get', { id: task.id });
    assert.equal(current.conversationId, undefined, 'nothing moved it into a chat');
    assert.equal((await client.call('chats.list', { includeHidden: true })).length, before, 'no chat was opened for it');
    await client.call('tasks.setStatus', { id: task.id, status: 'cancelled' });
  });
});
