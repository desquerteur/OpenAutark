// B-058 long recordings in the one transcription service (src/runtime/voice/transcribe.ts, transcribe-endpoint.ts,
// local/service.ts): a take the endpoint cannot take as it is (a format it does not know, over 25 MB) goes up as the
// decoded 16 kHz mono WAV in pieces of at most PIECE_MS cut at a quiet moment, one request each, texts joined; a decode
// that heard only the first part marks the result `partial` and an agent transcript starts with the one note saying
// so (media.transcribe adds no second one); this PC's model hears a WAV over 25 MB by span, never read whole.
// Owns: these assertions only. Never: the real addon, a model, the host's decoder or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { Transcriber, type FetchFn } from '../../../src/runtime/voice/transcribe.ts';
import { partialNote, pieceEnds } from '../../../src/runtime/voice/transcribe-endpoint.ts';
import { LocalSpeech } from '../../../src/runtime/voice/local/service.ts';
import { LocalSpeechEngine } from '../../../src/runtime/voice/local/engine.ts';
import { hearsHere } from '../../../src/runtime/tools/builtin/media-hearing.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { localSpeechModel } from '../../../src/shared/model/local-speech-models.ts';
import { encodeWav } from '../../../src/shared/voice/wav.ts';
import { fakeAddon, installFake, quietLog, tempData, toneWav } from './local-fixture.ts';

const CANARY = localSpeechModel('canary-180m-flash-int8', 'stt')!;
const FILE_ID = 'e'.repeat(64);
const MB = 1024 * 1024;
const MINUTES_45 = 45 * 60_000;

/** `seconds` of a tone at `rate`, silent between `quiet[0]` and `quiet[1]` seconds. */
function tone(seconds: number, rate = 16_000, quiet?: [number, number]): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) {
    const at = i / rate;
    samples[i] = quiet && at >= quiet[0] && at < quiet[1] ? 0 : 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
  }
  return samples;
}

interface Options {
  file: { mime: string; name: string; size: number };
  /** What files.read returns; the host's decode (16 kHz samples, the whole length, whether it goes on). */
  bytes?: Uint8Array; host?: { samples: Float32Array; durationMs: number; partial: boolean };
  /** A downloaded local model chosen (else a connected transcription service); the stored file on disk; the piece length. */
  local?: boolean; filePath?: string; pieceMs?: number;
}

function setup(options: Options) {
  const data = tempData();
  const account = { id: 'acc_1', provider: 'compatible', label: 'Groq', auth: 'api_key', baseUrl: 'https://api.groq.example/v1', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1 };
  const whisper = { id: 'compatible:whisper-1', provider: 'compatible', model: 'whisper-1', name: 'whisper-1', engine: 'compatible', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: ['acc_1'], functions: ['stt'] };
  const decoded: unknown[] = [];
  const reads: string[] = [];
  const cached: string[] = [];
  const decode = options.host;
  const host = decode ? { media: { audio: async (input: unknown) => { decoded.push(input); return { sampleRate: 16_000, pcm: encodeWav(decode.samples, 16_000).subarray(44), durationMs: decode.durationMs, startMs: 0, partial: decode.partial }; } } } : { media: {} };
  const settings = { profile: { language: 'de-DE' }, voice: { vocabulary: [], ...(options.local ? { localStt: CANARY.id } : {}) }, routing: { functions: {} } };
  const services = {
    paths: { data: data.dir, temp: data.dir },
    log: quietLog,
    clock: { now: () => 10 },
    host,
    settings: { get: () => settings, update: () => settings },
    catalog: { list: () => (options.local ? [] : [whisper]) },
    accounts: { get: (id: string) => (id === account.id ? account : undefined), candidates: () => (options.local ? [] : [account]), apiKey: async () => 'sk-long' },
    files: {
      get: (id: string) => (id === FILE_ID ? { id, createdAt: 1, ...options.file } : undefined),
      read: async (id: string) => { reads.push(id); return options.bytes ?? new Uint8Array(5); },
      path: () => options.filePath ?? path.join(data.dir, 'missing'),
    },
    db: { get: () => undefined, run: (_sql: string, params: unknown[]) => { cached.push(String(params?.[0])); } },
  } as unknown as RuntimeServices;
  const bodies: FormData[] = [];
  const fetch: FetchFn = async (_url, init) => { bodies.push(init.body as FormData); return new Response(JSON.stringify({ text: `piece ${bodies.length}` })); };
  let local: LocalSpeech | undefined;
  const fake = fakeAddon({ result: (wave) => ({ text: `local ${wave.samples.length}` }) });
  if (options.local) {
    installFake(data.dir, CANARY);
    const engine = new LocalSpeechEngine({ dataDir: () => data.dir, log: quietLog, addon: () => fake.addon, freeMemoryMb: () => 4_000 });
    local = new LocalSpeech({ services: () => services, engine, systemLocale: () => 'de-AT' });
  }
  const transcriber = new Transcriber({ services: () => services, fetch, local, pieceMs: options.pieceMs, systemLocale: () => 'de-AT' });
  return { transcriber, bodies, decoded, reads, cached, data, fake };
}

