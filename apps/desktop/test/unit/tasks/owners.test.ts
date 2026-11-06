// Owner transitions (tasks/owners.ts): new agent owners join the task's chat (also the hidden
// To-do chat) on create/assign by the human, the system or a chat member – never by an outside
// agent or by claiming – and archiving an agent hands its open tasks to its manager chain, a
// space or company-wide manager, or leaves them 'blocked' for the human.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent, harness } from '../chat/harness.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { routeOwner, successorFor } from '../../../src/runtime/tasks/owners.ts';
import { findDirect, findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { RESOURCES } from '../store/helpers.ts';
import type { OrgService } from '../../../src/runtime/contracts.ts';

const isMember = (h: ReturnType<typeof harness>, conversationId: string, id: string) =>
  h.chats.members(conversationId).some((member) => member.memberId === id);

/** Harness with the real OrgService (it emits 'agent.removed' on archive). */
function withOrg() {
  const h = harness();
  const org = new Org({ db: h.db, bus: h.bus, clock: h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  (h.services as { org: OrgService }).org = org;
  return { ...h, realOrg: org };
}

test('assign/create: an agent owner that is not in the chat joins it', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_bob', 'Bob'));
  h.org.add(agent('ag_cy', 'Cy'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });

  const task = h.tasks.create({ conversationId: chat.id, title: 'Cut the trailer', createdBy: 'human' });
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'human');
  assert.ok(isMember(h, chat.id, 'ag_bob'), 'assign adds the new owner');
  const lines = h.chats.messages(chat.id).filter((message) => message.kind === 'status').map((message) => message.meta.status?.type);
  assert.ok(lines.indexOf('member_added') < lines.lastIndexOf('note'), 'joined before the assignment line');
  assert.equal(h.chats.lead(chat.id), 'ag_ava', 'lead unchanged');

  h.tasks.create({ conversationId: chat.id, title: 'Music', assigneeId: 'ag_cy', createdBy: 'ag_ava' });
  assert.ok(isMember(h, chat.id, 'ag_cy'), 'create with an agent assignee adds it');

  const before = h.chats.messages(chat.id).length;
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_ava' }, 'human');
  assert.equal(h.chats.messages(chat.id).filter((message) => message.meta.status?.type === 'member_added').length, 2, 'members are not re-added');
  assert.ok(h.chats.messages(chat.id).length > before);
});

test('B-054: a chat-free task for an agent joins it to no chat (create and assign)', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_bob', 'Bob'));
  const members = () => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM members')!.n;
  const before = members();
  const task = h.tasks.create({ title: 'Book the studio', assigneeKind: 'agent', assigneeId: 'ag_ava', createdBy: 'human' });
  assert.equal(task.conversationId, undefined);
  assert.equal(h.tasks.get(task.id)?.assigneeId, 'ag_ava');
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'human');
  assert.equal(h.tasks.get(task.id)?.assigneeId, 'ag_bob');
  assert.equal(members(), before, 'nobody joined anything');
});

test('an agent outside the chat cannot bring itself or others in by assigning or claiming there', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_eve', 'Eve'));
  h.org.add(agent('ag_bob', 'Bob'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: chat.id, title: 'Private plan', createdBy: 'human' });

  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_eve' }, 'ag_eve');
  assert.equal(isMember(h, chat.id, 'ag_eve'), false, 'self-assignment from outside');
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'ag_eve');
  assert.equal(isMember(h, chat.id, 'ag_bob'), false, 'assignment by an outsider');
  const team = h.tasks.create({ conversationId: chat.id, title: 'Pick an owner', createdBy: 'human' });
  assert.equal(h.tasks.claim(team.id, 'ag_eve'), true, 'the claim itself still works');
  assert.equal(isMember(h, chat.id, 'ag_eve'), false, 'claiming does not join');

  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'ag_ava');
  assert.ok(isMember(h, chat.id, 'ag_bob'), 'a member brings the new owner in');
  h.chats.setMembers(chat.id, { remove: ['ag_bob'] }, 'human');
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'ag_bob');
  h.tasks.create({ conversationId: chat.id, title: 'Sneak in', parentId: task.id, assigneeId: 'ag_bob', createdBy: 'ag_bob' });
  assert.equal(isMember(h, chat.id, 'ag_bob'), false, 'a removed agent does not re-join on its own');
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_bob' }, 'human');
  assert.ok(isMember(h, chat.id, 'ag_bob'), 'the human can bring it back');
});

