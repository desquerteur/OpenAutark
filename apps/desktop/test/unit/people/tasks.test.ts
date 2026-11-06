// F-52 tasks across people and agents: work goes to a person only in a chat they belong to; their
// For you holds only their own to-dos (not the owner's, and the owner's list not theirs); only they
// finish their work (as themselves); they delegate to agents of their spaces and hand work to the
// owner; agents hand work to them and hear back; an agent's ask goes to the person who wrote last;
// agents read a person's message as a colleague's, never as the CEO's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig, settle } from './rig.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { authorName } from '../../../src/runtime/context/render.ts';
import { realId, viewId, viewTask } from '../../../src/runtime/people/perspective.ts';

test('a task for a person: their For you only, the assigning agent hears it when they finish', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const chat = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Launch' });
  const outside = r.chats.create({ agentIds: ['ag_research'], createdBy: 'human', title: 'Owner only' });
  const task = r.tasks.create({ conversationId: chat.id, title: 'Pick the colours', createdBy: 'ag_research' });
  // An agent hands it to her – no humanReason needed for a colleague; not into a chat she is not in.
  const given = r.tasks.assign(task.id, { kind: 'human', id: anna.person.id }, 'ag_research');
  assert.equal(given.assigneeId, anna.person.id);
  const elsewhere = r.tasks.create({ conversationId: outside.id, title: 'Secret', createdBy: 'ag_research' });
  assert.throws(() => r.tasks.assign(elsewhere.id, { kind: 'human', id: anna.person.id }, 'ag_research'), /not in this chat/);
  assert.equal(r.notified.filter((note) => note.title === 'Pick the colours').length, 0, 'the owner is not notified of her work');

  const hers = await anna.client.call<TaskView[]>('todos.list');
  assert.deepEqual(hers.map((entry) => entry.title), ['Pick the colours']);
  assert.equal(hers[0].assigneeId, undefined, 'hers reads as "mine"');
  const owners = await r.owner.call<TaskView[]>('todos.list');
  assert.ok(!owners.some((entry) => entry.id === task.id), 'not on the owner\'s For you');

  const done = await anna.client.call<TaskView>('tasks.complete', { id: task.id, note: 'Blue and sand' });
  assert.equal(done.status, 'done');
  const stored = r.tasks.get(task.id)!;
  assert.equal(stored.result?.verification, 'reported_by_human');
  assert.equal(stored.result?.summary, 'Blue and sand');
  await settle();
  assert.ok(r.wakeRows().some((row) => row.agent_id === 'ag_research' && row.task_id === task.id), 'the assigning agent is woken to check it');
});

test('a person creates and delegates work: to an agent of their spaces, a colleague in the chat, the owner', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg', { scopes: { spaces: ['sp_company'], startChats: true, assignAgents: true } });
  const ben = await r.join('Ben Vogt');
  const chat = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id, ben.person.id], createdBy: 'human', title: 'Team' });
  const own = await anna.client.call<TaskView>('tasks.create', { conversationId: chat.id, title: 'Write the brief', assigneeKind: 'human' });
  assert.equal(r.tasks.get(own.id)!.assigneeId, anna.person.id);
  assert.equal(r.chats.message(r.tasks.get(own.id)!.messageId!)!.authorKind, 'human', 'the anchor is hers, as a human');
  const delegated = await anna.client.call<TaskView>('tasks.update', { id: own.id, patch: { assigneeKind: 'agent', assigneeId: 'ag_research' } });
  assert.equal(delegated.assigneeId, 'ag_research');
  assert.ok(r.wakeRows().some((row) => row.agent_id === 'ag_research' && row.task_id === own.id), 'the agent owner is woken');
  await assert.rejects(anna.client.call('tasks.create', { conversationId: chat.id, title: 'x', assigneeKind: 'agent', assigneeId: 'ag_secret' }), /may not work with this agent/);
  const forBen = await anna.client.call<TaskView>('tasks.create', { conversationId: chat.id, title: 'Review the brief', assigneeKind: 'human', assigneeId: ben.person.id });
  assert.equal(forBen.assigneeId, ben.person.id);
  assert.deepEqual((await ben.client.call<TaskView[]>('todos.list')).map((entry) => entry.title), ['Review the brief']);
  await assert.rejects(ben.client.call('tasks.update', { id: delegated.id, patch: { title: 'mine now' } }), /Only your own tasks/);
  const forOwner = await anna.client.call<TaskView>('tasks.create', { conversationId: chat.id, title: 'Approve the budget', assigneeKind: 'human', assigneeId: 'owner' });
  assert.equal(forOwner.assigneeId, 'owner', 'the CEO\'s to-do reads as the owner\'s in her view');
  assert.equal(r.tasks.get(forOwner.id)!.assigneeId, undefined, 'stored as the owner\'s To-do');
  assert.ok((await r.owner.call<TaskView[]>('todos.list')).some((entry) => entry.id === forOwner.id), 'on the owner\'s For you');
  assert.ok(r.notified.some((note) => note.title === 'Approve the budget'), 'the owner is notified');
  assert.ok(!(await anna.client.call<TaskView[]>('todos.list')).some((entry) => entry.id === forOwner.id));
});

