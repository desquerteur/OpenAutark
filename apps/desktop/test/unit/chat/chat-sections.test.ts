// C1: which chats go where. The shared section rule (main · team · system) for agent-only rooms,
// a human who left or joined by writing, agent-hidden rooms and the app-owned To-do and Customize
// chats (B-054: the old To-do chat is an inert system row; migration 82 backfills its marker – test/unit/db/migration-082);
// the chat service's default list and unread counts; the RPC rules (clients never set 'system'; writing in a hidden room unhides it); and
// the window's snapshot asking for every section in one list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chatSection } from '../../../src/shared/text/chat-sections.ts';
import { loadSnapshots } from '../../../src/ui/lib/load.ts';
import type { LoadCall } from '../../../src/ui/lib/load.ts';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { agent, harness } from './harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

function member(memberId: string, kind: Member['kind'], leftAt?: number): Member {
  const out: Member = { conversationId: 'ch_x', memberId, kind, role: 'member', readSeq: 0, joinedAt: 1 };
  if (leftAt !== undefined) out.leftAt = leftAt;
  return out;
}

/** The pre-B-054 To-do chat as an old profile keeps it: an inert 'todo' system row (nothing creates one any more). */
function legacyTodoChat(chats: ReturnType<typeof harness>['chats']): string {
  const todo = chats.create({ title: 'To-do', agentIds: [], humans: true, createdBy: 'human' });
  chats.update(todo.id, { settings: { hiddenFromList: true, system: 'todo' } }, 'human');
  return todo.id;
}

function chat(members: Member[], settings: ConversationSummary['settings'] = {}): Pick<ConversationSummary, 'settings' | 'members'> {
  return { settings, members };
}

test('chatSection: main, agent-only, human left, human back, agent-hidden, To-do and Customize', () => {
  assert.equal(chatSection(chat([member('human', 'human'), member('ag_a', 'agent')])), 'main');
  assert.equal(chatSection(chat([member('ag_a', 'agent'), member('ag_b', 'agent')])), 'team', 'agent-only room');
  assert.equal(chatSection(chat([member('human', 'human', 5), member('ag_a', 'agent')])), 'team', 'the human left');
  assert.equal(chatSection(chat([member('human', 'human'), member('ag_a', 'agent', 5)])), 'main', 'the human (back) with a left agent');
  assert.equal(chatSection(chat([member('ag_a', 'agent')], { hiddenFromList: true })), 'team', 'hidden by the agent that made it');
  assert.equal(chatSection(chat([member('human', 'human'), member('ag_a', 'agent')], { hiddenFromList: true })), 'team', 'hidden even with the human in it');
  assert.equal(chatSection(chat([member('human', 'human')], { hiddenFromList: true, system: 'todo' })), 'system', 'the To-do chat');
  assert.equal(chatSection(chat([member('human', 'human'), member('ag_m', 'agent')], { hiddenFromList: true, system: 'todo' })), 'system', 'To-do with an agent in it');
  assert.equal(chatSection(chat([member('human', 'human'), member('ag_b', 'agent')], { system: 'customize' })), 'system', 'the Customize chat');
  assert.equal(chatSection(chat([member('ext:tg:1:Ann (Telegram)', 'external'), member('ag_a', 'agent')])), 'team', 'an external person is not the human');
});

test('chat service: the default list holds main chats only; includeHidden adds team rooms and system chats', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  const direct = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const room = h.chats.create({ title: 'Research', agentIds: ['ag_tom', 'ag_lea'], createdBy: 'ag_tom', humans: false });
  const todo = legacyTodoChat(h.chats);

  assert.deepEqual(h.chats.list().map((c) => c.id), [direct.id], 'only the main chat by default');
  const all = h.chats.list({ includeHidden: true });
  const section = (id: string) => chatSection(all.find((c) => c.id === id)!);
  assert.deepEqual([section(direct.id), section(room.id), section(todo)], ['main', 'team', 'system']);
});