test('unknown or archived assignees are refused (create and assign alike)', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_old', 'Old', { archivedAt: 1 }));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  assert.throws(() => h.tasks.create({ conversationId: chat.id, title: 'Ghost work', assigneeId: 'ag_ghost', createdBy: 'human' }), /Agent not found/);
  assert.throws(() => h.tasks.create({ conversationId: chat.id, title: 'Old work', assigneeId: 'ag_old', createdBy: 'human' }), /Agent not found/);
  assert.equal(isMember(h, chat.id, 'ag_ghost'), false);
  const task = h.tasks.create({ conversationId: chat.id, title: 'Real work', createdBy: 'human' });
  assert.throws(() => h.tasks.assign(task.id, { kind: 'agent', id: 'ag_ghost' }, 'human'), /Agent not found/);
});

test('archiving an agent hands its open tasks (and steps) to its manager', () => {
  const h = withOrg();
  const boss = h.realOrg.create({ name: 'Mia', mode: 'manager', createdBy: 'human' });
  const ava = h.realOrg.create({ name: 'Ava', managerId: boss.id, createdBy: 'human' });
  const chat = h.chats.create({ agentIds: [ava.id], createdBy: 'human' });
  const open = h.tasks.create({ conversationId: chat.id, title: 'Cut the trailer', steps: ['Rough cut', 'Music'], assigneeId: ava.id, createdBy: 'human' });
  const working = h.tasks.create({ conversationId: chat.id, title: 'Color grade', assigneeId: ava.id, createdBy: 'human' });
  h.tasks.setStatus(working.id, 'working', ava.id);
  const done = h.tasks.create({ conversationId: chat.id, title: 'Export', assigneeId: ava.id, createdBy: 'human' });
  h.tasks.complete(done.id, { summary: 'Exported', evidence: [{ kind: 'note', label: 'ok' }], verification: 'claimed_by_agent' }, ava.id);
  assert.ok(h.wakeRows().some((row) => row.agent_id === ava.id && row.task_id === open.id));
  const upserts = h.of('task.upserted').length;

  h.realOrg.archive(ava.id);

  for (const id of [open.id, working.id]) {
    const task = h.tasks.get(id)!;
    assert.equal(task.assigneeId, boss.id, task.title);
    assert.ok(task.ledger.facts?.some((fact) => fact.includes('Ava')), 'ledger says where it came from');
    assert.ok(h.wakeRows().some((row) => row.agent_id === boss.id && row.task_id === id && row.reason === 'task'), 'successor woken');
  }
  assert.equal(h.tasks.get(working.id)!.status, 'working');
  assert.deepEqual(h.tasks.get(open.id)!.steps.map((step) => step.assigneeId), [boss.id, boss.id], 'steps follow');
  assert.equal(h.tasks.get(done.id)!.assigneeId, ava.id, 'finished work keeps its owner');
  const moved = new Set([open.id, working.id]);
  assert.equal(h.wakeRows().filter((row) => row.agent_id === ava.id && moved.has(row.task_id ?? '')).length, 0, 'archived agent’s wakes for moved tasks cancelled');
  assert.ok(isMember(h, chat.id, boss.id), 'successor joined the chat');
  assert.ok(h.of('task.upserted').length > upserts, 'normal task events');
  assert.ok(h.chats.messages(chat.id).some((message) => message.body === 'Assigned to Mia: Cut the trailer'));
  assert.equal(h.tasks.openFor(ava.id).length, 0);
});