/** The uploaded file of a request: name, type, the WAV's sample rate and sample count. */
async function upload(form: FormData) {
  const file = form.get('file') as File;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  return { name: file.name, type: file.type, riff: String.fromCharCode(...bytes.subarray(0, 4)), rate: view.getUint32(24, true), samples: (bytes.byteLength - 44) / 2 };
}

test('a format the endpoint does not take goes up decoded: WAV pieces cut at a quiet moment, one request each, texts joined, partial marked', async () => {
  // 2.5 s with a pause at 0.85–0.9 s; pieces of 1 s look for the quietest 50 ms in their last quarter.
  const t = setup({ file: { mime: 'video/quicktime', name: 'call.mov', size: 3 * MB }, host: { samples: tone(2.5, 16_000, [0.85, 0.9]), durationMs: MINUTES_45, partial: true }, pieceMs: 1_000 });
  try {
    const heard = await t.transcriber.transcribe({ fileId: FILE_ID, language: 'de-DE' });
    assert.equal(heard.text, 'piece 1 piece 2 piece 3');
    assert.deepEqual(heard.partial, { heardMs: 2_500, durationMs: MINUTES_45 }, 'the decode heard only the start');
    assert.deepEqual(t.decoded, [{ fileId: FILE_ID, mime: 'video/quicktime', startMs: 0, maxMs: 20 * 60_000 }], 'decoded once: the first 20 minutes');
    const files = await Promise.all(t.bodies.map(upload));
    assert.deepEqual(files.map((file) => [file.name, file.type, file.riff, file.rate]), [1, 2, 3].map((n) => [`dictation-${n}.wav`, 'audio/wav', 'RIFF', 16_000]));
    assert.ok(files[0].samples >= 0.85 * 16_000 && files[0].samples <= 0.9 * 16_000, `the first piece ends in the pause (${files[0].samples} samples)`);
    assert.ok(files.every((file) => file.samples <= 16_000), 'no piece longer than pieceMs');
    assert.equal(files.reduce((sum, file) => sum + file.samples, 0), 2.5 * 16_000, 'every sample sent once');
    assert.ok(t.bodies.every((body) => body.get('response_format') === 'json' && body.get('language') === 'de'));
  } finally { t.data.done(); }
});

