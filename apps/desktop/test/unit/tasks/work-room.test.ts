// B-078 D7 (T1.3): work for an agent out of a 1:1 it is not in reaches it in the giver's own 1:1 with it – on
// tasks.create (tasks/create.ts) and on tasks.assign (tasks/service.ts → owners.ts routeOwner); the wake lands where
// the agent is a member, and the 1:1 stays two.
// Owns: these assertions only. Never: engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { findDirect, findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';

const isMember = (h: ReturnType<typeof harness>, conversationId: string, id: string) =>
  h.chats.members(conversationId).some((member) => member.memberId === id && !member.leftAt);

function pair() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_bob', 'Bob'));
  const direct = findOrCreateDirect(h.services, 'human', 'ag_ava', { createdBy: 'human' });
  return { ...h, direct };
}

test('T1.3: Ava creating a task for Bob in her 1:1 with the owner hands it over in her 1:1 with Bob, and wakes him there', () => {
  const h = pair();
  const task = h.tasks.create({ conversationId: h.direct, title: 'Cut the trailer', assigneeId: 'ag_bob', createdBy: 'ag_ava' });
  const room = findDirect(h.services, 'ag_ava', 'ag_bob');
  assert.ok(room, 'Ava and Bob have their 1:1 now');
  assert.equal(task.conversationId, room);
  assert.equal(isMember(h, h.direct, 'ag_bob'), false, 'the 1:1 with the owner stays two');
  const wake = h.wakeRows().find((row) => row.agent_id === 'ag_bob' && row.task_id === task.id);
  assert.equal(wake?.conversation_id, room, 'Bob is woken where he is a member');
});

test('T1.3: a task for a member of the 1:1, or created by the system, keeps its chat', () => {
  const h = pair();
  const own = h.tasks.create({ conversationId: h.direct, title: 'Draft', assigneeId: 'ag_ava', createdBy: 'human' });
  assert.equal(own.conversationId, h.direct);
  const system = h.tasks.create({ conversationId: h.direct, title: 'Check', assigneeId: 'ag_bob', createdBy: 'system' });
  assert.equal(system.conversationId, h.direct);
});

test('T1.3: tasks.assign to an agent outside the 1:1 moves the task into the giver\'s 1:1 with it and wakes it there', () => {
  const h = pair();
  const task = h.tasks.create({ conversationId: h.direct, title: 'Music', assigneeId: 'ag_ava', createdBy: 'human' });
  h.db.run('DELETE FROM wakes');
  const view = h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'human');
  const room = findDirect(h.services, 'human', 'ag_bob');
  assert.equal(view.conversationId, room);
  assert.equal(isMember(h, h.direct, 'ag_bob'), false);
  const wake = h.wakeRows().find((row) => row.agent_id === 'ag_bob' && row.task_id === task.id);
  assert.equal(wake?.conversation_id, room);
});
