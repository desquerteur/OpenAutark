// Tests for B-078 T7.1 (src/runtime/chat/delivery-dictation.ts through chat/delivery.ts): a person's line that is
// only a recording, while speech to text is ready and its bytes are here, wakes nobody until its transcript arrives
// ('message.updated' with a body / meta.dictation) – then once; without a transcript it is delivered after the wait;
// without speech to text, with text, or for an agent's line nothing waits.
// Owns: these assertions only. Never: real speech to text or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DeliveryServiceImpl } from '../../../src/runtime/chat/delivery.ts';
import { MessageRepo } from '../../../src/runtime/chat/message-repo.ts';
import { agent, harness } from './harness.ts';

const HERE = fileURLToPath(import.meta.url); // a file that exists: "the recording's bytes are on this PC"
const VOICE = [{ fileId: 'f'.repeat(64), name: 'voice.webm', mime: 'audio/webm;codecs=opus', size: 1200 }];

function setup(options: { stt?: string; bytes?: boolean; waitMs?: number } = {}) {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const services = h.services as RuntimeServices & Record<string, unknown>;
  services.stt = { state: () => options.stt ?? 'ready' } as unknown as RuntimeServices['stt'];
  services.files = { path: () => (options.bytes === false ? `${HERE}.missing` : HERE) } as unknown as RuntimeServices['files'];
  services.delivery = new DeliveryServiceImpl(services, { dictationWaitMs: options.waitMs ?? 60_000 });
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  const voice = () => h.chats.send({ conversationId: chat.id, authorId: HUMAN_ID, body: '', attachments: VOICE });
  const transcribe = (id: string, text: string) => {
    const repo = new MessageRepo(h.db);
    const message = repo.get(id)!;
    message.body = text;
    message.meta = { ...message.meta, dictation: { fileId: VOICE[0].fileId } };
    repo.update(message);
    h.bus.emit('message.updated', message);
  };
  const woken = () => h.wakeRows().map((row) => row.agent_id);
  return { ...h, chat, voice, transcribe, woken };
}

test('T7.1: a bare recording waits for its transcript, then wakes the agent once', () => {
  const h = setup();
  const message = h.voice();
  assert.deepEqual(h.woken(), [], 'nothing is woken while the transcript is on its way');
  h.transcribe(message.id, 'Please book the train for Monday');
  assert.deepEqual(h.woken(), ['ag_tom'], 'the transcript delivers it');
  h.db.run('DELETE FROM wakes');
  h.bus.emit('message.updated', { ...message, body: 'Edited later', meta: { dictation: { fileId: VOICE[0].fileId } } });
  assert.deepEqual(h.woken(), [], 'delivered once: a later update wakes nobody');
});

test('T7.1: without a transcript the recording is delivered after the wait', async () => {
  const h = setup({ waitMs: 20 });
  h.voice();
  assert.deepEqual(h.woken(), []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.woken(), ['ag_tom'], 'delivered as it is');
});

test('T7.1: an update without text keeps waiting', () => {
  const h = setup();
  const message = h.voice();
  h.bus.emit('message.updated', { ...message, meta: { reaction: 'x' } });
  assert.deepEqual(h.woken(), []);
  h.transcribe(message.id, 'Hello');
  assert.deepEqual(h.woken(), ['ag_tom']);
});

test('T7.1: a recording deleted while it waits wakes nobody', async () => {
  const h = setup({ waitMs: 20 });
  const message = h.voice();
  h.bus.emit('message.removed', { id: message.id, conversationId: h.chat.id });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.woken(), []);
});

test('T7.1: nothing waits without speech to text, without the bytes here, or for a line with text', () => {
  for (const options of [{ stt: 'missing' }, { bytes: false }]) {
    const h = setup(options);
    h.voice();
    assert.deepEqual(h.woken(), ['ag_tom'], JSON.stringify(options));
  }
  const h = setup();
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Listen to this', attachments: VOICE });
  assert.deepEqual(h.woken(), ['ag_tom'], 'a line with text is delivered at once');
});
