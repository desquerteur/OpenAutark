// End-to-end (C2): archive keeps working, and agents manage rooms, over the real headless runtime
// (built app/runtime-cli.mjs) with the deterministic fake engine and real WebSocket RPC.
// Covers: in an archived chat the agent still answers and works on a task created there, and the
// chat stays archived for ordinary replies; its important message (chat.send urgent) brings the
// chat back with one 'unarchived' line; the lead removes a colleague with chat.remove_members, and
// a later @mention of the removed agent starts no turn for it.
// Run: npm run build && node --test test/e2e/runtime-archive.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const QUIET_MS = 4000;

test('archived chats keep working; the lead removes a member who is then not woken', { timeout: 240_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org'] });
  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds a manager');
  const rhea = await client.call('agents.create', { name: 'Rhea', managerId: manager.id });
  await client.call('events.subscribe', { topics: [`runs:${manager.id}`, `runs:${rhea.id}`] });

  await t.test('an archived chat: the agent answers and works on its task; urgent brings it back', async () => {
    const chat = await client.call('chats.create', { title: 'Venue', agentIds: [manager.id] });
    await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });
    await client.call('chats.archive', { id: chat.id });
    const sent = await client.call('messages.send', { conversationId: chat.id, body: 'Please [[tool:tasks.create {"title":"Book the venue"}]]' });
    const task = await client.waitFor('task.upserted', (item) => item.title === 'Book the venue', 90_000);
    assert.equal(task.conversationId, chat.id);
    await client.waitFor('message.created', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.seq > sent.seq, 90_000);
    await client.waitFor('run.upserted', (run) => run.agentId === manager.id && run.taskId === task.id, 90_000);
    assert.ok((await client.call('chats.get', { id: chat.id })).archivedAt, 'ordinary replies keep it archived');

    await client.call('messages.send', { conversationId: chat.id, body: 'Loudly [[tool:chat.send {"text":"The venue cancelled","urgent":true}]]' });
    const line = await client.waitFor('message.created', (message) => message.conversationId === chat.id && message.meta?.status?.type === 'unarchived', 90_000);
    assert.equal(line.body, `Unarchived: important message from ${manager.name}`);
    assert.equal((await client.call('chats.get', { id: chat.id })).archivedAt, undefined);
    assert.equal((await client.call('messages.list', { conversationId: chat.id })).filter((message) => message.meta?.status?.type === 'unarchived').length, 1);
  });

  await t.test('the lead removes a colleague; an @mention of it later wakes nobody', async () => {
    const room = await client.call('chats.create', { title: 'Launch', agentIds: [manager.id, rhea.id] });
    await client.call('events.subscribe', { topics: [`chat:${room.id}`] });
    assert.equal((await client.call('chats.get', { id: room.id })).members.find((member) => member.role === 'lead')?.memberId, manager.id, 'the manager leads');
    await client.call('messages.send', { conversationId: room.id, body: `@${manager.name} [[tool:chat.remove_members {"memberIds":["${rhea.id}"]}]]` });
    await client.waitFor('message.created', (message) => message.conversationId === room.id && message.meta?.status?.type === 'member_removed', 90_000);
    const removed = (await client.call('chats.get', { id: room.id })).members.find((member) => member.memberId === rhea.id);
    assert.ok(!removed || removed.leftAt, 'Rhea left the room');

    const at = Date.now();
    await client.call('messages.send', { conversationId: room.id, body: '@Rhea are you there?' });
    await sleep(QUIET_MS);
    const turns = client.events.filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === rhea.id && frame.data.conversationId === room.id && (frame.data.startedAt ?? 0) > at);
    assert.equal(turns.length, 0, 'the removed agent is not woken');
  });
});
