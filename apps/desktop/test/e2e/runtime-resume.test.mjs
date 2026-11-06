// End-to-end (T03): work waiting on the person continues at once, over the real headless runtime
// (built app/runtime-cli.mjs) with the deterministic fake engine and real WebSocket RPC.
// Covers: a task that needs the person waits quietly; the person finishing its last human step
// sets it working again ('Continuing: …' line) and its owner runs a turn on it; a message of the
// person in that chat while it waits is a turn on that task; the person reopening finished work
// wakes the owner and the ledger keeps the reopen.
// Run: npm run build && node --test test/e2e/runtime-resume.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const QUIET_MS = 4000; // several continuation periods (1 s each): turns in flight end, then nothing runs
const GRACE_MS = 1500; // a turn that was already starting when the change landed

test('tasks waiting on the person continue as soon as the person acts', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  await client.call('events.subscribe', { topics: [`runs:${manager.id}`] });

  /** Turns of the manager on the task that started after `since`. */
  const turnsOn = (taskId, since) => new Set(client.events
    .filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === manager.id && frame.data.taskId === taskId && (frame.data.startedAt ?? 0) > since)
    .map((frame) => frame.data.id)).size;
  const nextTurn = (taskId, since) => client.waitFor('run.upserted', (run) => run.agentId === manager.id && run.taskId === taskId && (run.startedAt ?? 0) > since, 90_000);
  /** Sets the task to needs_you and waits until no turn runs on it any more. */
  const waitOnPerson = async (taskId) => {
    await client.call('tasks.setStatus', { id: taskId, status: 'needs_you', note: 'Log in first' });
    await sleep(QUIET_MS);
    const at = Date.now();
    await sleep(QUIET_MS);
    assert.equal(turnsOn(taskId, at), 0, 'a task waiting on the person runs no turns');
    return Date.now();
  };

  const chat = await client.call('chats.create', { title: 'Sign-up', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  const task = await client.call('tasks.create', { conversationId: chat.id, title: 'Finish the portal sign-up', assigneeKind: 'agent', assigneeId: manager.id });
  await nextTurn(task.id, 0);

  await t.test('the last human step done: the task works again and its owner continues', async () => {
    const step = await client.call('tasks.create', {
      conversationId: chat.id, parentId: task.id, title: 'Log in to the portal', assigneeKind: 'human', humanReason: 'credential',
      widget: { type: 'confirm', instructions: 'Log in, then confirm here' },
    });
    const at = await waitOnPerson(task.id);
    await client.call('tasks.complete', { id: step.id, answer: { confirmed: true } });
    const resumed = await client.call('tasks.get', { id: task.id });
    // B-078 D11: 'working' only while a run is live – until the owner's turn starts it may read 'open' (queued).
    assert.ok(['open', 'working'].includes(resumed.status), `back to work, not waiting: ${resumed.status}`);
    assert.equal(resumed.waitingOn, undefined);
    await nextTurn(task.id, at);
    const lines = (await client.call('messages.list', { conversationId: chat.id })).filter((message) => message.kind === 'status').map((message) => message.body);
    assert.ok(lines.includes('Continuing: Finish the portal sign-up'), 'a quiet line says it continues');
  });

  await t.test('a message of the person while it waits is a turn on that task', async () => {
    const at = await waitOnPerson(task.id);
    await client.call('messages.send', { conversationId: chat.id, body: 'I finished the login' });
    const run = await nextTurn(task.id, at);
    assert.equal(run.taskId, task.id);
  });

  await t.test('the person reopening finished work wakes its owner; the ledger keeps it', async () => {
    await client.call('tasks.setStatus', { id: task.id, status: 'done', note: 'Signed up' });
    await sleep(GRACE_MS);
    const at = Date.now();
    const reopened = await client.call('tasks.setStatus', { id: task.id, status: 'open', note: 'Add the invoice address' });
    assert.ok(reopened.ledger.facts?.includes('Reopened by the human: Add the invoice address'));
    await nextTurn(task.id, at);
    await client.call('tasks.setStatus', { id: task.id, status: 'cancelled' });
  });
});
