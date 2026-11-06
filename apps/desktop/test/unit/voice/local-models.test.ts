// B-047 D14 catalog and fit (src/shared/model/local-speech-models.ts). The settings that hold the choice
// (voice.localStt / localTts) are the settings tests' part.
// Owns: these assertions only. Never: downloads or the native addon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLocalSpeech, localSpeechIds, localSpeechModel, LOCAL_SPEECH_MODELS, SILERO_VAD } from '../../../src/shared/model/local-speech-models.ts';

test('the catalog: unique ids, pinned HTTPS release downloads with SHA-256, German in every model, licences, no Kokoro', () => {
  const all = [...LOCAL_SPEECH_MODELS, SILERO_VAD];
  assert.equal(new Set(all.map((model) => model.id)).size, all.length);
  for (const model of all) {
    assert.match(model.download.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/(asr|tts)-models\//, model.id);
    assert.match(model.download.sha256, /^[0-9a-f]{64}$/, model.id);
    assert.ok(model.download.bytes > 100_000, model.id);
    assert.ok(model.licence && model.licenceUrl.startsWith('https://'), model.id);
    assert.ok(model.files.length > 0 && model.ramMb > 0 && model.sizeMb > 0, model.id);
    if (model.download.format === 'tar.bz2') assert.ok(model.download.url.endsWith(`${model.download.folder}.tar.bz2`), model.id);
  }
  for (const model of LOCAL_SPEECH_MODELS) assert.ok(model.languages.includes('de'), `${model.id} speaks German`);
  for (const model of LOCAL_SPEECH_MODELS.filter((entry) => entry.id !== 'fastconformer-de-int8')) assert.ok(model.languages.includes('en'), `${model.id} speaks English`);
  assert.ok(!all.some((model) => /kokoro|piper|whisper/i.test(model.id)), 'no Kokoro (no German), no Piper (needs the GPL phonemizer sherpa-onnx 2.0 removed), no Whisper (slower than real time here)');
  assert.deepEqual(localSpeechIds('stt'), ['fastconformer-de-int8', 'canary-180m-flash-int8', 'parakeet-tdt-0.6b-v3-int8']);
  const german = localSpeechModel('fastconformer-de-int8', 'stt')!;
  assert.deepEqual([german.kind, german.download.folder, german.download.sha256, german.download.bytes], ['nemo-transducer', 'sherpa-onnx-nemo-transducer-stt_de_fastconformer_hybrid_large_pc-int8', '73b3cce9f94a19fc04bc54b55abd576b622e3925a84ddd554a95e5984bc11677', 108_124_747]);
  assert.deepEqual(german.files, ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
  assert.deepEqual(localSpeechIds('tts'), ['supertonic-3-int8']);
  assert.equal(localSpeechModel('supertonic-3-int8', 'stt'), undefined, 'the purpose narrows');
  assert.equal(localSpeechModel('silero-vad')?.purpose, 'vad');
});

const pc = (totalRamMb: number, freeRamMb: number, cpuCores: number) => ({ totalRamMb, freeRamMb, cpuCores });
const picked = (rows: ReturnType<typeof fitLocalSpeech>, purpose: 'stt' | 'tts') => rows.filter((row) => row.purpose === purpose && row.recommended).map((row) => row.id);

test('fit (B-058 G2): the 7.9 GB reference PC gets FastConformer for German and Canary for English; the measured model beats a bigger tier', () => {
  const reference = fitLocalSpeech(pc(7_916, 700, 8), 'de');
  assert.deepEqual(picked(reference, 'stt'), ['fastconformer-de-int8']);
  assert.equal(reference.find((row) => row.id === 'parakeet-tdt-0.6b-v3-int8')?.fit, 'tight');
  assert.deepEqual(picked(reference, 'tts'), ['supertonic-3-int8']);
  assert.deepEqual(picked(fitLocalSpeech(pc(7_916, 700, 8), 'en-GB'), 'stt'), ['canary-180m-flash-int8']);
  assert.deepEqual(picked(fitLocalSpeech(pc(7_916, 700, 8), 'fr'), 'stt'), ['canary-180m-flash-int8'], 'only Canary of the tiny ones speaks French');
  const roomy = fitLocalSpeech(pc(32_768, 20_000, 16), 'de');
  assert.deepEqual(picked(roomy, 'stt'), ['fastconformer-de-int8'], 'measured best for German, even where Parakeet fits');
  assert.deepEqual(picked(fitLocalSpeech(pc(32_768, 20_000, 16), 'it'), 'stt'), ['parakeet-tdt-0.6b-v3-int8']);
  assert.deepEqual(picked(fitLocalSpeech(pc(32_768, 20_000, 2), 'it'), 'stt'), ['parakeet-tdt-0.6b-v3-int8'], 'tight but the only one that speaks Italian');
  assert.deepEqual(picked(fitLocalSpeech(pc(7_916, 700, 8), 'ja'), 'stt'), ['canary-180m-flash-int8'], 'nobody speaks Japanese: the tiny model with the most languages');
  const tiny = fitLocalSpeech(pc(4_096, 1_000, 2), 'de');
  assert.ok(tiny.every((row) => row.fit === 'too-big' && !row.recommended), 'nothing fits a 4 GB PC');
});

test('fit: a language the tiny models lack recommends the model that speaks it; rows keep the catalog order', () => {
  const italian = fitLocalSpeech(pc(8_192, 1_700, 8), 'it-IT');
  assert.deepEqual(picked(italian, 'stt'), ['parakeet-tdt-0.6b-v3-int8'], 'no tiny model has Italian, Parakeet fits tight and speaks it');
  const rows = fitLocalSpeech(pc(8_192, 1_700, 8), 'de', (id) => id === 'canary-180m-flash-int8');
  assert.deepEqual(rows.filter((row) => row.installed).map((row) => row.id), ['canary-180m-flash-int8']);
  assert.deepEqual(rows.map((row) => row.downloadMb), [108, 154, 487, 129]);
});
