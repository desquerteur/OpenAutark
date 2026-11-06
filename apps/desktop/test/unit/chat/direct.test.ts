// B-050 K1: the default 1:1 per pair (runtime/chat/direct.ts) – found when marked (archived too), adopted
// from an older chat of exactly the two that names no topic, else created for any kinds (owner, person,
// agent; two agents without a human); the mark stays with its pair while both are members and ends when
// one leaves; B-078 D7: nobody joins it. Also chats.direct over RPC (opening an archived one brings it back).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { findDirect, findOrCreateDirect, isDirect } from '../../../src/runtime/chat/direct.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';

const ANNA = 'per_anna000000';
const BEN = 'per_ben0000000';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  for (const [id, name] of [[ANNA, 'Anna Berg'], [BEN, 'Ben Ott']]) {
    h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', 0, 0)`, [id, name]);
  }
  return h;
}

const memberIds = (h: ReturnType<typeof harness>, id: string) => h.chats.members(id).map((m) => m.memberId).sort();

test('owner and agent: created once, untitled and marked; found again in either order', () => {
  const h = setup();
  const id = findOrCreateDirect(h.services, 'human', 'ag_tom');
  const chat = h.chats.get(id)!;
  assert.equal(isDirect(chat), true);
  assert.equal(chat.title, '');
  assert.equal(chat.titleNamed, false);
  assert.deepEqual(h.chats.members(id).map((m) => [m.memberId, m.role]), [['human', 'owner'], ['ag_tom', 'lead']]);
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_tom'), id);
  assert.equal(findOrCreateDirect(h.services, 'ag_tom', 'human'), id);
  assert.equal(findDirect(h.services, 'ag_tom', 'human'), id);
  assert.equal(h.chats.list({ includeHidden: true }).length, 1);
});

test('two agents without a human, owner and person, person and agent, two people', () => {
  const h = setup();
  const agents = findOrCreateDirect(h.services, 'ag_tom', 'ag_lea');
  assert.deepEqual(memberIds(h, agents), ['ag_lea', 'ag_tom']);
  assert.equal(h.chats.get(agents)!.createdBy, 'ag_tom');
  const ownerAnna = findOrCreateDirect(h.services, 'human', ANNA);
  assert.deepEqual(memberIds(h, ownerAnna), ['human', ANNA].sort());
  const annaTom = findOrCreateDirect(h.services, ANNA, 'ag_tom', { createdBy: 'system' });
  assert.deepEqual(memberIds(h, annaTom), ['ag_tom', ANNA].sort());
  assert.equal(h.chats.get(annaTom)!.createdBy, 'system');
  const people = findOrCreateDirect(h.services, ANNA, BEN);
  assert.deepEqual(memberIds(h, people), [ANNA, BEN]);
  for (const id of [agents, ownerAnna, annaTom, people]) {
    assert.equal(isDirect(h.chats.get(id)!), true, id);
    assert.equal(h.chats.get(id)!.title, '', id);
  }
  assert.equal(new Set([agents, ownerAnna, annaTom, people]).size, 4);
});

test('adopts the newest unnamed chat of exactly the two and marks it', () => {
  const h = setup();
  const older = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.clock.advance(1000);
  const newer = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.send({ conversationId: newer.id, body: 'Can you check the invoice?', authorId: 'human', authorKind: 'human' });
  assert.equal(findDirect(h.services, 'human', 'ag_tom'), undefined);
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_tom'), newer.id);
  assert.equal(isDirect(h.chats.get(newer.id)!), true);
  assert.equal(h.chats.get(newer.id)!.title, 'Can you check the invoice?', 'adopting never renames');
  assert.equal(isDirect(h.chats.get(older.id)!), false);
  h.clock.advance(1000);
  h.chats.send({ conversationId: older.id, body: 'later', authorId: 'human', authorKind: 'human' });
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_tom'), newer.id, 'the marked chat wins over a busier unmarked one');
});

test('never adopts a chat named after a topic, a hidden, app-owned, archived or three-member chat', () => {
  const h = setup();
  const named = h.chats.create({ title: 'Video editing', agentIds: ['ag_tom'], createdBy: 'human' });
  const hidden = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', settings: { hiddenFromList: true } });
  const system = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', settings: { system: 'inbox' } });
  const archived = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.chats.archive(archived.id);
  const group = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  const left = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: 'human' });
  h.chats.setMembers(left.id, { remove: ['ag_lea'] }, 'human'); // a pair again now, unnamed: adoptable
  const others = [named, hidden, system, archived, group];
  const id = findOrCreateDirect(h.services, 'human', 'ag_tom');
  assert.equal(id, left.id);
  for (const chat of others) assert.equal(isDirect(h.chats.get(chat.id)!), false, chat.id);
  const chats = h.chats.list({ includeHidden: true }).length;
  h.chats.archive(left.id);
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_tom'), left.id, 'archiving only hides the default 1:1: it stays the pair\'s one');
  assert.equal(h.chats.get(left.id)!.archivedAt !== undefined, true, 'finding it never unarchives it');
  assert.equal(h.chats.list({ includeHidden: true }).length, chats, 'no second default 1:1');
});

