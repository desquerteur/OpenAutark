// B-058 F0: the CED audio tagger in shared/model/local-speech-models.ts – findable by id and purpose,
// never ranked by the fit rule or accepted as a voice setting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_TAGGER, fitLocalSpeech, localSpeechIds, localSpeechModel, LOCAL_TAGGING_MODELS } from '../../../src/shared/model/local-speech-models.ts';

test('the tagger is found by id with purpose tagging, and stays out of the speech lists', () => {
  assert.equal(localSpeechModel('ced-mini', 'tagging'), AUDIO_TAGGER);
  assert.equal(localSpeechModel('ced-mini'), AUDIO_TAGGER);
  assert.equal(localSpeechModel('ced-mini', 'stt'), undefined);
  assert.deepEqual(LOCAL_TAGGING_MODELS, [AUDIO_TAGGER]);
  assert.ok(!localSpeechIds('stt').includes('ced-mini') && !localSpeechIds('tts').includes('ced-mini'));
  assert.ok(!fitLocalSpeech({ totalRamMb: 16_384, freeRamMb: 8_000, cpuCores: 8 }).some((row) => row.id === 'ced-mini'));
});

test('the tagger download is one checked archive with the files the sherpa-onnx AudioTagging config needs', () => {
  const download = AUDIO_TAGGER.download;
  assert.equal(AUDIO_TAGGER.kind, 'ced');
  assert.equal(download.format, 'tar.bz2');
  assert.equal(download.folder, 'sherpa-onnx-ced-mini-audio-tagging-2024-04-19');
  assert.equal(download.url, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2');
  assert.match(download.sha256, /^[0-9a-f]{64}$/);
  assert.equal(download.bytes, 47_658_399);
  assert.deepEqual(AUDIO_TAGGER.files, ['model.int8.onnx', 'class_labels_indices.csv']);
});
