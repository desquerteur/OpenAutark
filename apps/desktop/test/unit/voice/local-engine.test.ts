// B-047 D14 local speech engine (src/runtime/voice/local/engine.ts, addon.ts) with a fake addon: one lazy
// load per model even for parallel calls, calls in turn, idle unload that really lets go of the native
// model (regression: the idle timer's closure kept it alive, 411 MB stayed resident), the memory gate (idle
// models of the other purpose go first, then a clear refusal), Canary's language switch, VAD utterances and
// quiet cuts, words with times and token probabilities, punctuation spacing, the voice's speaker and
// language, and the user-safe error when Windows blocks the native files (Smart App Control).
// Owns: these assertions only. Never: the real addon or a model file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localSpeechModel, SILERO_VAD } from '../../../src/shared/model/local-speech-models.ts';
import { LocalSpeechEngine, tidy, wordsOf } from '../../../src/runtime/voice/local/engine.ts';
import { quietCuts } from '../../../src/runtime/voice/local/segments.ts';
import { loadError, recognizerConfig, requireAddon, resetSherpa, RETRY_MS, sherpa, threadsFor } from '../../../src/runtime/voice/local/addon.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fakeAddon, installFake, quietLog, tempData, type FakeResult } from './local-fixture.ts';

const CANARY = localSpeechModel('canary-180m-flash-int8', 'stt')!;
const PARAKEET = localSpeechModel('parakeet-tdt-0.6b-v3-int8', 'stt')!;
const VOICE = localSpeechModel('supertonic-3-int8', 'tts')!;
const second = (seconds: number, value = 0.1) => ({ samples: new Float32Array(Math.round(16_000 * seconds)).fill(value), sampleRate: 16_000 });

function engine(options: { free?: () => number; idleMs?: number; result?: FakeResult; vad?: boolean } = {}) {
  const data = tempData();
  installFake(data.dir, CANARY);
  installFake(data.dir, PARAKEET);
  installFake(data.dir, VOICE);
  if (options.vad) installFake(data.dir, SILERO_VAD);
  const fake = fakeAddon({ result: options.result });
  let collected = 0;
  const speech = new LocalSpeechEngine({ dataDir: () => data.dir, log: quietLog, addon: () => fake.addon, freeMemoryMb: options.free ?? (() => 4_000), cpuCores: () => 8, idleMs: options.idleMs ?? 60_000, collect: () => { collected++; } });
  return { speech, fake, data, collected: () => collected };
}

test('one lazy load per model for parallel calls; the calls run one at a time', async () => {
  const t = engine();
  try {
    assert.deepEqual(t.speech.resident(), []);
    const results = await Promise.all([1, 2, 3].map((n) => t.speech.transcribe(CANARY, second(n), 'de')));
    assert.equal(t.fake.state.recognizers.length, 1, 'loaded once');
    assert.equal(t.fake.state.maxActive, 1, 'decodes in turn');
    assert.deepEqual(results.map((r) => r.text), ['heard 16000', 'heard 32000', 'heard 48000']);
    assert.deepEqual(t.speech.resident(), [CANARY.id]);
    const config = t.fake.state.recognizers[0].config as { modelConfig: { numThreads: number; canary: { srcLang: string } } };
    assert.equal(config.modelConfig.numThreads, 4);
    assert.equal(config.modelConfig.canary.srcLang, 'de');
  } finally { t.data.done(); }
});

