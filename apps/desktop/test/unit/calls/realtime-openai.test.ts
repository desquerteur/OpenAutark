// The OpenAI Realtime adapter (src/runtime/calls/realtime/openai.ts) against a local fake realtime server
// (ws on 127.0.0.1): the key only in the Authorization header, the session it asks for (PCM16 24 kHz both
// ways, server VAD that cuts answers, input transcription, the hand_over function), history items, audio
// in and out, transcripts both ways, the hand-over round trip and chat text to tell in the provider's event
// order (response.create only once no response is active), interrupt (truncate to what was heard, also after
// server VAD cut the answer; cancel only an answer still active), safe error
// texts (refused key on upgrade, provider error codes – never the body) and close.
// Owns: these assertions only. Never: the real provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { OpenAiRealtime, realtimeUrl } from '../../../src/runtime/calls/realtime/openai.ts';
import type { VoiceEngineEvents } from '../../../src/runtime/calls/realtime/engine.ts';
import { wsConnect } from '../../../src/runtime/calls/wiring.ts';

interface Fake { url: string; received: Array<Record<string, unknown>>; headers: Record<string, string | string[] | undefined>; socket: () => WebSocket; send(event: Record<string, unknown>): void; close(): Promise<void>; next(type: string): Promise<Record<string, unknown>> }

async function fakeServer(options: { refuse?: number } = {}): Promise<Fake> {
  const received: Array<Record<string, unknown>> = [];
  const waiting: Array<{ type: string; resolve: (event: Record<string, unknown>) => void }> = [];
  let headers: Record<string, string | string[] | undefined> = {};
  let client: WebSocket | undefined;
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0,
    verifyClient: (info, done) => { headers = info.req.headers; if (options.refuse) done(false, options.refuse); else done(true); },
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (socket) => {
    client = socket;
    socket.on('message', (data) => {
      const event = JSON.parse(String(data)) as Record<string, unknown>;
      received.push(event);
      const index = waiting.findIndex((entry) => entry.type === event.type);
      if (index >= 0) waiting.splice(index, 1)[0].resolve(event);
    });
    socket.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_1' } }));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    received, get headers() { return headers; },
    socket: () => client!,
    send: (event) => client!.send(JSON.stringify(event)),
    close: () => new Promise<void>((resolve) => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }),
    next: (type) => {
      const seen = received.find((event) => event.type === type && !(event as { _taken?: boolean })._taken);
      if (seen) { (seen as { _taken?: boolean })._taken = true; return Promise.resolve(seen); }
      return new Promise((resolve) => waiting.push({ type, resolve: (event) => { (event as { _taken?: boolean })._taken = true; resolve(event); } }));
    },
  };
}