test('an agent transcript heard only in part starts with the one note; media.transcribe adds none of its own', async () => {
  const t = setup({ file: { mime: 'video/quicktime', name: 'call.mov', size: 3 * MB }, host: { samples: tone(1.5), durationMs: MINUTES_45, partial: true } });
  try {
    const text = await t.transcriber.transcript(FILE_ID);
    assert.equal(text, '[Only the first minute of this 45-minute recording is transcribed.]\npiece 1');
    assert.equal(t.bodies[0].get('response_format'), 'json', 'agent hearing stays json');
    assert.deepEqual(t.cached, [text], 'cached with the note: attachments and later readers see it too');
  } finally { t.data.done(); }
  assert.equal(partialNote({ heardMs: 20 * 60_000, durationMs: MINUTES_45 }), '[Only the first 20 minutes of this 45-minute recording are transcribed.]');
  assert.equal(partialNote({ heardMs: 20 * 60_000, durationMs: 0 }), '[Only the first 20 minutes of this recording are transcribed.]');
  const ctx = { services: { host: { media: { audio: async () => undefined } } } } as unknown as ToolContext;
  const long = { mime: 'video/mp4', name: 'call.mp4', durationMs: MINUTES_45 };
  assert.deepEqual(hearsHere(ctx, long, true), { ok: true, partial: true }, 'the speech path: the transcript says it');
  assert.match(String((hearsHere(ctx, long) as { note?: string }).note), /only the first 20 minutes/, 'listen/look keep the length note');
});

test('a WAV over 25 MB goes to the endpoint as the decoded 16 kHz mono WAV, a short one as it is', async () => {
  const big = setup({ file: { mime: 'audio/wav', name: 'long.wav', size: 26 * MB }, bytes: encodeWav(tone(2, 48_000), 48_000) });
  try {
    const heard = await big.transcriber.transcribe({ fileId: FILE_ID });
    assert.equal(heard.text, 'piece 1');
    assert.equal(heard.partial, undefined, 'all of it heard');
    const file = await upload(big.bodies[0]);
    assert.deepEqual([file.name, file.type, file.rate, file.samples], ['dictation.wav', 'audio/wav', 16_000, 32_000], 'resampled 48 → 16 kHz');
  } finally { big.data.done(); }
  const small = setup({ file: { mime: 'audio/wav', name: 'short.wav', size: 1 * MB }, bytes: encodeWav(tone(2, 48_000), 48_000) });
  try {
    await small.transcriber.transcribe({ fileId: FILE_ID });
    assert.equal((await upload(small.bodies[0])).rate, 48_000, 'within 25 MB: the file as it is, in its own quality');
  } finally { small.data.done(); }
});

test("this PC's model hears a WAV over 25 MB by span, never read whole; a decoded 45-minute video is partial", async () => {
  const data = tempData();
  const file = path.join(data.dir, 'long.wav');
  writeFileSync(file, toneWav(1));
  const t = setup({ file: { mime: 'audio/wav', name: 'long.wav', size: 40 * MB }, local: true, filePath: file });
  try {
    const heard = await t.transcriber.transcribe({ fileId: FILE_ID, language: 'de-DE' });
    assert.equal(heard.text, 'local 16000', 'heard by the local model (regression: refused as "smaller than 25 MB")');
    assert.equal(heard.partial, undefined);
    assert.deepEqual(t.reads, [], 'the blob was never read whole');
    assert.equal(t.bodies.length, 0, 'nothing left the PC');
  } finally { t.data.done(); data.done(); }
  const video = setup({ file: { mime: 'video/mp4', name: 'call.mp4', size: 300 * MB }, local: true, host: { samples: tone(1), durationMs: MINUTES_45, partial: true } });
  try {
    const heard = await video.transcriber.transcribe({ fileId: FILE_ID });
    assert.deepEqual([heard.text, heard.partial], ['local 16000', { heardMs: 1_000, durationMs: MINUTES_45 }]);
    assert.match(await video.transcriber.transcript(FILE_ID), /^\[Only the first minute of this 45-minute recording is transcribed\.\]\nlocal 16000$/);
  } finally { video.data.done(); }
});

test('pieceEnds: increasing ends, no piece longer than the bound, the last one takes the rest', () => {
  const samples = tone(10, 1_000);
  const ends = pieceEnds(samples, 1_000, 3_000);
  assert.equal(ends.at(-1), samples.length);
  let from = 0;
  for (const end of ends) { assert.ok(end > from && end - from <= 3_000, `${from} → ${end}`); from = end; }
  assert.deepEqual(pieceEnds(samples, 1_000, 20_000), [samples.length], 'short enough: one piece');
});