test('team rooms never count unread or push; a human leaving and writing again moves the room', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  const room = h.chats.create({ title: 'Launch', agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  h.chats.send({ conversationId: room.id, body: 'Draft ready', authorId: 'ag_tom' });
  assert.equal(h.chats.summary(room.id).unread, 1, 'a main chat counts unread');
  const pushed = h.notified.length;
  assert.ok(pushed >= 1, 'and notifies');

  h.chats.setMembers(room.id, { remove: ['human'] }, 'human');
  assert.equal(chatSection(h.chats.summary(room.id)), 'team', 'the human left: Team activity');
  assert.equal(h.chats.list().some((c) => c.id === room.id), false);
  h.chats.send({ conversationId: room.id, body: 'Second draft', authorId: 'ag_lea' });
  assert.equal(h.chats.summary(room.id).unread, 0, 'no unread in a team room');
  assert.equal(h.notified.length, pushed, 'no push from a team room');

  h.chats.send({ conversationId: room.id, body: 'I am back', authorId: 'human' });
  assert.equal(chatSection(h.chats.summary(room.id)), 'main', 'writing joins it again');
  assert.ok(h.chats.list().some((c) => c.id === room.id));

  const hidden = h.chats.create({ title: 'Side work', agentIds: ['ag_tom'], createdBy: 'ag_tom' });
  h.chats.update(hidden.id, { settings: { hiddenFromList: true } }, 'ag_tom');
  h.chats.send({ conversationId: hidden.id, body: 'Note', authorId: 'ag_tom' });
  assert.equal(h.chats.summary(hidden.id).unread, 0, 'an agent-hidden room with the human in it counts no unread either');

  const found = h.chats.search('Second draft');
  assert.ok(found.some((hit) => hit.message.conversationId === room.id), 'search still finds messages in team rooms');
});

// DeliveryServiceImpl.notifyHuman (runtime/chat/delivery.ts) skips 'team' rooms (T03).
test('an agent-hidden room with the human in it never pushes', () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const hidden = h.chats.create({ title: 'Side work', agentIds: ['ag_tom'], createdBy: 'ag_tom' });
  h.chats.update(hidden.id, { settings: { hiddenFromList: true } }, 'ag_tom');
  assert.equal(chatSection(h.chats.summary(hidden.id)), 'team');
  const pushed = h.notified.length;
  h.chats.send({ conversationId: hidden.id, body: 'Note', authorId: 'ag_tom' });
  assert.equal(h.notified.length, pushed, 'no push from a team room');
});

test('RPC: clients can never set the system marker; writing in an agent-hidden room moves it to the main list', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, PHONE);
  const todo = legacyTodoChat(f.chats);
  const plain = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });

  assert.equal((await owner.request('chats.update', { id: plain.id, settings: { system: 'todo' } })).error?.code, 'bad_request');
  assert.equal((await owner.request('chats.update', { id: todo, settings: { system: null } })).error?.code, 'bad_request');
  await owner.call('chats.update', { id: todo, settings: { hiddenFromList: false } });
  assert.equal(f.chats.get(todo)?.settings.system, 'todo', 'other setting changes keep the marker');
  assert.equal(chatSection(f.chats.summary(todo)), 'system');

  const room = f.chats.create({ title: 'Research', agentIds: ['ag_ava'], createdBy: 'ag_ava', humans: false });
  f.chats.update(room.id, { settings: { hiddenFromList: true } }, 'ag_ava');
  const listed = await phone.call<ConversationSummary[]>('chats.list', { includeHidden: true });
  assert.ok(listed.some((c) => c.id === room.id), 'a device gets the same list');
  assert.equal((await phone.call<ConversationSummary[]>('chats.list')).some((c) => c.id === room.id), false);

  await phone.call('messages.send', { conversationId: room.id, body: 'Let me follow this' });
  assert.equal(f.chats.get(room.id)?.settings.hiddenFromList, undefined, 'unhidden by writing');
  assert.equal(chatSection(f.chats.summary(room.id)), 'main');
  await owner.call('messages.send', { conversationId: todo, body: 'Note to self' });
  assert.equal(chatSection(f.chats.summary(todo)), 'system', 'writing never moves a system chat');
});

test('the window snapshot loads chats with includeHidden, so team rooms survive a reload', async () => {
  const asked: Array<{ method: string; params: unknown }> = [];
  const room = { id: 'ch_room', title: 'Research', members: [member('ag_a', 'agent')], settings: {}, createdAt: 1, unread: 0, working: [] };
  const todo = { id: 'ch_todo', title: 'To-do', members: [member('human', 'human')], settings: { hiddenFromList: true, system: 'todo' }, createdAt: 1, unread: 0, working: [] };
  const answers: Record<string, (params: unknown) => unknown> = {
    'settings.get': () => ({}), 'agents.list': () => [], 'agents.activity': () => [], 'todos.list': () => [], 'tasks.list': () => [],
    'ui.state': () => ({ drafts: {} }),
    'chats.list': (params) => ((params as { includeHidden?: boolean } | undefined)?.includeHidden ? [room, todo] : []),
  };
  const call = (async (method: string, params?: unknown) => { asked.push({ method, params }); return answers[method](params); }) as unknown as LoadCall;
  const snapshot = await loadSnapshots({ call, optional: () => false });
  assert.deepEqual(asked.find((entry) => entry.method === 'chats.list')?.params, { includeHidden: true });
  assert.deepEqual(snapshot.chats.map((c) => [c.id, chatSection(c)]), [['ch_room', 'team'], ['ch_todo', 'system']]);
});
