// A call as one value in its chat (src/runtime/calls/call-log.ts) with the real chat service: calls.start opens one quiet
// row per device and chat (and returns it again), every line after it in that chat joins its lines while it is open –
// the person's, every agent's answer once final (also one that arrives by the bus like a synced row), quiet lines only
// with the call's id, a hand-over note of the call – edits and deletions follow, also after the end and only in this PC's
// call rows; the newest CALL_LINES stay; it ends with calls.end (only its device's), the device's connection, or – let go
// at a stop – at the next start, at its last line.
// The RPC: calls.start/calls.end with the connection's device, the connection closing ends the call.
// Owns: these assertions only. Never: audio or a real device.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { CALL_LINES, CALL_LINE_TEXT, callLength, callRecord, type CallRecord } from '../../../src/shared/model/call.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { CallLog } from '../../../src/runtime/calls/call-log.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { createCalls, stopCalls } from '../../../src/runtime/calls/wiring.ts';
import { register as calls } from '../../../src/runtime/rpc/handlers/calls.ts';
import { agent, harness } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture, s1Table } from '../rpc/s1-helpers.ts';

const PC = { key: 'pc', name: 'laptop' };
const PHONE_DEVICE = { key: 'dev_phone', name: 'Pixel' };

function setup() {
  const h = harness();
  h.org.add(agent('ag_jonas', 'Jonas'));
  h.org.add(agent('ag_mia', 'Mia'));
  const chat = h.chats.create({ agentIds: ['ag_jonas', 'ag_mia'], createdBy: HUMAN_ID, lead: 'ag_jonas' });
  Object.assign(h.services, { settings: { get: () => ({ profile: { name: 'Gerd' } }) } });
  const log = new CallLog(() => h.services as RuntimeServices);
  const record = (callId: string): CallRecord => h.chats.messages(chat.id, { limit: 200 }).map((m) => callRecord(m)).find((call) => call?.id === callId)!;
  const say = (body: string, extra: Partial<Parameters<typeof h.chats.send>[0]> = {}) => h.chats.send({ conversationId: chat.id, body, authorId: HUMAN_ID, authorKind: 'human', ...extra });
  const answer = (agentId: string, body: string, extra: Partial<Parameters<typeof h.chats.send>[0]> = {}) => h.chats.send({ conversationId: chat.id, body, authorId: agentId, authorKind: 'agent', ...extra });
  return { ...h, chat, log, record, say, answer };
}

test('calls.start: one quiet row per device and chat, returned again while open; an unknown chat is not found', () => {
  const h = setup();
  const before = h.say('Before the call');
  const id = h.log.start(h.chat.id, PC);
  assert.equal(h.log.start(h.chat.id, PC), id, 'the open one again');
  assert.equal(h.log.start(h.chat.id, PC, undefined, 'call_unknown'), id, 'a call it does not know: the open one');
  assert.notEqual(h.log.start(h.chat.id, PHONE_DEVICE), id, 'another device has its own');
  const row = h.chats.messages(h.chat.id, { limit: 10 }).find((m) => callRecord(m)?.id === id)!;
  assert.deepEqual([row.kind, row.silent, row.body, row.authorKind], ['status', true, 'Call from laptop', 'system']);
  assert.deepEqual(callRecord(row), { id, participant: 'device:pc', name: 'laptop', startedAt: h.clock.now(), lines: [] });
  assert.equal(callRecord(before), undefined);
  assert.throws(() => h.log.start('ch_missing', PC), /Chat not found/);
});

test('lines: the person\'s and every agent\'s final lines after the row, quiet ones only with the call\'s id; edits and deletions follow', () => {
  const h = setup();
  const old = h.say('An older line');
  const id = h.log.start(h.chat.id, PC);
  h.clock.advance(1000);
  const spoken = h.say('Jonas, wie weit bist du?', { speech: { source: 'endpoint', live: true }, meta: { call: { id, participant: 'device:pc', name: 'laptop' } } });
  h.answer('ag_mia', 'Background note', { silent: true }); // quiet, not of the call
  const held = h.say('Held for the talker', { silent: true, meta: { call: { id, participant: 'device:pc', name: 'laptop' } } });
  const streaming = h.chats.beginAgentMessage(h.chat.id, 'ag_jonas', 'run_1', { live: { steps: [], more: 0, startedAt: 1 } });
  assert.equal(h.record(id).lines.length, 2, 'a streaming row is no line yet');
  h.chats.finishAgentMessage(streaming.id, { body: 'Fast fertig.', state: 'final', meta: { model: 'GPT-6' } });
  h.chats.status(h.chat.id, { type: 'note', text: 'Handed over in the call: export', details: { callId: id } }, { authorId: 'ag_jonas' });
  h.chats.status(h.chat.id, { type: 'note', text: 'Some other note' });
  h.chats.edit(old.id, 'An older line, edited', HUMAN_ID); // before the call: no line
  h.chats.edit(spoken.id, 'Jonas, wie weit bist du jetzt?', HUMAN_ID);
  assert.deepEqual(h.record(id).lines.map((line) => [line.from, line.name, line.text, line.messageId === undefined]), [
    ['device:pc', 'Gerd', 'Jonas, wie weit bist du jetzt?', false],
    ['device:pc', 'Gerd', 'Held for the talker', false],
    ['agent:ag_jonas', 'Jonas', 'Fast fertig.', false],
    ['agent:ag_jonas', 'Jonas', 'Handed over in the call: export', false],
  ]);
  assert.equal(h.record(id).lines[0].at, spoken.createdAt);
  h.chats.removeMessage(held.id, HUMAN_ID);
  assert.deepEqual(h.record(id).lines.map((line) => line.text), ['Jonas, wie weit bist du jetzt?', 'Fast fertig.', 'Handed over in the call: export']);
});