test('B-078 D7: a task of the archived agent’s 1:1 with the owner moves to the successor’s own 1:1 with the owner', () => {
  const h = withOrg();
  const boss = h.realOrg.create({ name: 'Mia', mode: 'manager', createdBy: 'human' });
  const ava = h.realOrg.create({ name: 'Ava', managerId: boss.id, createdBy: 'human' });
  const direct = findOrCreateDirect(h.services, 'human', ava.id, { createdBy: 'human' });
  const task = h.tasks.create({ conversationId: direct, title: 'Renew the domain', steps: ['Check the price'], assigneeId: ava.id, createdBy: 'human' });

  h.realOrg.archive(ava.id);

  const room = findDirect(h.services, 'human', boss.id);
  assert.ok(room && room !== direct, 'the successor’s own 1:1 with the owner');
  const moved = h.tasks.get(task.id)!;
  assert.equal(moved.assigneeId, boss.id);
  assert.equal(moved.conversationId, room, 'the task moved into it');
  assert.deepEqual(moved.steps.map((step) => step.conversationId), [room], 'its steps follow');
  assert.equal(isMember(h, direct, boss.id), false, 'the 1:1 stays two');
  const wakes = h.wakeRows().filter((row) => row.agent_id === boss.id && row.task_id === task.id);
  assert.ok(wakes.length > 0, 'successor woken');
  for (const wake of wakes) assert.ok(isMember(h, wake.conversation_id!, boss.id), 'in a chat it is a member of');
});

test('B-078 D7: the owner assigning a task of his 1:1 to another agent moves it into his 1:1 with that agent (routeOwner)', () => {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_bob', 'Bob'));
  const direct = findOrCreateDirect(h.services, 'human', 'ag_ava', { createdBy: 'human' });
  const task = h.tasks.create({ conversationId: direct, title: 'Cut the trailer', assigneeId: 'ag_ava', createdBy: 'human' });
  const room = routeOwner(h.tasks, h.tasks.get(task.id)!, 'ag_bob', 'human');
  assert.equal(room, findDirect(h.services, 'human', 'ag_bob'));
  assert.equal(h.tasks.get(task.id)!.conversationId, room);
  assert.equal(isMember(h, direct, 'ag_bob'), false, 'the 1:1 stays two');
  const group = h.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const other = h.tasks.create({ conversationId: group.id, title: 'Music', createdBy: 'human' });
  assert.equal(routeOwner(h.tasks, h.tasks.get(other.id)!, 'ag_bob', 'human'), group.id, 'any other chat: the agent joins it');
  assert.ok(isMember(h, group.id, 'ag_bob'));
});

test('without a manager chain: a manager of the space, else a company-wide manager takes over', () => {
  const h = withOrg();
  const company = h.realOrg.create({ name: 'Chief', mode: 'manager', createdBy: 'human' });
  const brand = h.realOrg.saveSpace({ name: 'Brand', kind: 'brand' });
  const home = h.realOrg.saveSpace({ name: 'Private', kind: 'private' });
  const brandLead = h.realOrg.create({ name: 'Brand lead', mode: 'manager', spaceId: brand.id, createdBy: 'human' });
  const subManager = h.realOrg.create({ name: 'Sub', mode: 'manager', spaceId: home.id, managerId: brandLead.id, createdBy: 'human' });
  const writer = h.realOrg.create({ name: 'Writer', spaceId: brand.id, createdBy: 'human' });
  const cook = h.realOrg.create({ name: 'Cook', spaceId: home.id, createdBy: 'human' });
  const org = h.services.org;
  assert.equal(successorFor(org, writer.id)?.id, brandLead.id, 'space manager first');
  assert.equal(successorFor(org, cook.id)?.id, subManager.id, 'a manager of the same space, even below someone');
  h.realOrg.archive(subManager.id);
  assert.equal(successorFor(org, cook.id)?.id, company.id, 'then the company-wide manager');
  assert.equal(successorFor(org, company.id)?.id, brandLead.id, 'a top-level manager of another space is the last resort');

  const chat = h.chats.create({ agentIds: [writer.id], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: chat.id, title: 'Draft the newsletter', assigneeId: writer.id, createdBy: 'human' });
  h.realOrg.archive(writer.id);
  assert.equal(h.tasks.get(task.id)!.assigneeId, brandLead.id);
});

