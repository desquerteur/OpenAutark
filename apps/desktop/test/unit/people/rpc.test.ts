// F-52 people over RPC: a person sees only their chats (from their join on unless the chat shares
// its history), posts as themselves, starts chats without the CEO, receives only the events of
// their chats and tasks from their perspective ('human' = them, the CEO = 'owner'); the owner sees
// every chat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleRig, settle } from './rig.ts';
import { TestClient } from '../rpc/s1-helpers.ts';
import type { ConversationSummary, Message } from '../../../src/shared/model/chat.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

test('a person reads and writes only their own chats, from their join on', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const shared = r.chats.create({ agentIds: ['ag_research'], createdBy: 'human', title: 'Launch' });
  r.chats.send({ conversationId: shared.id, body: 'before Anna joined', authorId: 'human', authorKind: 'human' });
  const other = r.chats.create({ agentIds: ['ag_research'], createdBy: 'human', title: 'Owner only' });
  r.clock.advance(1000);
  r.chats.setMembers(shared.id, { add: [anna.person.id] }, 'human');
  r.clock.advance(1000);
  r.chats.send({ conversationId: shared.id, body: 'welcome', authorId: 'human', authorKind: 'human' });

  const list = await anna.client.call<ConversationSummary[]>('chats.list');
  assert.deepEqual(list.map((chat) => chat.title), ['Launch']);
  assert.equal(list[0].draft, undefined);
  assert.ok(list[0].members.some((member) => member.memberId === 'human' && member.kind === 'human'), 'Anna is "human" in her view');
  assert.ok(list[0].members.some((member) => member.memberId === 'owner'), 'the CEO is "owner" in her view');
  await assert.rejects(anna.client.call('chats.get', { id: other.id }), /not found/);
  await assert.rejects(anna.client.call('messages.list', { conversationId: other.id }), /not found/);
  await assert.rejects(anna.client.call('messages.send', { conversationId: other.id, body: 'hi' }), /not found/);

  const seen = await anna.client.call<Message[]>('messages.list', { conversationId: shared.id });
  assert.ok(!seen.some((message) => message.body === 'before Anna joined'), 'history from her join on');
  assert.ok(seen.some((message) => message.body === 'welcome' && message.authorId === 'owner'));
  r.chats.update(shared.id, { settings: { history: 'full' } }, 'human');
  const full = await anna.client.call<Message[]>('messages.list', { conversationId: shared.id });
  assert.ok(full.some((message) => message.body === 'before Anna joined'), 'the chat shares its whole history');

  const sent = await anna.client.call<Message>('messages.send', { conversationId: shared.id, body: 'Thanks! @Research please start', mentions: ['ag_research'] });
  assert.equal(sent.authorId, 'human', 'her own message reads as hers');
  const stored = r.chats.message(sent.id)!;
  assert.equal(stored.authorId, anna.person.id);
  assert.equal(stored.authorKind, 'human');
  assert.deepEqual(stored.mentions, ['ag_research']);
  // The agent is woken like for any human message (the chat's delivery).
  assert.ok(r.wakeRows().some((row) => row.agent_id === 'ag_research' && row.conversation_id === shared.id));
});

test('people start a chat without the CEO; the owner still sees it', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const ben = await r.join('Ben Vogt');
  const chat = await anna.client.call<{ id: string }>('chats.create', { title: 'Side project', agentIds: ['ag_research'], people: [ben.person.id], firstMessage: 'secret plan' });
  await settle();
  const members = r.chats.members(chat.id).map((member) => member.memberId).sort();
  assert.deepEqual(members, ['ag_research', anna.person.id, ben.person.id].sort(), 'no CEO in it');
  const ownerList = await r.owner.call<ConversationSummary[]>('chats.list', { includeHidden: true });
  assert.ok(ownerList.some((entry) => entry.id === chat.id), 'the owner sees every chat');
  const benList = await ben.client.call<ConversationSummary[]>('chats.list');
  assert.ok(benList.some((entry) => entry.id === chat.id), 'Ben sees it');
  // The admin also gets it as metadata.
  const meta = await r.owner.call<Array<{ id: string; title: string; members: string[]; withOwner: boolean }>>('people.chats', { id: anna.person.id });
  assert.deepEqual(meta.find((entry) => entry.id === chat.id), { id: chat.id, title: 'Side project', members: meta.find((entry) => entry.id === chat.id)!.members, withOwner: false });
  // Only its starter changes its members; anyone may leave.
  await assert.rejects(ben.client.call('chats.members', { id: chat.id, add: ['ag_manager'] }), /Only the one who started/);
  await ben.client.call('chats.members', { id: chat.id, remove: ['human'] });
  assert.ok(!r.chats.members(chat.id).some((member) => member.memberId === ben.person.id), 'Ben left');
  await assert.rejects(ben.client.call('messages.list', { conversationId: chat.id }), /not found/);
});

