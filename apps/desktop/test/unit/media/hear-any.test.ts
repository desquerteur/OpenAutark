// B-058 F0: runtime/media/hear-any.ts – WAV decoded locally with its span, other formats only through the
// host's media.audio, and hearable() as the one format/length gate. (T2 extends these with the real host op.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hearable, hearFormat, pcmOf, type HearServices } from '../../../src/runtime/media/hear-any.ts';
import { AUDIO_DECODE_LIMITS } from '../../../src/shared/api/host-bridge.ts';
import { encodeWav, pcm16Bytes } from '../../../src/shared/voice/wav.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

function services(files: Record<string, { mime: string; name: string; bytes: Uint8Array }>, audio?: NonNullable<HearServices['host']['media']>['audio']): HearServices {
  return {
    files: {
      get: (id: string) => (files[id] ? { id, name: files[id].name, mime: files[id].mime, size: files[id].bytes.byteLength, createdAt: 0 } : undefined),
      read: async (id: string) => files[id].bytes,
    },
    host: { media: audio ? { keyframes: async () => { throw new Error('unused'); }, audio } : undefined },
  } as unknown as HearServices;
}

test('a 48 kHz WAV is resampled to 16 kHz; the span is cut and partial says the sound goes on', async () => {
  const samples = new Float32Array(48_000 * 3).map((_, index) => Math.sin(index / 10) * 0.5); // 3 s
  const s = services({ a: { mime: 'audio/wav', name: 'a.wav', bytes: encodeWav(samples, 48_000) } });
  const whole = await pcmOf(s, 'a');
  assert.equal(whole.sampleRate, 16_000);
  assert.equal(whole.durationMs, 3000);
  assert.ok(Math.abs(whole.samples.length - 48_000) <= 2);
  assert.equal(whole.partial, false);
  const part = await pcmOf(s, 'a', { startMs: 1000, maxMs: 1000 });
  assert.ok(Math.abs(part.samples.length - 16_000) <= 2);
  assert.equal(part.startMs, 1000);
  assert.equal(part.partial, true);
});

test('compressed formats go to the host media.audio; without it a clear unavailable error', async () => {
  const pcm = pcm16Bytes(new Float32Array(1600).fill(0.25));
  const asked: unknown[] = [];
  const s = services({ v: { mime: 'video/quicktime', name: 'clip.mov', bytes: new Uint8Array(4) } }, async (input) => {
    asked.push(input);
    return { sampleRate: 16_000, pcm, durationMs: 90_000, startMs: 0, partial: true };
  });
  const heard = await pcmOf(s, 'v', { maxMs: 10 * 60 * 60_000 });
  assert.deepEqual(asked, [{ fileId: 'v', mime: 'video/quicktime', startMs: 0, maxMs: AUDIO_DECODE_LIMITS.maxMs }], 'maxMs is capped');
  assert.equal(heard.samples.length, 1600);
  assert.ok(Math.abs(heard.samples[0] - 0.25) < 0.001);
  assert.equal(heard.partial, true);
  const none = services({ v: { mime: 'audio/mpeg', name: 'a.mp3', bytes: new Uint8Array(4) } });
  await assert.rejects(pcmOf(none, 'v'), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
  await assert.rejects(pcmOf(none, 'missing'), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
});

test('hearable: WAV always, browser formats with a decoding host, amr/wma never; long files are partial', () => {
  assert.equal(hearFormat('audio/wav', 'a.wav'), 'wav');
  assert.equal(hearFormat('audio/L16;rate=16000', ''), 'pcm');
  for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg; codecs=opus', 'audio/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska']) assert.equal(hearFormat(mime), 'host', mime);
  assert.equal(hearFormat('application/octet-stream', 'take.m4a'), 'host');
  for (const mime of ['audio/amr', 'audio/x-ms-wma', 'video/x-msvideo', 'image/png']) assert.equal(hearFormat(mime, 'x'), undefined, mime);
  assert.deepEqual(hearable({ mime: 'audio/wav', name: 'a.wav' }, false), { ok: true });
  assert.equal(hearable({ mime: 'audio/mpeg' }, false).ok, false);
  assert.deepEqual(hearable({ mime: 'audio/mpeg', durationMs: 60_000 }, true), { ok: true });
  assert.deepEqual(hearable({ mime: 'video/mp4', durationMs: 62 * 60_000 }, true), { ok: true, partial: true, note: 'only the first 20 minutes of this 62-minute recording are heard' });
  assert.equal(hearable({ mime: 'audio/amr' }, true).ok, false);
});
