// B-058 T2 review fix: a WAV (or raw PCM16) file over WHOLE_BYTES is never read whole into the runtime –
// only its header and the span's frames, mixed down in pieces – and gives exactly what the whole read gives:
// a 24-bit stereo 48 kHz WAV with a LIST chunk before its sound, whole and in spans, raw PCM16, a header the
// reader does not know.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pcmOf, WHOLE_BYTES, type HearServices } from '../../../src/runtime/media/hear-any.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { tempDir } from '../store/helpers.ts';

const RATE = 48_000;

/** A 24-bit stereo WAV of `seconds` with a LIST chunk of `listBytes` before the data chunk. */
function wav24(seconds: number, listBytes = 26): Uint8Array {
  const frames = seconds * RATE;
  const data = frames * 6;
  const out = new Uint8Array(12 + 24 + 8 + listBytes + 8 + data);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < 4; i++) out[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, out.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 6, true); view.setUint16(32, 6, true); view.setUint16(34, 24, true);
  text(36, 'LIST'); view.setUint32(40, listBytes, true);
  const at = 44 + listBytes;
  text(at, 'data'); view.setUint32(at + 4, data, true);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const value = Math.round(Math.sin((frame * (channel + 1)) / 37) * 0.4 * 8_388_607);
      const offset = at + 8 + frame * 6 + channel * 3;
      out[offset] = value & 0xff; out[offset + 1] = (value >> 8) & 0xff; out[offset + 2] = (value >> 16) & 0xff;
    }
  }
  return out;
}

/** A store holding one file at `file`; `size` is what the store says (large: read in spans), reads are counted. */
function store(file: string, bytes: Uint8Array, mime: string, size: number) {
  const reads = { count: 0 };
  const services = {
    files: {
      get: (id: string) => (id === 'f' ? { id, name: path.basename(file), mime, size, createdAt: 0 } : undefined),
      read: async () => { reads.count++; return bytes; },
      path: () => file,
    },
    host: {},
  } as unknown as HearServices;
  return { services, reads };
}

test('a large WAV: only its header and the span are read, in pieces, and the samples equal the whole read', async () => {
  const temp = tempDir('wf-hear-wav-');
  try {
    const bytes = wav24(15); // 4.3 MB: two pieces of 4 MiB
    const file = path.join(temp.dir, 'long.wav');
    writeFileSync(file, bytes);
    const large = store(file, bytes, 'audio/wav', WHOLE_BYTES + 1);
    const small = store(file, bytes, 'audio/wav', bytes.length);
    for (const span of [{}, { startMs: 5000, maxMs: 4000 }, { startMs: 14_000, maxMs: 60_000 }, { startMs: 20_000, maxMs: 1000 }]) {
      const pieces = await pcmOf(large.services, 'f', span);
      const whole = await pcmOf(small.services, 'f', span);
      assert.deepEqual([pieces.durationMs, pieces.startMs, pieces.partial], [whole.durationMs, whole.startMs, whole.partial], JSON.stringify(span));
      assert.equal(pieces.samples.length, whole.samples.length, JSON.stringify(span));
      assert.ok(pieces.samples.every((value, i) => value === whole.samples[i]), `identical samples ${JSON.stringify(span)}`);
    }
    assert.equal(large.reads.count, 0, 'the large file was never read whole');
    const all = await pcmOf(large.services, 'f');
    assert.deepEqual([all.durationMs, all.partial, Math.abs(all.samples.length - 15 * 16_000) <= 2], [15_000, false, true]);
    assert.equal((await pcmOf(large.services, 'f', { startMs: 5000, maxMs: 4000 })).partial, true);
  } finally { temp.cleanup(); }
});

test('large raw PCM16 is read in spans too; a WAV whose sound starts past its first 256 KB is refused clearly', async () => {
  const temp = tempDir('wf-hear-wav-');
  try {
    const samples = Int16Array.from({ length: 16_000 * 4 }, (_, i) => Math.round(Math.sin(i / 9) * 8000));
    const pcm = new Uint8Array(samples.buffer);
    const raw = path.join(temp.dir, 'take.pcm');
    writeFileSync(raw, pcm);
    const heard = await pcmOf(store(raw, pcm, 'audio/L16;rate=16000', WHOLE_BYTES + 1).services, 'f', { startMs: 1000, maxMs: 2000 });
    assert.deepEqual([heard.durationMs, heard.samples.length, heard.partial], [4000, 32_000, true]);
    assert.ok(Math.abs(heard.samples[0] - samples[16_000] / 32768) < 1e-6, 'the span starts at 1 s');

    const late = wav24(1, 300 * 1024);
    const file = path.join(temp.dir, 'late.wav');
    writeFileSync(file, late);
    await assert.rejects(pcmOf(store(file, late, 'audio/wav', WHOLE_BYTES + 1).services, 'f'),
      (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && /does not start in its first 256 KB/.test(error.message));
    const gone = store(path.join(temp.dir, 'missing.wav'), late, 'audio/wav', WHOLE_BYTES + 1);
    await assert.rejects(pcmOf(gone.services, 'f'), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found' && !/missing\.wav|[A-Z]:\\/.test(error.message));
  } finally { temp.cleanup(); }
});
