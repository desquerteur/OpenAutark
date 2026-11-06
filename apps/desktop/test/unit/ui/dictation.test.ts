// Dictation, the one path of the desktop and the phone (ui/lib/dictation.ts): the take is the microphone's
// 16 kHz PCM as a WAV, uploaded and heard by voice.transcribe; a newer start ends the older take, a start a
// cancel overtook gives up and closes its microphone, a failed transcription hands a long take back for
// attaching (stored again when the answer was lost with the connection), keep() only uploads, and while this
// PC's first speech model downloads with nothing else to hear, the mic says "Speech model downloading NN %".
// Owns: these assertions only. Never: a real microphone or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dictation, DictationCancelled, TakeNotTranscribed, dictationNote } from '../../../src/ui/lib/dictation.ts';
import type { DictationDeps } from '../../../src/ui/lib/dictation.ts';
import type { SampleListener } from '../../../src/ui/lib/microphone.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { models, settings } from '../../../src/ui/lib/store.ts';
import { speechPulls } from '../../../src/ui/settings/speech-models.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import type { Settings } from '../../../src/shared/model/system.ts';

const ID = 'a'.repeat(64);

function setup(options: { text?: string; transcribeError?: unknown; openGate?: Promise<void> } = {}) {
  const log: string[] = [];
  const uploads: Array<{ blob: Blob; name: string }> = [];
  const listeners: SampleListener[] = [];
  let clock = 1000;
  let lost = false;
  const deps: DictationDeps = {
    problem: () => undefined,
    openMicrophone: async (onSamples) => {
      log.push('open');
      listeners.push(onSamples);
      await options.openGate;
      return { stream: {} as MediaStream, close: () => log.push('close') };
    },
    upload: async (blob, name) => { uploads.push({ blob, name }); return { id: ID, name, mime: blob.type, size: blob.size } as never; },
    transcribe: async (params) => {
      log.push(`transcribe ${params.fileId === ID} ${params.language ?? '-'}`);
      if (options.transcribeError) throw options.transcribeError;
      return { text: options.text ?? '  hello there ' };
    },
    now: () => clock,
    lost: () => lost,
  };
  return {
    dictation: new Dictation(deps), log, uploads,
    speak: (seconds: number) => listeners.at(-1)!(new Float32Array(16_000 * seconds).fill(0.25), 16_000),
    advance: (ms: number) => { clock += ms; },
    loseConnection: () => { lost = true; },
  };
}

test('a take is a 16 kHz WAV, uploaded and transcribed with the language hint; the microphone closes', async () => {
  const t = setup();
  await t.dictation.start();
  t.speak(1);
  const result = await t.dictation.finish('de-DE');
  assert.deepEqual(result, { text: 'hello there' });
  assert.deepEqual(t.log, ['open', 'close', `transcribe true de-DE`]);
  assert.equal(t.uploads.length, 1);
  const bytes = new Uint8Array(await t.uploads[0].blob.arrayBuffer());
  assert.equal(t.uploads[0].blob.type, 'audio/wav');
  assert.match(t.uploads[0].name, /^Dictation \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.wav$/);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.equal(new DataView(bytes.buffer).getUint32(24, true), 16_000);
  assert.ok(bytes.byteLength > 44 + 31_000, 'one second of PCM16');
  assert.equal(t.dictation.active, false);
});

test('a take without audio adds nothing and uploads nothing; a bad language hint is left out', async () => {
  const t = setup();
  await t.dictation.start();
  assert.deepEqual(await t.dictation.finish('not a language'), { text: '' });
  assert.equal(t.uploads.length, 0);
  await t.dictation.start();
  t.speak(0.5);
  await t.dictation.finish('not a language');
  assert.ok(t.log.includes('transcribe true -'));
});

test('a failed transcription hands a long take back for attaching, a short one not; a lost answer stores the take again', async () => {
  const long = setup({ transcribeError: new Error('Speech to text is not set up yet.') });
  await long.dictation.start();
  long.speak(1);
  long.advance(3000);
  long.loseConnection();
  const error = await long.dictation.finish().catch((caught: unknown) => caught);
  assert.ok(error instanceof TakeNotTranscribed);
  assert.equal(error.message, 'Speech to text is not set up yet.');
  assert.equal(error.recording?.id, ID);
  assert.equal(long.uploads.length, 2, 'stored again in the background');

  const short = setup({ transcribeError: new Error('nope') });
  await short.dictation.start();
  short.speak(0.5);
  short.advance(500);
  const shortError = await short.dictation.finish().catch((caught: unknown) => caught) as TakeNotTranscribed;
  assert.equal(shortError.recording, undefined);
  const field = setup({ transcribeError: new Error('nope') });
  await field.dictation.start();
  field.speak(1);
  field.advance(5000);
  const fieldError = await field.dictation.finish(undefined, { attachable: false }).catch((caught: unknown) => caught) as TakeNotTranscribed;
  assert.equal(fieldError.recording, undefined, 'a field that cannot attach gets no recording');
});

test('a newer start ends the older take (its caller is told); a cancel while the microphone opens gives up and closes it', async () => {
  const t = setup();
  let told = 0;
  await t.dictation.start(() => { told += 1; });
  await t.dictation.start();
  assert.equal(told, 1);
  assert.deepEqual(t.log, ['open', 'close', 'open']);
  t.dictation.cancel();

  let release!: () => void;
  const gated = setup({ openGate: new Promise<void>((resolve) => { release = resolve; }) });
  const starting = gated.dictation.start();
  gated.dictation.cancel();
  release();
  await assert.rejects(starting, DictationCancelled);
  assert.deepEqual(gated.log, ['open', 'close']);
  assert.equal(gated.dictation.active, false);
});

test('keep() uploads the take without transcribing it', async () => {
  const t = setup();
  await t.dictation.start();
  t.speak(1);
  const ref = await t.dictation.keep();
  assert.equal(ref?.id, ID);
  assert.ok(!t.log.some((entry) => entry.startsWith('transcribe')));
});

test('the mic says the speech model downloads while nothing else can hear; a chosen model or a service hears meanwhile', () => {
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: () => undefined } }, configurable: true });
  (globalThis as { AudioContext?: unknown }).AudioContext ??= class {};
  session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  settings.value = { voice: { vocabulary: [], realtime: 'off' }, routing: { functions: {} } } as unknown as Settings;
  models.value = [];
  speechPulls.value = { 'fastconformer-de-int8': { id: 'fastconformer-de-int8', state: 'downloading', done: 42, total: 100, auto: true } };
  assert.equal(dictationNote(), 'Speech model downloading 42 %');
  speechPulls.value = { 'fastconformer-de-int8': { id: 'fastconformer-de-int8', state: 'done', done: 100, total: 100 } };
  assert.equal(dictationNote(), undefined);
  speechPulls.value = { 'fastconformer-de-int8': { id: 'fastconformer-de-int8', state: 'downloading', done: 42, total: 100 } };
  settings.value = { voice: { vocabulary: [], realtime: 'off', localStt: 'fastconformer-de-int8' }, routing: { functions: {} } } as unknown as Settings;
  assert.equal(dictationNote(), undefined, 'a chosen model hears');
});