test('scopes: spaces limit the agents a person works with; start chats can be off', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const cara = await r.join('Cara', { scopes: { spaces: ['sp_company'], startChats: true, assignAgents: true } });
  await assert.rejects(cara.client.call('chats.create', { agentIds: ['ag_secret'] }), /may not work with this agent/);
  await assert.rejects(cara.client.call('chats.create', { agentIds: ['ag_manager'] }), /may not work with this agent/, 'a space-less agent needs every space');
  const ok = await cara.client.call<{ id: string }>('chats.create', { agentIds: ['ag_research'] });
  assert.ok(ok.id);
  const spaces = await cara.client.call<Array<{ id: string }>>('spaces.list');
  assert.deepEqual(spaces.map((space) => space.id), ['sp_company']);
  const before = await cara.client.call<{ allowedMethods: string[] }>('session.info');
  assert.ok(before.allowedMethods.includes('chats.create'), 'may start chats: her app offers "+ Chat"');
  await r.owner.call('people.save', { id: cara.person.id, scopes: { spaces: ['sp_company'], startChats: false, assignAgents: true } });
  await settle();
  assert.equal(cara.client.raw.closed, true, 'her open app reconnects at once with the new rights (rpc/server.ts)');
  const again = new TestClient(r.server, { ...cara.scope, secure: true });
  await assert.rejects(again.call('chats.create', { agentIds: ['ag_research'] }), /may not start chats/);
  const after = await again.call<{ allowedMethods: string[] }>('session.info');
  assert.ok(!after.allowedMethods.includes('chats.create'), 'without the right her app offers no "+ Chat" (lib/session.ts can)');
  assert.ok(after.allowedMethods.includes('chats.members') && after.allowedMethods.includes('messages.send'), 'the chats she is added to still work');
  const agents = await again.call<Agent[]>('agents.list');
  const research = agents.find((agent) => agent.id === 'ag_research')!;
  assert.equal(research.instructions, '', 'no agent setup for people');
  assert.equal(research.managerId, 'ag_manager');
});

test('events: a person hears only their chats and tasks, seen from their side', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const mine = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Mine' });
  const notMine = r.chats.create({ agentIds: ['ag_research'], createdBy: 'human', title: 'Not mine' });
  await anna.client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system', `chat:${mine.id}`, `chat:${notMine.id}`] });
  r.chats.send({ conversationId: mine.id, body: 'hello Anna', authorId: 'human', authorKind: 'human' });
  r.chats.send({ conversationId: notMine.id, body: 'not for Anna', authorId: 'human', authorKind: 'human' });
  r.tasks.create({ conversationId: notMine.id, title: 'Hidden task', createdBy: 'human' });
  r.tasks.create({ conversationId: mine.id, title: 'For Anna', assigneeKind: 'human', assigneeId: anna.person.id, createdBy: 'human' });
  r.services.settings.update({ profile: { name: 'Mara' } });
  await settle();
  const created = anna.client.events('message.created').map((event) => event.data as Message);
  assert.ok(created.some((message) => message.body === 'hello Anna' && message.authorId === 'owner'));
  assert.ok(!created.some((message) => message.body === 'not for Anna'));
  const rows = anna.client.events('conversation.upserted').map((event) => (event.data as ConversationSummary).id);
  assert.ok(rows.every((id) => id === mine.id), 'list rows of her chats only');
  const tasks = anna.client.events('task.upserted').map((event) => event.data as { title: string; assigneeId?: string });
  assert.ok(!tasks.some((task) => task.title === 'Hidden task'));
  const forAnna = tasks.find((task) => task.title === 'For Anna');
  assert.ok(forAnna && forAnna.assigneeId === undefined, 'her own to-do reads as hers');
  assert.equal(anna.client.events('settings.updated').length, 0, 'nothing of the owner\'s system topic');
});

test('a person edits and deletes only their own messages', async (t) => {
  const r = peopleRig();
  t.after(() => r.cleanup());
  const anna = await r.join('Anna Berg');
  const chat = r.chats.create({ agentIds: ['ag_research'], people: [anna.person.id], createdBy: 'human', title: 'Edits' });
  const mine = await anna.client.call<Message>('messages.send', { conversationId: chat.id, body: 'first try' });
  const owners = r.chats.send({ conversationId: chat.id, body: 'the owner wrote this', authorId: 'human', authorKind: 'human' });
  const edited = await anna.client.call<Message>('messages.edit', { id: mine.id, body: 'second try' });
  assert.equal(edited.body, 'second try');
  await assert.rejects(anna.client.call('messages.edit', { id: owners.id, body: 'hijack' }), /Only your own/);
  await assert.rejects(anna.client.call('messages.delete', { id: owners.id }), /Only your own/);
  await anna.client.call('messages.delete', { id: mine.id });
  assert.equal(r.chats.message(mine.id), undefined);
});
