// B-058 the local voice gives up quickly (src/runtime/voice/local/engine.ts synthesize, service.ts speak): sherpa's
// generateAsync cannot be cancelled, so a line is spoken in sentence-sized pieces, each its own turn in the model's
// queue – a call that waits gets in after the piece in progress, and once the caller's signal aborted (its stop or
// deadline) no further piece starts and the call rejects 'cancelled' (regression: a timed-out media.speak kept
// synthesizing its whole line and held the voice for the next call).
// Owns: these assertions only. Never: the real addon or a model file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { SherpaAddon } from '../../../src/runtime/voice/local/addon.ts';
import { LocalSpeechEngine, SPEAK_PIECE_CHARS, speechPieces } from '../../../src/runtime/voice/local/engine.ts';
import { LocalSpeech } from '../../../src/runtime/voice/local/service.ts';
import { localSpeechModel } from '../../../src/shared/model/local-speech-models.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { installFake, quietLog, tempData } from './local-fixture.ts';

const VOICE = localSpeechModel('supertonic-3-int8', 'tts')!;
const SENTENCE = 'This sentence is spoken by the local voice of this PC, one piece at a time. ';

/** A voice whose generateAsync records the text, calls `onSpeak` and answers one sample per character after a tick. */
function voice(onSpeak: (text: string) => void = () => {}) {
  const spoken: string[] = [];
  class GenerationConfig { constructor(options: Record<string, unknown>) { Object.assign(this, options); } }
  const addon = {
    OfflineTts: {
      async createAsync() {
        return {
          sampleRate: 24_000, numSpeakers: 1,
          async generateAsync(request: { text: string }) {
            spoken.push(request.text);
            onSpeak(request.text);
            await new Promise((resolve) => setTimeout(resolve, 2));
            return { samples: new Float32Array(request.text.length), sampleRate: 24_000 };
          },
        };
      },
    },
    GenerationConfig,
  } as unknown as SherpaAddon;
  const data = tempData();
  installFake(data.dir, VOICE);
  const engine = new LocalSpeechEngine({ dataDir: () => data.dir, log: quietLog, addon: () => addon, freeMemoryMb: () => 4_000, idleMs: 60_000 });
  return { engine, spoken, data };
}

test('speechPieces: whole sentences packed up to the bound; a long sentence cut at a space; nothing lost', () => {
  assert.deepEqual(speechPieces('Hallo.'), ['Hallo.']);
  assert.deepEqual(speechPieces('One. Two! Three?', 10), ['One. Two!', 'Three?']);
  const long = SENTENCE.repeat(10).trim();
  const pieces = speechPieces(long);
  assert.ok(pieces.length > 1 && pieces.every((piece) => piece.length <= SPEAK_PIECE_CHARS), pieces.map((piece) => piece.length).join());
  assert.equal(pieces.join(' '), long, 'every word once, in order');
  const run = speechPieces(`${'word '.repeat(100)}end`, 50);
  assert.ok(run.every((piece) => piece.length <= 50 && !piece.startsWith(' ')));
  assert.equal(run.join(' '), `${'word '.repeat(100)}end`);
});

test('a long line is spoken piece by piece and joined; a call that waits gets in after the piece in progress', async () => {
  const t = voice();
  try {
    const text = SENTENCE.repeat(10).trim();
    const pieces = speechPieces(text);
    const first = t.engine.synthesize(VOICE, text, { language: 'en' });
    const second = t.engine.synthesize(VOICE, 'Short line.', { language: 'en' });
    const [long, short] = await Promise.all([first, second]);
    assert.equal(long.samples.length, pieces.reduce((sum, piece) => sum + piece.length, 0), 'all pieces joined');
    assert.equal(long.sampleRate, 24_000);
    assert.equal(short.samples.length, 'Short line.'.length);
    assert.equal(t.spoken.indexOf('Short line.'), 1, 'the waiting call came second, not after the whole long line');
    assert.equal(t.spoken.length, pieces.length + 1);
  } finally { t.data.done(); }
});

test("once the caller's signal aborts no further piece is spoken: 'cancelled', and the voice is free at once", async () => {
  const stop = new AbortController();
  const t = voice((text) => { if (text.startsWith('This')) stop.abort(); }); // the caller's deadline fires during the first piece
  try {
    const text = SENTENCE.repeat(10).trim();
    await assert.rejects(t.engine.synthesize(VOICE, text, { language: 'en', signal: stop.signal }), (error: unknown) => error instanceof WorkforceError && error.code === 'cancelled');
    assert.equal(t.spoken.length, 1, `stopped after the piece in progress (of ${speechPieces(text).length})`);
    const next = await t.engine.synthesize(VOICE, 'Next.', { language: 'en' });
    assert.equal(next.samples.length, 5);
    await assert.rejects(t.engine.synthesize(VOICE, 'Never.', { language: 'en', signal: stop.signal }), /Speaking stopped/, 'an aborted signal speaks nothing');
    assert.deepEqual(t.spoken.slice(1), ['Next.']);
  } finally { t.data.done(); }
});

test('voice.speak passes the signal through and frees its slot', async () => {
  const stop = new AbortController();
  const t = voice(() => stop.abort());
  const settings = { profile: { language: 'en' }, voice: { localTts: VOICE.id } };
  const services = { paths: { data: t.data.dir }, log: quietLog, settings: { get: () => settings } } as unknown as RuntimeServices;
  const local = new LocalSpeech({ services: () => services, engine: t.engine, systemLocale: () => 'en-US' });
  try {
    await assert.rejects(local.speak({ text: SENTENCE.repeat(10), signal: stop.signal }), /Speaking stopped/);
    assert.equal(t.spoken.length, 1);
    const spoken = await local.speak({ text: 'Hello.' });
    assert.equal(spoken.sampleRate, 24_000);
  } finally { t.data.done(); }
});