test('refuses the same id twice, an unknown agent and a person who is not active', () => {
  const h = setup();
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES ('per_gone000000', 'Gone', 'revoked', 0, 0)`);
  assert.throws(() => findOrCreateDirect(h.services, 'human', 'human'), /someone else/);
  assert.throws(() => findOrCreateDirect(h.services, 'human', 'ag_nobody'), /Agent not found/);
  assert.throws(() => findOrCreateDirect(h.services, 'human', 'per_gone000000'), /not in the organisation/);
  assert.throws(() => findOrCreateDirect(h.services, 'human', 'per_unknown0000'), /not in the organisation/);
  assert.throws(() => findOrCreateDirect({ db: h.db, chats: h.chats }, 'human', 'ag_tom'), /Agent not found/, 'no agent without the org service');
  assert.equal(h.chats.list({ includeHidden: true }).length, 0);
});

test('the mark stays with its pair – B-078 D7: nobody joins, not even by posting – and ends when one of them leaves', () => {
  const h = setup();
  const pair = findOrCreateDirect(h.services, 'human', 'ag_tom');
  assert.deepEqual(h.chats.get(pair)!.settings.directPair, ['ag_tom', 'human']);
  assert.throws(() => h.chats.setMembers(pair, { add: ['ag_lea'] }, 'human'), /A 1:1 stays two. For more people, start a group with them./);
  assert.deepEqual(memberIds(h, pair), ['ag_tom', 'human']);
  assert.equal(isDirect(h.chats.get(pair)!), true);
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_tom'), pair, 'no second default 1:1 for the pair');
  assert.notEqual(findOrCreateDirect(h.services, 'human', 'ag_lea'), pair, 'never the default of anyone else');

  const agents = findOrCreateDirect(h.services, 'ag_tom', 'ag_lea');
  h.chats.send({ conversationId: agents, body: 'Hello you two', authorId: 'human', authorKind: 'human' });
  assert.deepEqual(memberIds(h, agents), ['ag_lea', 'ag_tom'], 'the owner posts there without joining');
  assert.equal(findDirect(h.services, 'ag_lea', 'ag_tom'), agents, 'still the agents\' default 1:1');

  const anna = findOrCreateDirect(h.services, 'human', ANNA);
  h.chats.setMembers(anna, { remove: [ANNA] }, 'human');
  assert.equal(isDirect(h.chats.get(anna)!), false);
  assert.equal(h.chats.get(anna)!.settings.directPair, undefined);
});

test('chats.direct: the owner\'s default 1:1 as a summary, for the owner and chat devices', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  f.org.add(agent('ag_tom', 'Tom'));
  const owner = new TestClient(f.server, OWNER);
  const summary = await owner.call<ConversationSummary>('chats.direct', { memberId: 'ag_tom' });
  assert.equal(summary.settings.direct, true);
  assert.deepEqual(summary.members.map((m) => m.memberId).sort(), ['ag_tom', 'human']);
  const phone = new TestClient(f.server, PHONE);
  assert.equal((await phone.call<ConversationSummary>('chats.direct', { memberId: 'ag_tom' })).id, summary.id);
  f.chats.archive(summary.id);
  const reopened = await owner.call<ConversationSummary>('chats.direct', { memberId: 'ag_tom' });
  assert.equal(reopened.id, summary.id, 'an archived default 1:1 is opened, not made again');
  assert.equal(reopened.archivedAt, undefined, '"Message" brings it back into the list');
  assert.equal((await owner.request('chats.direct', { memberId: 'human' })).error?.code, 'bad_request');
  assert.equal((await owner.request('chats.direct', { memberId: 'ag_tom', title: 'x' })).error?.code, 'bad_request');
  assert.equal((await owner.request('chats.direct', { memberId: 'ag_nobody' })).error?.code, 'not_found');
  assert.equal((await phone.request('chats.export', { conversationIds: [summary.id] })).error?.code, 'forbidden'); // track F built it: owner only
});
