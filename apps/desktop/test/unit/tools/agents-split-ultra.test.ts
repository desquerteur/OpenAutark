// B-057 S17 as the owner set it on 30.10.2026 ("man kann das noch angeben unter einer Chat-Nachricht … dass der Ultra-Modus
// vielleicht interessant wäre dafür"): Ultra is suggested on one message – messages.send `ultra: true` stores meta.ultra on
// that message (owner, a phone with the chat tier, a person of the organisation), anything but a boolean is refused, a
// message without it carries nothing; the chat has no Ultra setting any more (chats.update refuses settings.ultra); the
// group an agent splits after such a message records it; no agent tool takes an `ultra` argument (an agent never suggests
// Ultra to itself – whether to split is its own call anyway).
// Owns: these assertions only. Never: real engines, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Schedule } from '../../../src/shared/model/tasks.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { scheduledPost } from '../../../src/runtime/schedules/post.ts';
import { fireSchedule } from '../../../src/runtime/schedules/fire.ts';
import '../../../src/shared/model/splits.ts'; // MessageMeta.ultra
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_ultra', capabilities: ['todo', 'chat'], secure: true };

test('Ultra is suggested per message: messages.send ultra → meta.ultra on that message only; anything but a boolean is refused', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const owner = new TestClient(f.server, OWNER);
  const suggested = await owner.call<Message>('messages.send', { conversationId: chat.id, body: 'Review the six documents.', ultra: true });
  assert.equal(f.chats.message(suggested.id)?.meta.ultra, true);
  const plain = await owner.call<Message>('messages.send', { conversationId: chat.id, body: 'Thanks.' });
  assert.equal(f.chats.message(plain.id)?.meta.ultra, undefined, 'the next message carries nothing');
  const off = await owner.call<Message>('messages.send', { conversationId: chat.id, body: 'And this one?', ultra: false });
  assert.equal(f.chats.message(off.id)?.meta.ultra, undefined, 'ultra: false stores nothing');
  for (const value of ['yes', 1, {}]) {
    const refused = await owner.request('messages.send', { conversationId: chat.id, body: 'x', ultra: value });
    assert.equal(refused.error?.code, 'bad_request', JSON.stringify(value));
  }
  const phone = new TestClient(f.server, PHONE);
  const fromPhone = await phone.call<Message>('messages.send', { conversationId: chat.id, body: 'From the phone.', ultra: true });
  assert.equal(f.chats.message(fromPhone.id)?.meta.ultra, true, 'the composer cell works from a phone with the chat tier');
});

test('the chat has no Ultra setting any more', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const owner = new TestClient(f.server, OWNER);
  const refused = await owner.request('chats.update', { id: chat.id, settings: { ultra: true } });
  assert.equal(refused.error?.code, 'bad_request');
});

test('a scheduled message keeps its Ultra suggestion: stored with the post, set on the message when it fires', async (t) => {
  const f = rpcFixture({ table: createHandlerTable() });
  t.after(f.cleanup);
  const post = scheduledPost('Review the six documents', { ultra: true });
  assert.equal(post.payload.ultra, true);
  assert.equal(scheduledPost('Review the six documents', { ultra: true, asTask: true }).payload.ultra, undefined, 'a task post carries no message hint');
  assert.equal(scheduledPost('Plain').payload.ultra, undefined);
  const sent: Array<{ meta?: Record<string, unknown>; authorKind: string }> = [];
  const chats = { get: () => ({ id: 'ch_1' }), send: (input: { meta?: Record<string, unknown>; authorKind: string }) => { sent.push(input); return input; } };
  const schedule = { id: 'sch_1', kind: 'message', ownerId: HUMAN_ID, conversationId: 'ch_1', title: post.title, payload: post.payload } as unknown as Schedule;
  fireSchedule(schedule, 1, { chats } as never);
  assert.equal(sent[0].meta?.ultra, true);
  fireSchedule({ ...schedule, ownerId: 'ag_ava' } as Schedule, 2, { chats } as never);
  assert.equal(sent[1].meta?.ultra, undefined, 'only a person\'s post suggests Ultra');
  f.org.add(agent('ag_ava', 'Ava'));
  const chat = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const owner = new TestClient(f.server, OWNER);
  const stored = await owner.call<Schedule>('messages.schedule', { conversationId: chat.id, body: 'Compare the drafts', spec: { at: Date.now() + 3_600_000 }, ultra: true });
  assert.equal(stored.payload.ultra, true, 'messages.schedule takes it');
});

test('no agent tool takes an ultra argument', () => {
  for (const tool of builtinTools()) assert.ok(!JSON.stringify(tool.inputSchema).includes('"ultra"'), tool.name);
});
