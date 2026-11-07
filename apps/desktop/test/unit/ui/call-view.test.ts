// AF-015 – a call looks like a call: the call view's states (ui/chat/call/call-model.ts – the engines' states as the
// four phases, who speaks from real levels, the ring, the clock, the mini window's place, a call that ended by itself,
// captions and the background line), the meters (call-levels.ts), the start and end signals (call-tones.ts), the mock
// engine through a whole call (call-mock.ts: connect, the person speaks, working, the agent speaks, mute holds the next
// line, hang up ends the call row) and mute in the voice conversation's capture and in realtime voice (silence goes out).
// Owns: these assertions only. Never: a real microphone, speaker, audio context or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import {
  CALL_TEXT, ENGINE_GONE_MS, backgroundLine, callClock, captionOf, clampMini, engineGone, realtimePhase, ringScale,
  speakerOf, statusLine, toggledView, voicePhase,
} from '../../../src/ui/chat/call/call-model.ts';
import { LevelMeter, WaveHistory, micBlocked, micGate } from '../../../src/ui/chat/call/call-levels.ts';
import { TONE_GAIN, toneLength, tonePlan } from '../../../src/ui/chat/call/call-tones.ts';
import { MOCK_CONNECT_MS, MOCK_LINES, MOCK_PAUSE_MS, MOCK_REPLY_WAIT_MS, MockCall, mockLevel, speakingMs } from '../../../src/ui/chat/call/call-mock.ts';
import type { MockCallDeps } from '../../../src/ui/chat/call/call-mock.ts';
import type { CallPhase } from '../../../src/ui/chat/call/call-model.ts';
import { ConversationCapture, type RecorderLike } from '../../../src/ui/chat/composer/conversation-audio.ts';
import { RealtimeCall } from '../../../src/ui/chat/call/realtime-call.ts';
import type { RealtimeDeps } from '../../../src/ui/chat/call/realtime-call.ts';

const CHAT = 'ch_callview001';

// ------------------------------------------------------------------ phases and who speaks

test('call phases: the voice conversation and realtime voice read as connecting, listening, speaking, working', () => {
  assert.equal(voicePhase(undefined), 'connecting', 'no session yet');
  assert.equal(voicePhase('starting'), 'connecting');
  assert.equal(voicePhase('listening'), 'listening');
  assert.equal(voicePhase('transcribing'), 'working');
  assert.equal(voicePhase('responding'), 'working');
  assert.equal(voicePhase('speaking'), 'speaking');
  assert.equal(realtimePhase({ opened: false, answering: false }), 'connecting');
  assert.equal(realtimePhase({ opened: true, answering: false }), 'listening');
  assert.equal(realtimePhase({ opened: true, answering: true }), 'speaking');
  assert.equal(realtimePhase({ opened: true, answering: false, handedOver: true }), 'working');
  assert.deepEqual(Object.values(CALL_TEXT.phase), ['Connecting…', 'Listening', 'Speaking', 'Working…']);
  assert.equal(statusLine('listening', '1:23'), 'Listening · 1:23');
  assert.equal(statusLine('connecting', ''), 'Connecting…', 'no clock while it connects');
});

test('who speaks comes from the levels: the agent\'s playback first, the person\'s microphone unless muted', () => {
  assert.equal(speakerOf({ mic: 0.9, out: 0.9 }, 'connecting', false), null, 'nobody while it connects');
  assert.equal(speakerOf({ mic: 0, out: 0.5 }, 'listening', false), 'agent');
  assert.equal(speakerOf({ mic: 0.6, out: 0 }, 'listening', false), 'person');
  assert.equal(speakerOf({ mic: 0.6, out: 0 }, 'listening', true), null, 'a muted microphone is nobody');
  assert.equal(speakerOf({ mic: 0.05, out: 0.05 }, 'listening', false), null, 'quiet');
  assert.equal(speakerOf({ mic: 0, out: 0 }, 'speaking', false), 'agent', 'the system voice gives no level: the phase says it');
  assert.equal(speakerOf({ mic: 0.8, out: 0 }, 'speaking', false), 'agent', 'its own echo is not the person');
});

test('the ring grows with the level, never with reduced motion; the clock starts once connected', () => {
  assert.equal(ringScale(0, false), 1);
  assert.equal(ringScale(1, false), 1.18);
  assert.equal(ringScale(5, false), 1.18, 'bounded');
  assert.equal(ringScale(1, true), 1, 'prefers-reduced-motion: the ring keeps its size');
  assert.equal(callClock(undefined, 10_000), '');
  assert.equal(callClock(1_000, 84_000), '1:23');
  assert.equal(callClock(0, 3_725_000), '1:02:05');
});

