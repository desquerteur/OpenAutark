// Realtime voice on this device (ui/chat/call/realtime-call.ts – microphone at 24 kHz in 100 ms pieces, answer
// audio played in order, the person talking over it stops playback and reports what was heard, the session ending
// ends it) and the 24 kHz PCM helpers.
// Owns: these assertions only. Never: a real microphone, speaker, audio context or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RealtimePull } from '../../../src/shared/model/call.ts';
import { RealtimeCall } from '../../../src/ui/chat/call/realtime-call.ts';
import type { RealtimeDeps } from '../../../src/ui/chat/call/realtime-call.ts';
import { Pcm16Encoder, pcm16ToFloat } from '../../../src/ui/lib/pcm.ts';

const CHAT = 'ch_callui00001';

class FakeSource { buffer: { duration: number } | null = null; started?: number; stopped = false; onended: (() => void) | null = null; connect() {} start(at: number) { this.started = at; } stop() { this.stopped = true; } }
class FakeOutput {
  currentTime = 0;
  sources: FakeSource[] = [];
  destination = {};
  createBuffer(_channels: number, length: number, rate: number) { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data }; }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
  async close() {}
}

test('realtime voice: 100 ms pieces at 24 kHz go out, answers play in order, talking over them stops playback', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const pulls: Array<(pull: RealtimePull) => void> = [];
  let onSamples: ((samples: Float32Array, rate: number) => void) | undefined;
  const output = new FakeOutput();
  let micClosed = false;
  const deps: RealtimeDeps = {
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'calls.realtimeOpen') return { sessionId: 'rts_1', model: 'gpt-realtime', agentId: 'ag_ava' };
      if (method === 'calls.realtimePull') return new Promise((resolve) => pulls.push(resolve));
      return { ok: true };
    }) as RealtimeDeps['call'],
    openMicrophone: async (listener) => { onSamples = listener; return { stream: {} as MediaStream, close: () => { micClosed = true; } }; },
    newOutput: () => output as unknown as AudioContext,
  };
  const ended: Array<string | undefined> = [];
  const session = new RealtimeCall(CHAT, deps);
  await session.start((reason) => ended.push(reason));
  assert.deepEqual(calls[0], { method: 'calls.realtimeOpen', params: { conversationId: CHAT } });
  onSamples!(new Float32Array(4800).fill(0.5), 48_000); // 100 ms at 48 kHz → 2400 samples at 24 kHz = 4800 bytes
  const sent = calls.filter((entry) => entry.method === 'calls.realtimeSend');
  assert.equal(sent.length, 1);
  assert.equal(atob(String(sent[0].params.audio)).length, 4800);

  const pcm = new Pcm16Encoder(24_000, 24_000).push(new Float32Array(2400).fill(0.25));
  const audio = btoa(String.fromCharCode(...pcm));
  pulls.shift()!({ events: [{ seq: 1, type: 'speaking' }, { seq: 2, type: 'audio', data: audio }, { seq: 3, type: 'audio', data: audio }], next: 3 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(output.sources.map((source) => source.started), [0, 0.1], 'gap-free, in order');
  assert.deepEqual(calls.filter((entry) => entry.method === 'calls.realtimePull').map((entry) => entry.params.after), [0, 3]);
  output.currentTime = 0.05;
  pulls.shift()!({ events: [{ seq: 4, type: 'interrupted' }], next: 4 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(output.sources.every((source) => source.stopped));
  assert.deepEqual(calls.find((entry) => entry.method === 'calls.realtimeInterrupt')?.params, { sessionId: 'rts_1', playedMs: 50 });
  pulls.shift()!({ events: [], next: 4, closed: 'The call ended.' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(ended, ['The call ended.']);
  assert.equal(micClosed, true);
  assert.ok(calls.some((entry) => entry.method === 'calls.realtimeClose'));
});

test('pcm helpers: 24 kHz encoding and decoding round-trip', () => {
  const bytes = new Pcm16Encoder(48_000, 24_000).push(new Float32Array([0, 0, 0.5, 0.5, -0.5, -0.5]));
  assert.equal(bytes.length, 6);
  assert.deepEqual([...pcm16ToFloat(bytes)].map((value) => Math.round(value * 100) / 100), [0, 0.5, -0.5]);
});
