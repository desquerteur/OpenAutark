// Removing a task removes its parts with it (ON DELETE CASCADE: steps and delegated work, T09):
// nothing of a part stays planned either – its wakes, schedules and timers go just like the removed task's own.
// Owns: these assertions only.
// Never: real timers, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

test('a removed task takes the wakes and schedules of its steps and delegated work with it', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom', { createdAt: 1 }));
  h.org.add(agent('ag_ivy', 'Ivy', { createdAt: 2 }));
  const chat = h.chats.create({ title: 'Launch', agentIds: ['ag_tom', 'ag_ivy'], createdBy: 'human' });
  const parent = h.tasks.create({ conversationId: chat.id, title: 'Cut the launch video', assigneeId: 'ag_tom', createdBy: 'human' });
  const child = h.tasks.create({ conversationId: chat.id, parentId: parent.id, title: 'Find the music', assigneeId: 'ag_ivy', createdBy: 'ag_tom' });
  const todo = h.tasks.create({ conversationId: chat.id, parentId: child.id, title: 'Pick a track', assigneeKind: 'human', humanReason: 'physical', createdBy: 'ag_ivy' });
  const other = h.tasks.create({ conversationId: chat.id, title: 'Write the post', assigneeId: 'ag_ivy', createdBy: 'human' });
  h.wakes.wake({ agentId: 'ag_ivy', reason: 'task', conversationId: chat.id, taskId: child.id, coalesceKey: `task:${child.id}` });
  h.scheduler.create({ ownerId: HUMAN_ID, conversationId: chat.id, taskId: todo.id, kind: 'timer', title: todo.title, spec: { at: h.clock.now() + 3_600_000 }, payload: {} });
  h.wakes.wake({ agentId: 'ag_ivy', reason: 'task', conversationId: chat.id, taskId: other.id, coalesceKey: `task:${other.id}` });
  assert.ok(h.wakeRows().some((row) => row.task_id === child.id));
  assert.equal(h.scheduler.list({ taskId: todo.id }).length, 1);

  h.tasks.remove(parent.id, HUMAN_ID);
  assert.equal(h.tasks.get(child.id), undefined, 'the delegated work went with its task');
  assert.deepEqual(h.wakeRows().filter((row) => row.task_id === child.id || row.task_id === todo.id), [], 'no wake for a part');
  assert.deepEqual(h.scheduler.list({ taskId: todo.id }), [], "the part's timer is gone");
  assert.ok(h.wakeRows().some((row) => row.task_id === other.id), 'other tasks keep their wakes');
});