test('the view: full ↔ mini, the mini window stays inside the window, a call ends once its engine is gone long enough', () => {
  assert.equal(toggledView('full'), 'mini');
  assert.equal(toggledView('mini'), 'full');
  const box = { width: 300, height: 64 };
  const viewport = { width: 1280, height: 800 };
  assert.deepEqual(clampMini({ x: 2000, y: -40 }, box, viewport), { x: 972, y: 8 });
  assert.deepEqual(clampMini({ x: 100.4, y: 300.6 }, box, viewport), { x: 100, y: 301 });
  assert.deepEqual(clampMini({ x: 50, y: 50 }, box, { width: 200, height: 40 }), { x: 8, y: 8 }, 'a window smaller than the box: its corner');
  let state = engineGone(true, null, 0);
  assert.deepEqual(state, { goneSince: null, ended: false });
  state = engineGone(false, state.goneSince, 1000);
  assert.deepEqual(state, { goneSince: 1000, ended: false }, 'gone for a moment (realtime handing over) is not the end');
  state = engineGone(true, state.goneSince, 1500);
  assert.equal(state.goneSince, null, 'back: the count starts again');
  state = engineGone(false, null, 2000);
  state = engineGone(false, state.goneSince, 2000 + ENGINE_GONE_MS);
  assert.equal(state.ended, true);
});

test('captions: the newest line of the call – the person as "You", an agent by name; rows before it or status rows give none', () => {
  const call = { conversationId: CHAT, since: 1000, callId: 'msg_call' };
  const row = (patch: Partial<Message>) => ({ conversationId: CHAT, authorKind: 'agent', authorId: 'ag_ava', kind: 'text', body: 'Sure, here is the plan.', state: 'final', createdAt: 2000, silent: false, meta: {}, ...patch }) as Message;
  const name = () => 'Ava';
  assert.deepEqual(captionOf(row({}), call, name), { who: 'agent', name: 'Ava', text: 'Sure, here is the plan.', at: 2000 });
  assert.deepEqual(captionOf(row({ authorKind: 'human', authorId: 'human', body: 'What is next?', meta: { call: { id: 'msg_call', participant: 'device:pc', name: 'PC' } } }), call, name)?.name, 'You');
  assert.equal(captionOf(row({ authorKind: 'human', authorId: 'human', body: 'typed, not said' }), call, name), null, 'a typed line is no caption');
  assert.equal(captionOf(row({ createdAt: 10 }), call, name), null, 'before the call');
  assert.equal(captionOf(row({ conversationId: 'ch_other' }), call, name), null);
  assert.equal(captionOf(row({ kind: 'status' }), call, name), null);
  assert.equal(captionOf(row({ state: 'streaming' }), call, name), null);
  assert.equal(captionOf(row({ body: '```js\ncode()\n```' }), call, name), null, 'nothing speakable');
  const long = captionOf(row({ body: 'word '.repeat(80) }), call, name)!;
  assert.ok(long.text.startsWith('…') && long.text.length <= 161, 'a long answer shows its newest words');
  assert.equal(backgroundLine('Mira: writing the plan', 2), 'Mira: writing the plan · 2 agents working in other chats');
  assert.equal(backgroundLine('', 1), '1 agent working in other chats');
  assert.equal(backgroundLine('', 0), '');
});

// ------------------------------------------------------------------ meters and tones

test('meters rise at once and fall slowly; the wave keeps its newest bars; the microphone gate', () => {
  const meter = new LevelMeter(2);
  meter.feed(0.8, 1000);
  assert.equal(meter.read(1000), 0.8);
  assert.ok(Math.abs(meter.read(1100) - 0.6) < 1e-9, 'falls 2 per second');
  meter.feed(0.1, 1100);
  assert.ok(Math.abs(meter.read(1100) - 0.6) < 1e-9, 'a lower reading does not cut it');
  assert.equal(meter.read(5000), 0);
  const wave = new WaveHistory(3);
  for (const level of [0.1, 0.2, 0.3, 0.4]) wave.push({ level, speaker: 'agent' });
  assert.deepEqual(wave.list().map((bar) => bar.level), [0.2, 0.3, 0.4]);
  assert.equal(wave.version, 4);
  micGate.muted = false; micGate.quietUntil = 0;
  assert.equal(micBlocked(100), false);
  micGate.quietUntil = 500;
  assert.equal(micBlocked(100), true, 'a call signal plays');
  micGate.quietUntil = 0; micGate.muted = true;
  assert.equal(micBlocked(100), true, 'muted');
  micGate.muted = false;
});

