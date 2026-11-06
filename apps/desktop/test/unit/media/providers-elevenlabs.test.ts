// B-058 T6: the ElevenLabs adapter against a fake server answering like the documented API
// (elevenlabs.io/docs/api-reference, 29.10.2026): text to speech, sound effects and music – xi-api-key,
// output_format in the query, the audio file as the answer – plus its errors and list prices.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOICE, elevenlabsAdapter } from '../../../src/runtime/media/providers/elevenlabs.ts';
import { generationPhase, mayFallBack } from '../../../src/runtime/media/generate-http.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ctx, fakeServer, KEY, MP3, send, target, WAV, type Handler } from './providers-fixture.ts';

const servers: Array<{ close(): Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

async function eleven(handle: Handler) {
  const server = await fakeServer(handle);
  servers.push(server);
  return { ...server, on: (model: string, key = KEY) => target('elevenlabs', `${server.origin}/v1`, model, key) };
}

test('kinds: the curated models and their families', () => {
  assert.deepEqual(elevenlabsAdapter.kinds('eleven_v4'), ['speech']);
  assert.deepEqual(elevenlabsAdapter.kinds('eleven_flash_v2_5'), ['speech']);
  assert.deepEqual(elevenlabsAdapter.kinds('eleven_text_to_sound_v2'), ['sound']);
  assert.deepEqual(elevenlabsAdapter.kinds('music_v2_5'), ['music']);
  assert.deepEqual(elevenlabsAdapter.kinds('eleven_multilingual_sts_v2'), []);
  assert.deepEqual(elevenlabsAdapter.kinds('scribe_v2'), []);
});

test('speech: POST /text-to-speech/{voice} with xi-api-key, the default voice, language and MP3', async () => {
  const s = await eleven((request, res) => send(res, 200, MP3, 'audio/mpeg'));
  const made = await elevenlabsAdapter.generate('speech', { prompt: 'x', text: 'Guten Tag', language: 'de', voice: 'Rachel' }, s.on('eleven_v4'), ctx());
  assert.deepEqual([made.mime, made.extension, made.meta?.voice], ['audio/mpeg', 'mp3', 'George (default)']);
  const [call] = s.seen;
  assert.equal(call.path, `/v1/text-to-speech/${DEFAULT_VOICE}?output_format=mp3_44100_128`);
  assert.equal(call.headers['xi-api-key'], KEY);
  assert.equal(call.headers.authorization, undefined);
  assert.deepEqual(call.json, { text: 'Guten Tag', model_id: 'eleven_v4', language_code: 'de' });
});

test('speech: a voice id and WAV (24 kHz – 44.1 kHz needs the Pro plan); multilingual_v2 gets no language_code', async () => {
  const s = await eleven((request, res) => send(res, 200, WAV, 'audio/wav'));
  const made = await elevenlabsAdapter.generate('speech', { prompt: 'Hallo', format: 'wav', language: 'de', voice: 'EXAVITQu4vr4xnSDxMaL' }, s.on('eleven_multilingual_v2'), ctx());
  assert.equal(made.mime, 'audio/wav');
  assert.equal(s.seen[0].path, '/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=wav_24000');
  assert.deepEqual(s.seen[0].json, { text: 'Hallo', model_id: 'eleven_multilingual_v2' });
});

test('sound effects: POST /sound-generation; duration clamped to 30 s, loop', async () => {
  const s = await eleven((request, res) => send(res, 200, MP3, 'audio/mpeg'));
  const made = await elevenlabsAdapter.generate('sound', { prompt: 'rain on a tin roof', durationS: 45, loop: true }, s.on('eleven_text_to_sound_v2'), ctx());
  assert.equal(made.mime, 'audio/mpeg');
  assert.equal(s.seen[0].path, '/v1/sound-generation?output_format=mp3_44100_128');
  assert.deepEqual(s.seen[0].json, { text: 'rain on a tin roof', model_id: 'eleven_text_to_sound_v2', duration_seconds: 30, loop: true });
});

test('music: POST /music with the length in ms and the lyrics in the prompt; instrumental forces no vocals', async () => {
  const s = await eleven((request, res) => send(res, 200, MP3, 'audio/mpeg'));
  await elevenlabsAdapter.generate('music', { prompt: 'German indie pop', lyrics: '[Verse]\nSonne', durationS: 90 }, s.on('music_v2_5'), ctx());
  assert.equal(s.seen[0].path, '/v1/music?output_format=mp3_44100_128');
  assert.deepEqual(s.seen[0].json, { prompt: 'German indie pop\n\nLyrics:\n[Verse]\nSonne', model_id: 'music_v2_5', music_length_ms: 90_000 });
  await elevenlabsAdapter.generate('music', { prompt: 'lofi beat', lyrics: 'ignored', instrumental: true, durationS: 1 }, s.on('music_v2_5'), ctx());
  assert.deepEqual(s.seen[1].json, { prompt: 'lofi beat', model_id: 'music_v2_5', music_length_ms: 3_000, force_instrumental: true });
});

test('errors: 401, 402, 429 and 422 map to safe messages; a JSON answer is no audio; no key sends nothing', async () => {
  const statuses = [401, 402, 429, 422];
  const s = await eleven((request, res) => (statuses.length
    ? send(res, statuses.shift()!, { detail: { type: 'x', code: 'x', message: 'SECRET BODY' } })
    : send(res, 200, { detail: 'not audio' })));
  const run = () => elevenlabsAdapter.generate('speech', { prompt: 'x' }, s.on('eleven_v4'), ctx());
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /Reconnect/.test(error.message) && mayFallBack(error));
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && /no credit/.test(error.message));
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && error.code === 'rate_limited');
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && !/SECRET/.test(error.message));
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && /returned no audio/.test(error.message) && generationPhase(error) === 'answered');
  const before = s.seen.length;
  await assert.rejects(elevenlabsAdapter.generate('speech', { prompt: 'x' }, s.on('eleven_v4', ''), ctx()), (error: unknown) => mayFallBack(error));
  assert.equal(s.seen.length, before);
  await assert.rejects(elevenlabsAdapter.generate('video', { prompt: 'x' }, s.on('eleven_v4'), ctx()), (error: unknown) => mayFallBack(error));
});