test('an agent\'s ask goes to the person who wrote last; agents read people as colleagues', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  r.services.settings.update({ profile: { name: 'Mara' } });
  const anna = await r.join('Anna Berg', { title: 'Designer' });
  const chat = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Logo' });
  await anna.client.call('messages.send', { conversationId: chat.id, body: '@Research which logo?', mentions: ['ag_research'] });
  const answer = r.chats.beginAgentMessage(chat.id, 'ag_research', 'run_1');
  r.chats.finishAgentMessage(answer.id, { body: 'Pick one:\n```ui\n{"type":"choice","question":"Which logo?","options":[{"label":"A"},{"label":"B"}]}\n```', state: 'final' });
  r.tasks.ingestBlocks(r.chats.message(answer.id)!, [{ type: 'choice', question: 'Which logo?', important: true, options: [{ label: 'A' }, { label: 'B' }] }]);
  const asks = await anna.client.call<TaskView[]>('todos.list');
  assert.equal(asks.length, 1, 'the ask is on Anna\'s For you');
  assert.ok(!(await r.owner.call<TaskView[]>('todos.list')).some((entry) => entry.id === asks[0].id));
  await anna.client.call('tasks.complete', { id: asks[0].id, answer: { choice: 'B' } });
  const receipt = r.chats.messages(chat.id).find((message) => message.kind === 'answer')!;
  assert.equal(receipt.authorId, anna.person.id);
  assert.equal(receipt.authorKind, 'human');
  const sent = r.chats.messages(chat.id).find((message) => message.body.startsWith('@Research'))!;
  const ctx = { services: r.services, agentId: 'ag_research', humanName: 'Mara', zone: undefined, now: 0 };
  assert.equal(authorName(ctx, sent), 'Anna Berg (colleague, Designer)');
  assert.equal(authorName(ctx, { authorId: 'human', authorKind: 'human' }), 'Mara');
});

test('perspective: ids map both ways; tasks read from the person\'s side', () => {
  assert.equal(viewId('per_aaaaaaaaaaaa', 'per_aaaaaaaaaaaa'), 'human');
  assert.equal(viewId('per_aaaaaaaaaaaa', 'human'), 'owner');
  assert.equal(viewId('per_aaaaaaaaaaaa', 'ag_x'), 'ag_x');
  assert.equal(realId('per_aaaaaaaaaaaa', 'human'), 'per_aaaaaaaaaaaa');
  assert.equal(realId('per_aaaaaaaaaaaa', 'owner'), 'human');
  const base = { id: 't', conversationId: 'c', title: 'x', notes: '', status: 'open', priority: 0, ledger: {}, attempts: 0, sort: 0, rev: 0, createdAt: 0, updatedAt: 0, steps: [], progress: { done: 0, total: 0 }, conversationTitle: '', running: false } as const;
  const owners = viewTask('per_aaaaaaaaaaaa', { ...base, assigneeKind: 'human', createdBy: 'per_aaaaaaaaaaaa' } as unknown as TaskView);
  assert.deepEqual([owners.assigneeId, owners.createdBy], ['owner', 'human']);
  const mine = viewTask('per_aaaaaaaaaaaa', { ...base, assigneeKind: 'human', assigneeId: 'per_aaaaaaaaaaaa', createdBy: 'human' } as unknown as TaskView);
  assert.deepEqual([mine.assigneeId, mine.createdBy], [undefined, 'owner']);
});

test('an agent managed by a person knows its manager as a colleague', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg', { title: 'Design lead' });
  r.org.update('ag_research', { managerId: anna.person.id });
  const { identityValues } = await import('../../../src/runtime/context/prompt-stable.ts');
  const values = identityValues(r.services, r.org.get('ag_research')!);
  assert.equal(values.manager_name, `Anna Berg (colleague, ${anna.person.id}) (Design lead)`);
});
