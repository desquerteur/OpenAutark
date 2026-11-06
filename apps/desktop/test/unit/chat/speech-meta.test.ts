// Spoken messages: messages.send `speech` is validated (chat/speech-meta.ts – source, live) into meta.via 'voice' +
// meta.speech; agents cannot attach speech; the context shows a spoken line like a typed one, a call line with its
// note; a phone's RPC send works the same way.
// Owns: these assertions only. Never: real timers, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { speechMeta, withSpeech } from '../../../src/runtime/chat/speech-meta.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { fixture } from '../context/fixture.ts';
import { PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import type { Conversation, Message } from '../../../src/shared/model/chat.ts';

const BODY = 'Send the offer to Teydra by fifteen hundred';

function badRequest(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && (error.details as { param?: string })?.param === 'speech');
}

test('speechMeta: a known source and `live`; nothing else is kept', () => {
  assert.equal(speechMeta(undefined), undefined);
  assert.equal(speechMeta(null), undefined);
  assert.deepEqual(speechMeta({ source: 'endpoint', unsure: [{ text: 'x' }], confidence: 0.5, heard: 'y' }), { source: 'endpoint' });
  assert.deepEqual(speechMeta({ source: 'endpoint', live: true }), { source: 'endpoint', live: true });
  assert.deepEqual(speechMeta({ source: 'windows', live: 'yes' }), { source: 'windows' }, 'an older client');
  badRequest(() => speechMeta('spoken'));
  badRequest(() => speechMeta({ source: 'browser' }));
  badRequest(() => speechMeta([]));
  assert.deepEqual(withSpeech({ model: 'x' }, undefined), { model: 'x' });
  assert.deepEqual(withSpeech({}, { source: 'endpoint' }), { via: 'voice', speech: { source: 'endpoint' } });
});

test('ChatService.send: human speech becomes meta.via voice + meta.speech; agents cannot attach speech', () => {
  const h = harness();
  const tom = h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: [tom.id], createdBy: HUMAN_ID });
  const spoken = h.chats.send({ conversationId: chat.id, body: BODY, authorId: HUMAN_ID, speech: { source: 'endpoint' } });
  assert.equal(spoken.meta.via, 'voice');
  assert.deepEqual(spoken.meta.speech, { source: 'endpoint' });
  assert.deepEqual(h.chats.message(spoken.id)?.meta.speech, spoken.meta.speech, 'stored with the message');
  const typed = h.chats.send({ conversationId: chat.id, body: 'Typed', authorId: HUMAN_ID });
  assert.deepEqual(typed.meta, {});
  const fromAgent = h.chats.send({ conversationId: chat.id, body: BODY, authorId: tom.id, speech: { source: 'endpoint' } });
  assert.equal(fromAgent.meta.speech, undefined);
  assert.throws(() => h.chats.send({ conversationId: chat.id, body: 'x', authorId: HUMAN_ID, speech: { source: 'nope' } as never }), WorkforceError);
});

test('context: a spoken line reads like a typed one', () => {
  const f = fixture();
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: HUMAN_ID });
  f.chats.send({ conversationId: chat.id, body: 'Plain typed line', authorId: HUMAN_ID });
  f.chats.send({ conversationId: chat.id, body: BODY, authorId: HUMAN_ID, speech: { source: 'endpoint' } });
  const lines = f.context.delta({ agent: f.vid, conversationId: chat.id, sinceSeq: 0, full: false }).text.split('\n');
  assert.deepEqual(lines.slice(-2), ['[11:00] Alex: Plain typed line', BODY]);
});

test('RPC messages.send takes `speech` from the composer or a phone; a wrong shape is a bad_request', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  const phone = new TestClient(f.server, PHONE);
  const chat = await phone.call<Conversation>('chats.create', { agentIds: ['ag_ava'] });
  const sent = await phone.call<Message>('messages.send', { conversationId: chat.id, body: BODY, speech: { source: 'endpoint', live: true } });
  assert.equal(sent.meta.via, 'voice');
  assert.deepEqual(sent.meta.speech, { source: 'endpoint', live: true });
  const wrong = await phone.request('messages.send', { conversationId: chat.id, body: BODY, speech: { source: 'radio' } });
  assert.equal(wrong.error?.code, 'bad_request');
});