function recorder() {
  const seen: Array<[string, unknown]> = [];
  const waiters: Array<{ name: string; resolve: () => void }> = [];
  const note = (name: string, value?: unknown) => {
    seen.push([name, value]);
    for (const waiter of waiters.filter((entry) => entry.name === name)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  };
  const events: VoiceEngineEvents = {
    audio: (pcm) => note('audio', [...pcm]), speechStarted: () => note('speechStarted'), answerStarted: () => note('answerStarted'),
    answerDone: () => note('answerDone'), heard: (text) => note('heard', text), said: (text) => note('said', text),
    handOver: (request) => note('handOver', request), error: (message) => note('error', message), closed: (reason) => note('closed', reason),
  };
  const until = (name: string, times = 1): Promise<void> => seen.filter(([seenName]) => seenName === name).length >= times
    ? Promise.resolve()
    : new Promise<void>((resolve) => waiters.push({ name, resolve })).then(() => until(name, times));
  return { events, seen, until };
}

const config = { model: 'gpt-realtime', instructions: 'You are Ava.', voice: 'marin', history: [{ role: 'user' as const, text: 'Earlier question' }, { role: 'assistant' as const, text: 'Earlier answer' }], handOver: true, vocabulary: 'Teydra, Kling' };

test('realtime url: https base → wss …/realtime?model=', () => {
  assert.equal(realtimeUrl(undefined, 'gpt-realtime'), 'wss://api.openai.com/v1/realtime?model=gpt-realtime');
  assert.equal(realtimeUrl('http://127.0.0.1:9/v1/', 'gpt realtime'), 'ws://127.0.0.1:9/v1/realtime?model=gpt%20realtime');
});

test('a session: key in the header, session and history sent, audio both ways, transcripts, hand-over, interrupt, close', async (t) => {
  const fake = await fakeServer();
  t.after(() => fake.close());
  const r = recorder();
  const engine = new OpenAiRealtime({ key: 'sk-test-123', baseUrl: fake.url, connect: wsConnect });
  const session = await engine.open(config, r.events);
  assert.equal(fake.headers.authorization, 'Bearer sk-test-123');
  const update = await fake.next('session.update');
  const s = update.session as Record<string, any>;
  assert.equal(s.type, 'realtime');
  assert.equal(s.instructions, 'You are Ava.');
  assert.deepEqual(s.audio.input.format, { type: 'audio/pcm', rate: 24_000 });
  assert.deepEqual(s.audio.input.turn_detection, { type: 'server_vad', create_response: true, interrupt_response: true });
  assert.ok(s.audio.input.transcription.model);
  assert.equal(s.audio.input.transcription.prompt, 'Teydra, Kling', 'the word list helps the transcription');
  assert.equal(s.audio.output.voice, 'marin');
  assert.equal(s.tools[0].name, 'hand_over');
  const first = await fake.next('conversation.item.create');
  const second = await fake.next('conversation.item.create');
  assert.deepEqual([(first.item as any).role, (first.item as any).content[0]], ['user', { type: 'input_text', text: 'Earlier question' }]);
  assert.deepEqual([(second.item as any).role, (second.item as any).content[0].type], ['assistant', 'output_text']);

  session.sendAudio(new Uint8Array([1, 0, 2, 0]));
  assert.equal((await fake.next('input_audio_buffer.append')).audio, Buffer.from([1, 0, 2, 0]).toString('base64'));

  fake.send({ type: 'input_audio_buffer.speech_started' });
  fake.send({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' What is next? ' });
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.output_audio.delta', item_id: 'item_9', delta: Buffer.from([7, 0]).toString('base64') });
  fake.send({ type: 'response.output_audio_transcript.done', transcript: 'The cut.' });
  fake.send({ type: 'response.done' });
  await r.until('answerDone');
  assert.deepEqual(r.seen.slice(0, 6), [['speechStarted', undefined], ['heard', 'What is next?'], ['answerStarted', undefined], ['audio', [7, 0]], ['said', 'The cut.'], ['answerDone', undefined]]);

  // The person talks over the next answer: server VAD cuts it (speech_started while answering), then the
  // device reports how much it played – truncated to that, without a second cancel.
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.audio.delta', item_id: 'item_10', delta: Buffer.alloc(4800 * 2).toString('base64') }); // beta event name, 200 ms
  fake.send({ type: 'input_audio_buffer.speech_started' });
  fake.send({ type: 'response.done' }); // status cancelled by the server
  await r.until('answerDone', 2);
  session.interrupt(120);
  assert.deepEqual(await fake.next('conversation.item.truncate'), { type: 'conversation.item.truncate', item_id: 'item_10', content_index: 0, audio_end_ms: 120, _taken: true });
  assert.ok(!fake.received.some((event) => event.type === 'response.cancel'), 'server VAD already cancelled it');

  // An answer that finished generating but still plays on the device: truncated after speech_started too.
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.output_audio.delta', item_id: 'item_11', delta: Buffer.alloc(480).toString('base64') }); // 10 ms
  fake.send({ type: 'response.done' });
  await r.until('answerDone', 3);
  fake.send({ type: 'input_audio_buffer.speech_started' });
  await r.until('speechStarted', 3);
  session.interrupt(900);
  assert.deepEqual((await fake.next('conversation.item.truncate')).audio_end_ms, 10, 'never past the audio the item has');
  session.interrupt(50);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.received.filter((event) => event.type === 'conversation.item.truncate').length, 2, 'truncated once');

  // The device cuts an answer still being generated (no server VAD event): cancel + truncate.
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.output_audio.delta', item_id: 'item_12', delta: Buffer.alloc(4800).toString('base64') });
  await r.until('audio', 4);
  session.interrupt(60);
  assert.equal((await fake.next('response.cancel')).type, 'response.cancel');
  assert.equal((await fake.next('conversation.item.truncate')).item_id, 'item_12');
  fake.send({ type: 'response.done' });
  await r.until('answerDone', 4);

  // Hand-over in the provider's order: response.created → function_call_arguments.done → response.done.
  // The function output goes at once; the follow-up response.create only after response.done.
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.function_call_arguments.done', name: 'hand_over', call_id: 'call_7', arguments: JSON.stringify({ request: 'Render the video' }) });
  await r.until('handOver');
  assert.deepEqual(r.seen.find(([name]) => name === 'handOver'), ['handOver', 'Render the video']);
  const output = await fake.next('conversation.item.create');
  assert.deepEqual(output.item, { type: 'function_call_output', call_id: 'call_7', output: JSON.stringify({ ok: true }) });
  const creates = () => fake.received.filter((event) => event.type === 'response.create').length;
  // The agent's answer arrives while the response is still active: it waits too.
  session.addText('user', 'Ava wrote: done', { respond: true });
  const told = await fake.next('conversation.item.create');
  assert.deepEqual((told.item as any).content[0], { type: 'input_text', text: 'Ava wrote: done' });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(creates(), 0, 'no response.create while a response is active');
  fake.send({ type: 'response.done' });
  await fake.next('response.create');
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(creates(), 1, 'one follow-up answer covers both (the model has both items)');
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.done' });
  await r.until('answerDone', 6);
  session.addText('user', 'Ben wrote: later', { respond: true }); // nothing active now: at once
  await fake.next('response.create');
  assert.equal(creates(), 2);
  fake.send({ type: 'response.created' });
  fake.send({ type: 'response.done' });

  fake.send({ type: 'error', error: { type: 'invalid_request_error', code: 'rate_limit_exceeded', message: 'secret body sk-test-123' } });
  await r.until('error');
  assert.deepEqual(r.seen.find(([name]) => name === 'error'), ['error', 'The realtime model is rate limited right now.']);
  assert.ok(!JSON.stringify(r.seen).includes('sk-test-123'), 'never the key or the provider body');

  session.close();
  await r.until('closed');
});

