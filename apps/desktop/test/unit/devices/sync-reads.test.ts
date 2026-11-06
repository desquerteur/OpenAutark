// B-078 read cursors between my own PCs (devices/sync/tables.ts conversations, chat/conversation-repo.ts syncMembers /
// takeRead): the owner's cursor travels as the id of the last message read, lands on that message's own seq on the
// other PC (seqs are per PC), never moves back, and waits for a message that is not there yet (same batch: chats go
// before messages). A person's cursor stays per PC, and the owner's never reaches an employee's PC.
// Owns: these assertions only. Never: a real mesh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { link, makePc, Net, settle } from './sync-net.ts';

const LENA = 'per_lena000001';
const ownerRead = (pc: ReturnType<typeof makePc>, chat: string) => pc.h.chats.members(chat).find((member) => member.memberId === 'human')!.readSeq;

test('a read on one of my PCs moves the owner\'s cursor on the other onto the same message, at its own seq there', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  await settle();
  net.up = false;
  b.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'only on B' }); // B's seqs run ahead of A's
  await settle();
  net.up = true;
  const first = a.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'One' });
  const second = a.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Two' });
  await settle();
  const seqOnB = (id: string) => b.h.chats.messages(chat.id).find((message) => message.id === id)!.seq;
  assert.ok(ownerRead(b, chat.id) < seqOnB(second.id), 'unread on B');

  a.h.chats.markRead(chat.id, 'human', a.h.chats.messages(chat.id).find((message) => message.id === first.id)!.seq);
  await settle();
  assert.equal(ownerRead(b, chat.id), seqOnB(first.id), 'B reads up to the same message');
  a.h.chats.markRead(chat.id, 'human', a.h.chats.messages(chat.id).find((message) => message.id === second.id)!.seq);
  await settle();
  assert.equal(ownerRead(b, chat.id), seqOnB(second.id), 'and to the end: the badge is gone on B too');
  assert.equal(b.h.chats.summary(chat.id).unread, 0);
  const calls = net.calls.length;
  await settle();
  assert.equal(net.calls.length, calls, 'nothing echoes');
});

test('a cursor naming a message that comes in the same batch waits for it, and a cursor never moves back', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  await settle();
  const line = a.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Read at once' });
  a.h.chats.markRead(chat.id, 'human', line.seq); // the chat row (with read_id) and the message go in one batch
  await settle();
  assert.equal(ownerRead(b, chat.id), b.h.chats.message(line.id)!.seq, 'applied once the message arrived');

  const later = b.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Later on B' });
  b.h.chats.markRead(chat.id, 'human', later.seq);
  const row = (read_id: string, at: number) => {
    const { last_seq: _seq, last_message_at: _at, ...conversation } = a.h.db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [chat.id])!;
    const member = a.h.db.get<Record<string, unknown>>('SELECT member_id, kind, role, joined_at, left_at FROM members WHERE conversation_id = ? AND member_id = ?', [chat.id, 'human']);
    return { t: 'conversations', id: chat.id, at, row: { ...conversation, members: [{ ...member, read_id }] } };
  };
  await b.sync.receive({ items: [row(line.id, 9e12)] }, 'dev_a');
  assert.equal(ownerRead(b, chat.id), later.seq, 'an older cursor never moves it back');
  await b.sync.receive({ items: [row('msg_missing', 9e12 + 1)] }, 'dev_a');
  assert.equal(ownerRead(b, chat.id), later.seq, 'an unknown message changes nothing (it waits)');
});

test('a read is no edit of the chat: a later read on one PC never undoes a rename made on the other', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human', title: 'Old name' });
  const line = a.h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Hello' });
  await settle();
  net.up = false;
  b.h.clock.advance(1_000);
  b.h.chats.update(chat.id, { title: 'New name' }, 'human'); // B's rename does not reach A yet
  await settle();
  net.up = true;
  a.h.clock.advance(60_000); // A's clock runs later than B's rename
  a.h.chats.markRead(chat.id, 'human', line.seq);
  await settle();
  assert.equal(b.h.chats.get(chat.id)?.title, 'New name', 'the read did not win over the rename');
  assert.equal(ownerRead(b, chat.id), b.h.chats.message(line.id)!.seq, 'and the read arrived on B all the same');
  assert.equal(a.h.chats.get(chat.id)?.title, 'New name', 'B passes its newer row back, so A has the rename too');
});

test('the owner\'s cursor never reaches an employee\'s PC, and a person\'s line does not send the chat back', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const e = makePc(net, 'dev_e');
  link(a, e, LENA);
  a.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  const chat = a.h.chats.create({ agentIds: [], people: [LENA], createdBy: 'human', title: 'With Lena' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Hi Lena' });
  await settle();
  const toE = net.calls.filter((call) => call.to === 'dev_e').flatMap((call) => (call.params as { items?: Array<{ t: string; row?: { members?: Array<Record<string, unknown>> } }> }).items ?? []);
  const members = toE.filter((item) => item.t === 'conversations').flatMap((item) => item.row?.members ?? []);
  assert.ok(members.length > 0);
  assert.ok(members.every((member) => !('read_id' in member)), 'no read cursor on the employee link');
});