test('no manager left: open tasks stay with a blocked note for the human', () => {
  const h = withOrg();
  const ava = h.realOrg.create({ name: 'Ava', createdBy: 'human' });
  h.realOrg.create({ name: 'Bob', createdBy: 'human' });
  const chat = h.chats.create({ agentIds: [ava.id], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: chat.id, title: 'Renew the domain', steps: ['Check price'], assigneeId: ava.id, createdBy: 'human' });
  const stuck = h.tasks.create({ conversationId: chat.id, title: 'Fix the invoice', assigneeId: ava.id, createdBy: 'human' });
  h.tasks.setStatus(stuck.id, 'blocked', ava.id, 'Waiting for the bank');

  h.realOrg.archive(ava.id);

  for (const id of [task.id, stuck.id]) {
    const view = h.tasks.get(id)!;
    assert.equal(view.status, 'blocked', view.title);
    assert.equal(view.assigneeId, ava.id, 'the record of who had it stays');
    assert.equal(view.waitingOn?.kind, 'human');
    assert.equal(view.waitingOn?.reason, 'Owner archived: Ava');
  }
  assert.equal(h.tasks.get(task.id)!.steps[0].status, 'open', 'steps stay with their blocked task');
  assert.deepEqual(h.notified.filter((entry) => entry.kind === 'blocker').map((entry) => entry.taskId).sort(), [task.id, stuck.id].sort());
  assert.ok(h.chats.messages(chat.id).some((message) => message.body === 'Blocked: Renew the domain · Owner archived: Ava'));
  assert.equal(h.wakeRows().filter((row) => row.agent_id === ava.id).length, 0);
});

test('work delegated to the archived agent under someone else’s task moves on its own (woken), or is blocked', () => {
  const h = withOrg();
  const boss = h.realOrg.create({ name: 'Mia', mode: 'manager', createdBy: 'human' });
  const ava = h.realOrg.create({ name: 'Ava', managerId: boss.id, createdBy: 'human' });
  const bob = h.realOrg.create({ name: 'Bob', createdBy: 'human' });
  const chat = h.chats.create({ agentIds: [ava.id, bob.id], createdBy: 'human' });
  const parent = h.tasks.create({ conversationId: chat.id, title: 'Launch', assigneeId: bob.id, createdBy: 'human' });
  const child = h.tasks.create({ conversationId: chat.id, title: 'Write the copy', parentId: parent.id, assigneeId: ava.id, createdBy: bob.id });
  const parentEvents = () => h.of('task.upserted').filter((view) => view.id === parent.id).length;
  const before = parentEvents();

  h.realOrg.archive(ava.id);

  assert.equal(h.tasks.get(child.id)!.assigneeId, boss.id);
  assert.ok(h.wakeRows().some((row) => row.agent_id === boss.id && row.task_id === child.id && row.reason === 'task'), 'new owner woken');
  assert.equal(h.tasks.get(parent.id)!.assigneeId, bob.id, 'the parent keeps its owner');
  assert.equal(h.tasks.get(parent.id)!.steps[0].assigneeId, boss.id);
  assert.ok(parentEvents() > before, 'the parent view shows the moved step');
});

test('no manager left: delegated work under someone else’s task is blocked for the human', () => {
  const h = withOrg();
  const ava = h.realOrg.create({ name: 'Ava', createdBy: 'human' });
  const bob = h.realOrg.create({ name: 'Bob', createdBy: 'human' });
  const chat = h.chats.create({ agentIds: [ava.id, bob.id], createdBy: 'human' });
  const parent = h.tasks.create({ conversationId: chat.id, title: 'Launch', assigneeId: bob.id, createdBy: 'human' });
  const child = h.tasks.create({ conversationId: chat.id, title: 'Write the copy', parentId: parent.id, assigneeId: ava.id, createdBy: bob.id });

  h.realOrg.archive(ava.id);

  const view = h.tasks.get(child.id)!;
  assert.equal(view.status, 'blocked');
  assert.equal(view.waitingOn?.reason, 'Owner archived: Ava');
  assert.deepEqual(h.notified.filter((entry) => entry.kind === 'blocker').map((entry) => entry.taskId), [child.id]);
  assert.equal(h.tasks.get(parent.id)!.status, 'open', 'the parent stays with its owner');
});