test('a row that arrives by the bus like a synced one joins; the newest CALL_LINES stay, each line capped', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  const synced = h.answer('ag_jonas', 'From the home PC');
  h.bus.emit('message.created', synced); // the sync's event for an applied row: no second line
  assert.equal(h.record(id).lines.filter((line) => line.messageId === synced.id).length, 1);
  for (let index = 0; index < CALL_LINES + 5; index++) h.say(`Line ${index}`);
  const lines = h.record(id).lines;
  assert.equal(lines.length, CALL_LINES);
  assert.equal(lines.at(-1)?.text, `Line ${CALL_LINES + 4}`);
  h.say('x'.repeat(CALL_LINE_TEXT + 50));
  assert.equal(h.record(id).lines.at(-1)?.text.length, CALL_LINE_TEXT);
});

test('end: only its device ends it, later answers stay outside; the connection closing ends it', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  h.clock.advance(282_000);
  assert.throws(() => h.log.end(id, PHONE_DEVICE.key), /another device/);
  h.log.end(id, PC.key);
  h.log.end(id, PC.key); // again: nothing to end
  assert.equal(h.record(id).endedAt, h.record(id).startedAt + 282_000);
  assert.equal(callLength(h.record(id).endedAt! - h.record(id).startedAt), '4:42');
  h.answer('ag_jonas', 'Late answer');
  assert.equal(h.record(id).lines.length, 0, 'an answer after the end stays a row of its own');
  assert.notEqual(h.log.start(h.chat.id, PC), id, 'a new call after the end');

  const connection = new AbortController();
  const phone = h.log.start(h.chat.id, PHONE_DEVICE, connection.signal);
  connection.abort();
  assert.ok(h.record(phone).endedAt !== undefined, 'the device left');
});

test('after the end, edits and deletions still follow – in the call rows this PC wrote, never in another PC\'s', () => {
  const h = setup();
  const device = (id: string, name: string, self: boolean): DeviceRecord => ({ id, name, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self });
  new DevicesRepo(h.db).upsert(device('dev_book', 'laptop', true));
  const id = h.log.start(h.chat.id, PC);
  const secret = h.say('my secret thing');
  const kept = h.answer('ag_jonas', 'Noted.');
  h.log.end(id, PC.key);
  assert.equal(h.record(id).pc, 'dev_book', 'the PC that writes it');
  const far: CallRecord = { id: 'call_far', participant: 'device:pc', name: 'office-pc', pc: 'dev_server', startedAt: 1, endedAt: 2, lines: [{ at: 1, from: 'agent:ag_jonas', name: 'Jonas', text: 'Noted.', messageId: kept.id }] };
  const theirs = h.chats.send({ conversationId: h.chat.id, body: 'Call from office-pc', kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text: 'Call from office-pc' }, call: far } });
  h.chats.edit(kept.id, 'Noted, I am on it.', 'ag_jonas');
  h.chats.removeMessage(secret.id, HUMAN_ID);
  assert.deepEqual(h.record(id).lines.map((line) => [line.messageId, line.text]), [[kept.id, 'Noted, I am on it.']], 'the deleted line is gone, the edited one says the new words');
  assert.deepEqual(callRecord(h.chats.message(theirs.id)!)?.lines.map((line) => line.text), ['Noted.'], 'another PC\'s call row is that PC\'s to write');
});

test('a stop lets calls go; the next start ends them at their last line, announced so they travel', () => {
  const h = setup();
  const id = h.log.start(h.chat.id, PC);
  h.clock.advance(5000);
  const line = h.say('Last words');
  h.log.stop();
  h.clock.advance(3_600_000);
  h.say('After the stop');
  assert.equal(h.record(id).endedAt, undefined);
  assert.equal(h.record(id).lines.length, 1, 'nothing joins after the stop');
  const next = new CallLog(() => h.services as RuntimeServices);
  const announced: Message[] = [];
  h.bus.on('message.updated', (message) => announced.push(message));
  assert.equal(next.endLeftOpen(), 1);
  assert.equal(h.record(id).endedAt, line.createdAt);
  assert.ok(announced.some((message) => callRecord(message)?.id === id));
  assert.equal(next.endLeftOpen(), 0, 'once');
});

test('rpc: calls.start and calls.end with the connection\'s device; its connection closing ends its call', async (t) => {
  const table = s1Table();
  calls(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  f.org.add(agent('ag_jonas', 'Jonas'));
  createCalls(f.services as RuntimeServices, { run: async () => ({ text: '', by: 'x' }) });
  t.after(() => stopCalls(f.services));
  const chat = f.chats.create({ agentIds: ['ag_jonas'], createdBy: HUMAN_ID });
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, PHONE);
  const { callId } = await owner.call<{ callId: string }>('calls.start', { conversationId: chat.id });
  assert.equal((await owner.call<{ callId: string }>('calls.start', { conversationId: chat.id })).callId, callId);
  const record = (id: string) => f.chats.messages(chat.id, { limit: 20 }).map((m) => callRecord(m)).find((call) => call?.id === id)!;
  assert.equal(record(callId).participant, 'device:pc');
  await assert.rejects(phone.call('calls.end', { callId }), /another device/);
  const own = await phone.call<{ callId: string }>('calls.start', { conversationId: chat.id });
  assert.equal(record(own.callId).participant, 'device:dev_phone');
  await owner.call('calls.end', { callId });
  assert.ok(record(callId).endedAt !== undefined);
  phone.detach();
  assert.ok(record(own.callId).endedAt !== undefined, 'the phone\'s connection closed');
});