test('idle unload drops the model, clears its native handle and collects (regression: memory stayed resident)', async () => {
  const t = engine({ idleMs: 15 });
  try {
    await t.speech.transcribe(CANARY, second(1), 'de');
    assert.deepEqual(t.speech.resident(), [CANARY.id]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(t.speech.resident(), []);
    assert.equal(t.collected(), 1);
    await t.speech.transcribe(CANARY, second(1), 'de');
    assert.equal(t.fake.state.recognizers.length, 2, 'the next use loads it again');
  } finally { t.data.done(); }
});

test('memory gate: idle models of other ids go first; a small model always loads (B-058 G4), a large one only far below its estimate is refused', async () => {
  let free = 4_000;
  const t = engine({ free: () => free });
  try {
    await t.speech.synthesize(VOICE, 'Hallo', { language: 'de' });
    assert.deepEqual(t.speech.resident(), [VOICE.id]);
    free = 1_000; // less than Parakeet's 1100 MB: the idle voice is unloaded before Parakeet loads
    await t.speech.transcribe(PARAKEET, second(1), 'de');
    assert.deepEqual(t.speech.resident(), [PARAKEET.id]);
    assert.equal(t.collected(), 1);
    t.speech.unloadIdle();
    free = 105; // measured on the reference PC (regression: Canary was refused at 105 MB "free" – Windows' available memory)
    assert.equal((await t.speech.transcribe(CANARY, second(1), 'de')).text, 'heard 16000', 'a small model pages in');
    t.speech.unloadIdle();
    free = 300; // Parakeet: 1100 MB × 0.25 = 275 MB – 300 MB still loads
    await t.speech.transcribe(PARAKEET, second(1), 'de');
    t.speech.unloadIdle();
    free = 200;
    await assert.rejects(t.speech.transcribe(PARAKEET, second(1), 'de'), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable'
      && error.details?.memory === true && /Not enough free memory for Parakeet TDT 0.6B v3: it needs about 1100 MB, 200 MB are free/.test(error.message));
  } finally { t.data.done(); }
});

test('Canary switches its language in place; a model that is not downloaded is a clear error', async () => {
  const t = engine();
  try {
    await t.speech.transcribe(CANARY, second(1), 'de');
    await t.speech.transcribe(CANARY, second(1), 'en');
    const recognizer = t.fake.state.recognizers[0];
    assert.equal(recognizer.setConfigs, 1);
    assert.equal((recognizer.config as { modelConfig: { canary: { srcLang: string; tgtLang: string } } }).modelConfig.canary.tgtLang, 'en');
    const empty = tempData();
    const other = new LocalSpeechEngine({ dataDir: () => empty.dir, log: quietLog, addon: () => t.fake.addon, freeMemoryMb: () => 4_000 });
    await assert.rejects(other.transcribe(CANARY, second(1), 'de'), /Canary 180M Flash is not downloaded on this PC/);
    empty.done();
  } finally { t.data.done(); }
});

test('with Silero VAD (B-058 G5): a short take goes whole with its silence trimmed – Canary unpadded, a transducer padded; silence alone is no words', async () => {
  const t = engine({ vad: true, result: (wave) => ({ text: `part ${wave.samples.length}` }) });
  try {
    const samples = new Float32Array(16_000 * 4);
    samples.fill(0.2, 8_000, 16_000); // 0.5 … 1 s
    samples.fill(0.2, 32_000, 40_000); // 2 … 2.5 s
    const heard = await t.speech.transcribe(CANARY, { samples, sampleRate: 16_000 }, 'de');
    assert.equal(heard.text, 'part 32000', 'one piece from the first to the last word (regression: every VAD segment was punctuated on its own)');
    assert.deepEqual(heard.segments.map((segment) => [segment.start, segment.end]), [[0.5, 2.5]]);
    const padded = await t.speech.transcribe(PARAKEET, { samples, sampleRate: 16_000 }, 'de');
    assert.deepEqual(padded.segments.map((segment) => [segment.start, Math.round(segment.end * 100) / 100]), [[0.2, 2.8]], '0.3 s around the speech');
    const silence = await t.speech.transcribe(CANARY, { samples: new Float32Array(16_000), sampleRate: 16_000 }, 'de');
    assert.deepEqual(silence, { text: '', segments: [], words: [] });
    const resampled = await t.speech.transcribe(CANARY, { samples: new Float32Array(48_000).fill(0.2), sampleRate: 48_000 }, 'de');
    assert.equal(resampled.text, 'part 16000', '48 kHz arrives at the recognizer as 16 kHz');
    await assert.rejects(t.speech.transcribe(VOICE, second(1), 'de'), /is no speech-to-text model/);
  } finally { t.data.done(); }
});

test('with Silero VAD: a long take is packed into chunks of at most 20 s, cut at its longest pauses', async () => {
  const t = engine({ vad: true, result: (wave) => ({ text: `part ${wave.samples.length / 16_000}` }) });
  try {
    const samples = new Float32Array(16_000 * 45);
    const speak = (from: number, to: number) => samples.fill(0.2, from * 16_000, to * 16_000);
    speak(0, 9); speak(9.5, 18); // a short pause at 9 s
    speak(20, 30); speak(30.4, 40); // the longest pause: 18 … 20 s
    const heard = await t.speech.transcribe(CANARY, { samples, sampleRate: 16_000 }, 'de');
    assert.deepEqual(heard.segments.map((segment) => [segment.start, segment.end]), [[0, 18], [20, 40]]);
    assert.equal(heard.text, 'part 18 part 20');
  } finally { t.data.done(); }
});

test('without VAD: short takes go whole, long ones are cut at their quietest moment', () => {
  const samples = new Float32Array(16_000 * 30).fill(0.3);
  samples.fill(0, 16_000 * 18, 16_000 * 18 + 800); // a pause at 18 s
  const parts = quietCuts(samples);
  assert.equal(parts.length, 2);
  assert.ok(Math.abs(parts[1].start / 16_000 - 18) < 0.06, `cut near the pause, at ${parts[1].start / 16_000}`);
  assert.equal(quietCuts(new Float32Array(16_000 * 5)).length, 1);
});

test('words from tokens: word starts, pieces, punctuation, times and the weakest token probability', () => {
  const words = wordsOf({ tokens: ['▁Hal', 'lo', '▁Gerd', ',', '▁ja'], timestamps: [0, 0.2, 0.5, 0.8, 1.0], durations: [0.2, 0.2, 0.3, 0.1, 0.2], ys_log_probs: [-0.1, -0.2, -2, -0.1, -0.05] }, 10);
  assert.deepEqual(words.map((word) => word.text), ['Hallo', 'Gerd,', 'ja']);
  assert.deepEqual([words[0].start, Math.round(words[0].end * 100) / 100], [10, 10.4]);
  assert.ok(Math.abs(words[1].confidence! - Math.exp(-2)) < 1e-9);
  assert.deepEqual(wordsOf({ tokens: ['a'], timestamps: [] }, 0), [], 'no times, no words');
  assert.equal(tidy('Hallo gell . Wie geht es ?  Gut ,  danke', 'de'), 'Hallo gell. Wie geht es? Gut, danke');
  assert.equal(tidy('Bonjour , ça va ?', 'fr'), 'Bonjour, ça va ?', 'French keeps its space before ?');
});

test('the voice: speaker clamped to the model, language and steps passed; recognizer configs per kind', async () => {
  const t = engine();
  try {
    const audio = await t.speech.synthesize(VOICE, 'Guten Morgen.', { sid: 42, language: 'de' });
    assert.equal(audio.sampleRate, 44_100);
    const request = t.fake.state.tts[0].requests[0];
    assert.equal(request.sid, 9, 'ten speakers: 0 … 9');
    assert.deepEqual(request.config.extra, { lang: 'de' });
    const transducer = recognizerConfig(PARAKEET, '/m', 2, 'de') as { modelConfig: { modelType: string; transducer: { joiner: string } } };
    assert.equal(transducer.modelConfig.modelType, 'nemo_transducer');
    assert.match(transducer.modelConfig.transducer.joiner, /joiner\.int8\.onnx$/);
    assert.deepEqual([threadsFor(1), threadsFor(4), threadsFor(32)], [1, 2, 4]);
  } finally { t.data.done(); }
});

test('a native load Windows blocks becomes one clear sentence, remembered for a while', () => {
  resetSherpa();
  const blocked = loadError(Object.assign(new Error('An Application Control policy has blocked this file.'), { code: 'ERR_DLOPEN_FAILED' }));
  assert.match(blocked.message, /Windows blocked the local speech engine \(Smart App Control/);
  assert.equal(loadError(new Error('Cannot find module')).message, 'The local speech engine could not be loaded on this PC.');
  let tries = 0;
  const failing = () => { tries++; throw new Error('An Application Control policy has blocked this file.'); };
  assert.throws(() => sherpa(1_000, failing), /Windows blocked/);
  assert.throws(() => sherpa(2_000, failing), /Windows blocked/);
  assert.equal(tries, 1, 'not tried again right away');
  const fake = fakeAddon().addon;
  assert.equal(sherpa(1_000 + RETRY_MS, () => fake), fake, 'tried again after RETRY_MS');
  resetSherpa();
});

test("the package's swallowed native error is recovered from the platform binary (review fix: a block read as missing)", () => {
  resetSherpa();
  const asked: string[] = [];
  const req = (id: string) => {
    asked.push(id);
    if (id === 'sherpa-onnx-node') throw new Error('Could not find sherpa-onnx-node. Tried\n\n  ./sherpa-onnx.node\n');
    throw Object.assign(new Error('An Application Control policy has blocked this file.'), { code: 'ERR_DLOPEN_FAILED' });
  };
  assert.throws(() => sherpa(1_000, () => requireAddon(req)), /Windows blocked the local speech engine/);
  assert.equal(asked[0], 'sherpa-onnx-node');
  assert.match(asked[1], /^sherpa-onnx-[a-z0-9]+-[a-z0-9]+\/sherpa-onnx\.node$/);
  resetSherpa();
  const missing = (id: string) => { throw new Error(id === 'sherpa-onnx-node' ? 'Could not find sherpa-onnx-node.' : 'Cannot find module'); };
  assert.throws(() => sherpa(1_000, () => requireAddon(missing)), /could not be loaded on this PC/);
  resetSherpa();
  const fake = fakeAddon().addon;
  assert.equal(requireAddon((id) => { if (id !== 'sherpa-onnx-node') throw new Error('not asked'); return fake; }), fake);
});
