// The Gemini Live adapter (src/runtime/calls/realtime/gemini-live.ts) and the choice that reaches it, against a local fake
// Live server (ws on 127.0.0.1) with the real chat service: the key only in the header, the setup it sends, audio resampled
// to 16 kHz, answer audio, both transcripts as quiet lines, the hand-over round trip, chat text held while an answer runs,
// a refused setup as a safe sentence; a Google key alone is enough for the choice, a chosen model wins.
// Owns: these assertions only. Never: the real provider (no key here: no real call ran).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { isChatModel, isRealtimeModel } from '../../../src/shared/model/models-uses.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { geminiLiveUrl } from '../../../src/runtime/calls/realtime/gemini-live.ts';
import { Pcm24To16 } from '../../../src/runtime/calls/realtime/pcm.ts';
import { CallLog } from '../../../src/runtime/calls/call-log.ts';
import { RealtimeCalls } from '../../../src/runtime/calls/realtime/session.ts';
import { realtimeChoice, realtimeVoice } from '../../../src/runtime/calls/realtime/setup.ts';
import { wsConnect } from '../../../src/runtime/calls/wiring.ts';
import { agent, harness } from '../chat/harness.ts';

const PC = { key: 'pc', name: 'Office PC' };
const timers = { set: () => 0, clear: () => {} };