test('start and end signals: a rising and a falling chime, short and quiet', () => {
  const start = tonePlan('start');
  const end = tonePlan('end');
  assert.ok(start[0].freq < start[start.length - 1].freq, 'start rises');
  assert.ok(end[0].freq > end[end.length - 1].freq, 'end falls');
  assert.ok(toneLength(start) <= 0.8 && toneLength(end) <= 0.6);
  assert.ok(TONE_GAIN > 0 && TONE_GAIN <= 0.2);
});

// ------------------------------------------------------------------ the mock engine

function mockRig() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners: Array<(message: Message) => void> = [];
  const phases: CallPhase[] = [];
  const mic: number[] = [];
  const out: number[] = [];
  let seq = 10;
  const deps: MockCallDeps = {
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'calls.start') return { callId: 'msg_call1' };
      if (method === 'messages.send') return { id: `msg_${++seq}`, seq, meta: { call: { id: 'msg_call1' } } };
      return { ok: true };
    }) as MockCallDeps['call'],
    on: (_event, listener) => { listeners.push(listener as (message: Message) => void); return () => { listeners.splice(listeners.indexOf(listener as (message: Message) => void), 1); }; },
    after: (ms, fn) => { const timer = { at: now + ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    newId: () => 'req_1',
    mic: (level) => mic.push(level),
    out: (level) => out.push(level),
    phase: (phase) => phases.push(phase),
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  /** Moves the clock on by `ms`, running due timers in order. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((timer) => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.cancelled = true;
      next.fn();
      await flush();
    }
    now = end;
  };
  const reply = (body: string) => { for (const listener of [...listeners]) listener({ id: `msg_${++seq}`, seq, conversationId: CHAT, authorKind: 'agent', authorId: 'ag_ava', kind: 'text', body, state: 'final', silent: false, createdAt: now, meta: {} } as unknown as Message); };
  return { deps, calls, phases, mic, out, advance, reply, flush, listeners };
}

test('mock engine: connects, the person speaks, the call works until the agent answers, the agent speaks, then it listens', async () => {
  const r = mockRig();
  const call = new MockCall(CHAT, r.deps);
  await call.start();
  assert.equal(call.phase, 'connecting');
  assert.deepEqual(r.calls[0], { method: 'calls.start', params: { conversationId: CHAT } }, 'the call row opens');
  await r.advance(MOCK_CONNECT_MS);
  assert.equal(call.phase, 'listening');
  await r.advance(MOCK_PAUSE_MS + 3000); // the person says the first line
  const sent = r.calls.filter((entry) => entry.method === 'messages.send');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.body, MOCK_LINES[0]);
  assert.deepEqual(sent[0].params.speech, { source: 'endpoint', live: true, call: 'msg_call1' }, 'sent like a spoken line of the call');
  assert.ok(r.mic.some((level) => level > 0.2), 'microphone levels while the person spoke');
  assert.equal(call.phase, 'working');
  r.reply('Echo: Hi, can you hear me?');
  assert.equal(call.phase, 'speaking');
  await r.advance(speakingMs('Echo: Hi, can you hear me?') + 100);
  assert.ok(r.out.some((level) => level > 0.2), 'playback levels while the agent spoke');
  assert.equal(r.out[r.out.length - 1], 0, 'quiet again after it');
  assert.equal(call.phase, 'listening');
  assert.deepEqual(r.phases.slice(0, 5), ['connecting', 'listening', 'working', 'speaking', 'listening']);
  call.stop();
  assert.deepEqual(r.calls[r.calls.length - 1], { method: 'calls.end', params: { callId: 'msg_call1' } }, 'hang up ends the call row');
  assert.equal(r.listeners.length, 0, 'no listener left');
});

test('mock engine: muted, the next line waits (no microphone level); unmuted it is said; no answer → it listens again', async () => {
  const r = mockRig();
  const call = new MockCall(CHAT, r.deps);
  await call.start();
  await r.advance(MOCK_CONNECT_MS);
  call.setMuted(true);
  await r.advance(MOCK_PAUSE_MS + 6000);
  assert.equal(r.calls.filter((entry) => entry.method === 'messages.send').length, 0, 'nothing said while muted');
  assert.ok(r.mic.every((level) => level === 0), 'the microphone is silent');
  call.setMuted(false);
  await r.advance(3000);
  assert.equal(r.calls.filter((entry) => entry.method === 'messages.send').length, 1, 'said once unmuted');
  await r.advance(MOCK_REPLY_WAIT_MS);
  assert.equal(call.phase, 'listening', 'nobody answered: it listens again');
  call.stop();
  call.stop();
  assert.equal(r.calls.filter((entry) => entry.method === 'calls.end').length, 1, 'ends once');
});

test('mock engine: hung up while it still connects, the call row still ends', async () => {
  const r = mockRig();
  const call = new MockCall(CHAT, r.deps);
  const started = call.start();
  call.stop();
  await started;
  await r.flush();
  assert.deepEqual(r.calls.map((entry) => entry.method), ['calls.start', 'calls.end']);
  assert.ok(mockLevel(0) >= 0.2 && mockLevel(7) <= 1);
});

// ------------------------------------------------------------------ mute in the real engines

class FakeRecorder implements RecorderLike {
  state: RecorderLike['state'] = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  start(): void { this.state = 'recording'; }
  stop(): void { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) } as BlobEvent); this.onstop?.(new Event('stop')); }
}

test('voice conversation: a muted call takes nothing and reports silence; unmuted it takes the next words', async () => {
  let now = 0;
  let muted = true;
  let feed: ((samples: Float32Array, rate: number) => void) | undefined;
  const levels: number[] = [];
  const recorders: FakeRecorder[] = [];
  const utterances: string[] = [];
  const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
  const capture = new ConversationCapture({ utterance: async (_id, fileId) => { utterances.push(fileId); } }, () => undefined, {
    openMicrophone: async (listener) => { feed = listener; return { stream, close: () => undefined }; },
    newRecorder: () => { const recorder = new FakeRecorder(); recorders.push(recorder); return recorder; },
    upload: async () => ({ id: 'file_1' }),
    now: () => now,
    level: (value) => levels.push(value),
    muted: () => muted,
  });
  await capture.open();
  capture.follow({ id: 'mic_1', conversationId: CHAT, status: 'listening' });
  const run = (level: number, ms: number) => { for (let t = 0; t < ms; t += 85) { now += 85; feed!(new Float32Array(4096).fill(level), 48_000); } };
  run(0.3, 400);
  run(0, 1400);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recorders.length, 0, 'muted: no take started');
  assert.ok(levels.length > 0 && levels.every((level) => level === 0), 'the call view sees silence');
  muted = false;
  run(0.3, 300);
  run(0, 1400);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(utterances, ['file_1']);
  assert.ok(levels.some((level) => level > 0.2), 'and its real level');
});

test('realtime voice: a muted call sends silence (the provider hears a pause), the answer plays through the output meter', async () => {
  let muted = true;
  let onSamples: ((samples: Float32Array, rate: number) => void) | undefined;
  const sent: string[] = [];
  const metered: unknown[] = [];
  const output = { currentTime: 0, destination: { kind: 'destination' }, createBuffer: (_c: number, length: number, rate: number) => { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data }; }, createBufferSource: () => ({ buffer: null, onended: null, connect: (node: unknown) => metered.push(node), start() {}, stop() {} }), async close() {} };
  const meter = { kind: 'meter' };
  const pulls: Array<(value: unknown) => void> = [];
  const deps: RealtimeDeps = {
    call: (async (method: string, params: Record<string, unknown>) => {
      if (method === 'calls.realtimeOpen') return { sessionId: 'rts_1', model: 'gpt-realtime', agentId: 'ag_ava' };
      if (method === 'calls.realtimeSend') sent.push(String(params.audio));
      if (method === 'calls.realtimePull') return new Promise((resolve) => pulls.push(resolve as (value: unknown) => void));
      return { ok: true };
    }) as RealtimeDeps['call'],
    openMicrophone: async (listener) => { onSamples = listener; return { stream: {} as MediaStream, close: () => undefined }; },
    newOutput: () => output as unknown as AudioContext,
    muted: () => muted,
    meter: () => meter as unknown as AudioNode,
  };
  const session = new RealtimeCall(CHAT, deps);
  await session.start(() => undefined);
  onSamples!(new Float32Array(4800).fill(0.5), 48_000);
  assert.equal(sent.length, 1);
  assert.ok([...atob(sent[0])].every((char) => char === '\u0000'), 'muted: only silence goes out');
  muted = false;
  onSamples!(new Float32Array(4800).fill(0.5), 48_000);
  assert.ok([...atob(sent[1])].some((char) => char !== '\u0000'), 'unmuted: the voice');
  const pcm = btoa(String.fromCharCode(...new Uint8Array(480).fill(16)));
  pulls.shift()!({ events: [{ seq: 1, type: 'speaking' }, { seq: 2, type: 'audio', data: pcm }], next: 2 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(metered, [meter], 'the answer goes through the meter');
  session.stop();
});