test('deadline and stop: a song that never comes ends as a timeout at phase sent; the run stop as cancelled; the key stays in its header', async () => {
  const s = await eleven(() => { /* never answers: composing takes long */ });
  const started = Date.now();
  await assert.rejects(elevenlabsAdapter.generate('music', { prompt: 'x' }, s.on('music_v2_5'), ctx(300)),
    (error: unknown) => error instanceof WorkforceError && error.code === 'timeout' && generationPhase(error) === 'sent' && !error.message.includes(KEY));
  assert.ok(Date.now() - started < 3_000, 'the deadline ended the call');
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100).unref();
  await assert.rejects(elevenlabsAdapter.generate('sound', { prompt: 'x' }, s.on('eleven_text_to_sound_v2'), ctx(10_000, stop.signal)),
    (error: unknown) => error instanceof WorkforceError && error.code === 'cancelled');
  for (const seen of s.seen) {
    assert.equal(seen.headers['xi-api-key'], KEY);
    assert.ok(!seen.path.includes(KEY));
  }
});

test('estimateUsd: $0.08 per 1K characters (Flash $0.04), sound effects $0.12, music $0.15 per started minute', () => {
  assert.equal(elevenlabsAdapter.estimateUsd('speech', { prompt: 'x', text: 'a'.repeat(2000) }, 'eleven_v4'), 0.16);
  assert.equal(elevenlabsAdapter.estimateUsd('speech', { prompt: 'a'.repeat(1000) }, 'eleven_flash_v2_5'), 0.04);
  assert.equal(elevenlabsAdapter.estimateUsd('sound', { prompt: 'x' }, 'eleven_text_to_sound_v2'), 0.12);
  assert.equal(elevenlabsAdapter.estimateUsd('music', { prompt: 'x', durationS: 90 }, 'music_v2_5'), 0.3);
  assert.equal(elevenlabsAdapter.estimateUsd('music', { prompt: 'x' }, 'music_v2_5'), 0.15 * 5, 'no length: the model picks it – priced at the 5-minute maximum');
});
