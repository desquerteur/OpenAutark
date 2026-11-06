// B-050 K1 – the old "the 1:1 of A and B" finders now go through chat/direct.ts findOrCreateDirect:
// people/direct-chat.ts directChat (humans only, as before) and agentDirectChat (the system starts it),
// the owner's 1:1 with an agent (findOrCreateDirect – B-054 removed tasks/center/relocate.ts, its old caller), and shared/text/manager-chat.ts
// managerFirstChat prefers the owner's default 1:1 with the Manager.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { findOrCreateDirect, isDirect } from '../../../src/runtime/chat/direct.ts';
import { agentDirectChat, directChat } from '../../../src/runtime/people/direct-chat.ts';
import { managerFirstChat } from '../../../src/shared/text/manager-chat.ts';

const ANNA = 'per_anna000000';
/** The owner's default 1:1 with the agent (found, adopted or made). */
const ownersDirectChat = (s: ReturnType<typeof harness>['services'], agentId: string) => findOrCreateDirect(s, 'human', agentId, { createdBy: 'human' });

function setup() {
  const h = harness();
  h.org.add(agent('ag_boss', 'Mara', { mode: 'manager' }));
  h.org.add(agent('ag_tom', 'Tom'));
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', 0, 0)`, [ANNA]);
  return h;
}

test('people directChat: the default 1:1 of two humans – found again, an older unnamed one adopted; never an agent', () => {
  const h = setup();
  const older = h.chats.create({ agentIds: [], people: [ANNA], createdBy: 'human' });
  const id = directChat(h.services, 'human', ANNA);
  assert.equal(id, older.id, 'the older unnamed chat of the two is adopted');
  assert.equal(isDirect(h.chats.get(id)!), true);
  assert.equal(directChat(h.services, ANNA, 'human'), id, 'either way round');
  assert.throws(() => directChat(h.services, 'human', 'ag_tom'), /not in the organisation/);
  assert.throws(() => directChat(h.services, 'human', 'human'), /someone else/);
});

test('agentDirectChat: the person\'s default 1:1 with the agent, started by the system, untitled', () => {
  const h = setup();
  const id = agentDirectChat(h.services, ANNA, 'ag_tom');
  const chat = h.chats.get(id)!;
  assert.deepEqual([chat.createdBy, chat.title, isDirect(chat)], ['system', '', true]);
  assert.deepEqual(h.chats.members(id).map((m) => m.memberId).sort(), ['ag_tom', ANNA].sort());
  assert.equal(agentDirectChat(h.services, ANNA, 'ag_tom'), id);
});

test('the owner directChat: the owner\'s default 1:1 with the agent; a named chat of the two is not taken', () => {
  const h = setup();
  const named = h.chats.create({ title: 'Video plans', agentIds: ['ag_tom'], createdBy: 'human' });
  const id = ownersDirectChat(h.services, 'ag_tom');
  assert.notEqual(id, named.id);
  assert.equal(isDirect(h.chats.get(id)!), true);
  assert.equal(ownersDirectChat(h.services, 'ag_tom'), id);
});

test('managerFirstChat prefers the owner\'s default 1:1 with the Manager over an older chat', () => {
  const h = setup();
  const older = h.chats.create({ title: 'Setup', agentIds: ['ag_boss'], createdBy: 'human' }); // a topic: never adopted (one named "Mara" would be, direct-pair.test.ts)
  assert.equal(managerFirstChat(h.chats.list(), 'ag_boss')?.id, older.id, 'without a default 1:1: the oldest, as before');
  h.clock.advance(1000);
  const direct = ownersDirectChat(h.services, 'ag_boss');
  assert.equal(managerFirstChat(h.chats.list(), 'ag_boss')?.id, direct);
  const annas = agentDirectChat(h.services, ANNA, 'ag_boss');
  assert.notEqual(managerFirstChat(h.chats.list({ includeHidden: true }), 'ag_boss')?.id, annas, 'a person\'s 1:1 with the Manager is not the owner\'s');
});