test('a refused key on the upgrade and a session that never starts fail with a safe message', async () => {
  const refused = await fakeServer({ refuse: 401 });
  const r = recorder();
  await assert.rejects(new OpenAiRealtime({ key: 'sk-bad', baseUrl: refused.url, connect: wsConnect }).open(config, r.events), /refused the API key/);
  await refused.close();

  const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => silent.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`;
  await assert.rejects(new OpenAiRealtime({ key: 'sk', baseUrl: url, connect: wsConnect, timeoutMs: 150 }).open(config, r.events), /did not answer/);
  await new Promise<void>((resolve) => { for (const socket of silent.clients) socket.terminate(); silent.close(() => resolve()); });
});

test('the server closing the session reports it once', async (t) => {
  const fake = await fakeServer();
  t.after(() => fake.close());
  const r = recorder();
  await new OpenAiRealtime({ key: 'sk', baseUrl: fake.url, connect: wsConnect }).open({ ...config, history: [], handOver: false }, r.events);
  const update = await fake.next('session.update');
  assert.equal((update.session as Record<string, unknown>).tools, undefined, 'no hand-over offered without handOver');
  fake.socket().close(1011, 'server error');
  await r.until('closed');
  assert.deepEqual(r.seen.filter(([name]) => name === 'closed'), [['closed', 'The realtime connection closed.']]);
});

test('open: its cancel listener goes once the session opened; a cancel while connecting closes the socket', async (t) => {
  const fake = await fakeServer();
  t.after(() => fake.close());
  const opened = new AbortController();
  await new OpenAiRealtime({ key: 'sk', baseUrl: fake.url, connect: wsConnect }).open(config, recorder().events, opened.signal);
  assert.equal(getEventListeners(opened.signal, 'abort').length, 0);

  const silent = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => silent.once('listening', () => resolve()));
  t.after(() => new Promise<void>((resolve) => { for (const socket of silent.clients) socket.terminate(); silent.close(() => resolve()); }));
  const connecting = new AbortController();
  const opening = new OpenAiRealtime({ key: 'sk', baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`, connect: wsConnect }).open(config, recorder().events, connecting.signal);
  connecting.abort();
  await assert.rejects(opening, /cancelled/);
  assert.equal(getEventListeners(connecting.signal, 'abort').length, 0);
  const already = new AbortController();
  already.abort();
  await assert.rejects(new OpenAiRealtime({ key: 'sk', baseUrl: fake.url, connect: wsConnect }).open(config, recorder().events, already.signal), /cancelled/);
});