async function fakeLive(options: { refuse?: number } = {}) {
  const received: Array<Record<string, any>> = [];
  const listeners: Array<() => void> = [];
  let socket: WebSocket | undefined;
  let headers: Record<string, unknown> = {};
  let url = '';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (client, request) => {
    socket = client;
    headers = request.headers;
    url = request.url ?? '';
    client.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.setup) { if (options.refuse) client.close(options.refuse, 'secret provider text'); else client.send(Buffer.from(JSON.stringify({ setupComplete: {} }))); }
      for (const listener of listeners.splice(0)) listener();
    });
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai`, received, get headers() { return headers; }, get url() { return url; },
    until: async (check: () => boolean) => { while (!check()) await new Promise<void>((resolve) => listeners.push(resolve)); },
    send: (message: Record<string, unknown>) => socket!.send(JSON.stringify(message)),
    close: () => new Promise<void>((resolve) => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }),
  };
}

function setup(baseUrl: string, routingVoice?: string, listed: Array<{ provider: string; model: string; accounts: string[] }> = []) {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava', { voice: 'aoede' }));
  const solo = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const account = { id: 'acc_g', provider: 'google', label: 'Gemini', auth: 'api_key', baseUrl, state: 'ok', priority: 1, rotation: false, enabled: true, detected: false, createdAt: 0 };
  Object.assign(h.services, {
    accounts: { list: () => [account], apiKey: async () => 'g-test-key' },
    catalog: { list: () => listed },
    settings: { get: () => ({ profile: { name: 'Gerd', language: 'de' }, voice: { vocabulary: ['Teydra'] }, routing: routingVoice ? { voice: routingVoice } : {} }) },
  });
  const calls = new RealtimeCalls({ services: () => h.services as RuntimeServices, log: new CallLog(() => h.services as RuntimeServices), connect: wsConnect, timers });
  return { ...h, solo, calls };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test('the choice: a Google key alone, its newest listed Live model, a chosen model; only Gemini names count as Live', () => {
  assert.equal(realtimeChoice(setup('http://127.0.0.1:9').services)?.model, 'gemini-3.8-live');
  const listed = [
    { provider: 'google', model: 'gemini-3.8-flash', accounts: [] },
    { provider: 'google', model: 'gemini-2.5-flash-native-audio-preview', accounts: [] },
    { provider: 'google', model: 'gemini-3.9-live-extended-thinking', accounts: [] },
    { provider: 'google', model: 'gemini-3.9-live', accounts: [] },
    { provider: 'google', model: 'gemini-4.0-transcribe-live', accounts: [] },
    { provider: 'google', model: 'gemini-4.0-live-translate-preview', accounts: [] },
  ];
  assert.equal(realtimeChoice(setup('http://127.0.0.1:9', undefined, listed).services)?.model, 'gemini-3.9-live', 'a live transcriber or translator gives no conversation');
  assert.equal(isChatModel({ model: 'gemini-4.0-transcribe-live', strengths: {} }), false, 'and is no chat model either');
  assert.equal(realtimeChoice(setup('http://127.0.0.1:9', 'google:gemini-mine-live').services)?.model, 'gemini-mine-live');
  assert.equal(realtimeVoice('aoede', { provider: 'google' }), 'Aoede');
  assert.equal(realtimeVoice('marin', { provider: 'google' }), 'Kore');
  assert.equal(isRealtimeModel({ model: 'gemini-3.8-live' }), true);
  assert.equal(isRealtimeModel({ model: 'gemini-2.5-flash-native-audio-preview' }), true);
  assert.equal(isRealtimeModel({ model: 'gemini-3.8-flash' }), false);
  assert.equal(isRealtimeModel({ model: 'some-live-chat' }), false);
  assert.equal(isChatModel({ model: 'gemini-3.8-live', strengths: {} }), false, 'a Live model is no chat model');
  assert.equal(geminiLiveUrl('https://example.test/v1beta/openai'), 'wss://example.test/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
});

test('a Gemini Live session: setup, audio both ways, quiet transcripts, the hand-over, chat text held during an answer', async (t) => {
  const fake = await fakeLive();
  t.after(() => fake.close());
  const h = setup(fake.base);
  h.chats.send({ conversationId: h.solo.id, body: 'Earlier line', authorId: HUMAN_ID, authorKind: 'human', silent: true });
  const opened = await h.calls.open(h.solo.id, PC);
  t.after(() => h.calls.stop());
  assert.equal(opened.model, 'gemini-3.8-live');
  assert.equal(fake.headers['x-goog-api-key'], 'g-test-key');
  assert.ok(!fake.url.includes('g-test-key'), 'the key stays out of the URL');
  const setupMessage = fake.received[0].setup;
  assert.equal(setupMessage.model, 'models/gemini-3.8-live');
  assert.deepEqual(setupMessage.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setupMessage.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  assert.match(setupMessage.systemInstruction.parts[0].text, /I am Ava/);
  assert.match(setupMessage.systemInstruction.parts[0].text, /Teydra/);
  assert.equal(setupMessage.tools[0].functionDeclarations[0].name, 'hand_over');
  assert.deepEqual(setupMessage.inputAudioTranscription, {});
  assert.deepEqual(setupMessage.historyConfig, { initialHistoryInClientContent: true }, 'the chat lines seed the session before the microphone');
  await fake.until(() => fake.received.some((message) => message.clientContent));
  assert.deepEqual(fake.received.find((message) => message.clientContent)!.clientContent, { turns: [{ role: 'user', parts: [{ text: 'Earlier line' }] }], turnComplete: false });

  // Microphone: 24 kHz in, 16 kHz out (3 samples → 2).
  h.calls.send(opened.sessionId, PC.key, Buffer.alloc(600).toString('base64'));
  await fake.until(() => fake.received.some((message) => message.realtimeInput));
  const audio = fake.received.find((message) => message.realtimeInput)!.realtimeInput.audio;
  assert.equal(audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(audio.data, 'base64').byteLength, 400);

  // An answer: audio, what was heard and said in the chat, quiet.
  fake.send({ serverContent: { inputTranscription: { text: 'Hallo ' } } });
  fake.send({ serverContent: { inputTranscription: { text: 'Ava' } } });
  fake.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.from([1, 0, 2, 0]).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] } } });
  let pull = await h.calls.pull(opened.sessionId, PC.key, 0);
  while (!pull.events.some((event) => event.type === 'audio')) { await tick(); pull = await h.calls.pull(opened.sessionId, PC.key, 0); }
  assert.deepEqual(pull.events.map((event) => event.type), ['speaking', 'audio']);
  // A chat line while it answers waits: client content would cut the answer.
  const before = fake.received.filter((message) => message.clientContent).length;
  h.chats.send({ conversationId: h.solo.id, body: 'Done, see the file.', authorId: 'ag_ava', authorKind: 'agent' });
  await tick();
  assert.equal(fake.received.filter((message) => message.clientContent).length, before);
  fake.send({ serverContent: { outputTranscription: { text: 'Hallo Gerd.' } } });
  fake.send({ serverContent: { turnComplete: true } });
  await fake.until(() => fake.received.filter((message) => message.clientContent).length > before);
  const told = fake.received.filter((message) => message.clientContent).at(-1)!.clientContent;
  assert.equal(told.turnComplete, true);
  assert.match(told.turns[0].parts[0].text, /Done, see the file/);
  const lines = h.chats.messages(h.solo.id, { limit: 20 });
  const heard = lines.find((message) => message.body === 'Hallo Ava')!;
  assert.equal(heard.silent, true);
  assert.equal(heard.meta.call?.participant, 'device:pc');
  const said = lines.find((message) => message.body === 'Hallo Gerd.')!;
  assert.equal(said.authorId, 'ag_ava');
  assert.equal(said.meta.call?.spoken, true);

  // The hand-over: a wake with the request, the function's answer goes back.
  fake.send({ toolCall: { functionCalls: [{ id: 'fc_1', name: 'hand_over', args: { request: 'Book the table' } }] } });
  await fake.until(() => fake.received.some((message) => message.toolResponse));
  assert.deepEqual(fake.received.find((message) => message.toolResponse)!.toolResponse, { functionResponses: [{ id: 'fc_1', name: 'hand_over', response: { ok: true } }] });
  assert.match(h.wakeRows()[0].note ?? '', /Book the table/);

  // The person talks over the next answer: the device is told.
  fake.send({ serverContent: { modelTurn: { parts: [] } } });
  fake.send({ serverContent: { interrupted: true } });
  const after = pull.next;
  let later = await h.calls.pull(opened.sessionId, PC.key, after);
  while (!later.events.some((event) => event.type === 'interrupted')) { await tick(); later = await h.calls.pull(opened.sessionId, PC.key, after); }
  assert.ok(later.events.some((event) => event.type === 'done'));

  h.calls.close(opened.sessionId, PC.key);
  const end = await h.calls.pull(opened.sessionId, PC.key, later.next);
  assert.match(end.closed ?? '', /ended/);
});

test('a refused setup says so without the provider\'s words', async (t) => {
  const fake = await fakeLive({ refuse: 1008 });
  t.after(() => fake.close());
  const h = setup(fake.base);
  await assert.rejects(h.calls.open(h.solo.id, PC), (error: Error) => {
    assert.match(error.message, /Gemini Live refused the session/);
    assert.ok(!error.message.includes('secret provider text'));
    return true;
  });
});

test('the resampler keeps what a chunk leaves over', () => {
  const pcm = new Pcm24To16();
  assert.equal(pcm.push(new Uint8Array(4)).byteLength, 0, 'two samples wait');
  assert.equal(pcm.push(new Uint8Array(2)).byteLength, 4, 'the third completes a group');
});
