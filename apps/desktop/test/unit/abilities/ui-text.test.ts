// B-058 (T7): the words of the local speech model rows
// and the notice band's line (src/ui/settings/speech-models-text.ts) – the row's state rule, the progress in the
// row, the runtime's own download as one band line, and an action this window may not take staying disabled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_TAGGER, localSpeechModel, type LocalSpeechOffer, type LocalSpeechPull } from '../../../src/shared/model/local-speech-models.ts';
import { languagesText, pullPercent, speechPullNotice, speechRowView, SPEECH_NOTICE_ID } from '../../../src/ui/settings/speech-models-text.ts';

const FC = localSpeechModel('fastconformer-de-int8')!;
const VOICE = localSpeechModel('supertonic-3-int8')!;
const offer = (extra: Partial<LocalSpeechOffer> = {}): LocalSpeechOffer => ({
  id: FC.id, purpose: 'stt', tier: 'tiny', label: FC.label, publisher: 'NVIDIA', downloadMb: 108, sizeMb: 140, ramMb: 450, languages: ['de'],
  licence: 'CC-BY-4.0', licenceUrl: '', note: '', fit: 'good', recommended: true, installed: false, ...extra,
});
const READY = { ready: true };
const base = { chosen: false, canPull: true, canChoose: true } as const;
const pull = (state: LocalSpeechPull['state'], done: number, extra: Partial<LocalSpeechPull> = {}): LocalSpeechPull => ({ id: FC.id, state, done, total: 200, ...extra });

test('languages and progress in words', () => {
  assert.equal(languagesText(['de']), 'German');
  assert.equal(languagesText(['en', 'de', 'es', 'fr']), 'English, German, Spanish, French');
  assert.equal(languagesText(Array.from({ length: 25 }, (_, i) => `x${i}`)), '25 languages');
  assert.equal(languagesText([]), '');
  assert.equal(pullPercent({ done: 84, total: 200 }), 42);
  assert.equal(pullPercent({ done: 5, total: 0 }), 0, 'an unknown total reads 0 %');
  assert.equal(pullPercent({ done: 300, total: 200 }), 100);
});

test('a speech model row: Download → progress → Use → In use', () => {
  const fresh = speechRowView({ ...base, model: FC, offer: offer(), engine: READY });
  assert.deepEqual(fresh.primary, { kind: 'download', label: 'Download', disabled: false });
  assert.equal(fresh.recommended, true);
  assert.equal(fresh.hint, 'Dictation · German · 108 MB download');
  const loading = speechRowView({ ...base, model: FC, offer: offer(), engine: READY, pull: pull('downloading', 84) });
  assert.deepEqual(loading.primary, { kind: 'progress', label: '42 %', disabled: true });
  assert.match(loading.hint, /^Downloading 42 % · Dictation/);
  assert.match(speechRowView({ ...base, model: FC, offer: offer(), engine: READY, pull: pull('unpacking', 200) }).hint, /^Unpacking…/);
  const there = speechRowView({ ...base, model: FC, offer: offer({ installed: true }), engine: READY, pull: pull('done', 200) });
  assert.deepEqual([there.primary.kind, there.primary.disabled], ['use', false]);
  assert.equal(there.hint, 'Dictation · German · 140 MB on this PC');
  const used = speechRowView({ ...base, model: FC, offer: offer({ installed: true }), engine: READY, chosen: true });
  assert.deepEqual([used.primary.label, used.primary.disabled], ['In use', true]);
  const failed = speechRowView({ ...base, model: FC, offer: offer(), engine: READY, pull: pull('failed', 10, { error: 'FastConformer German could not be downloaded.' }) });
  assert.deepEqual([failed.primary.label, failed.primary.disabled], ['Download', false], 'a failed download offers Download again');
  assert.match(failed.hint, /^FastConformer German could not be downloaded\./);
});

test('a speech model row: nothing to download while unknown, too big, without the engine or the right to', () => {
  assert.equal(speechRowView({ ...base, model: FC }).primary.disabled, true, 'voice.localModels has not answered');
  assert.equal(speechRowView({ ...base, model: FC }).hint, 'Dictation · German · 108 MB download', 'the catalog fills the row meanwhile');
  const big = speechRowView({ ...base, model: FC, offer: offer({ fit: 'too-big', recommended: false }), engine: READY });
  assert.deepEqual([big.primary.disabled, big.hint.startsWith('Too big for this PC')], [true, true]);
  const engine = speechRowView({ ...base, model: VOICE, offer: offer({ id: VOICE.id, purpose: 'tts' }), engine: { ready: false, error: 'no sherpa' } });
  assert.deepEqual([engine.primary.disabled, engine.hint.startsWith('Cannot run on this PC · Reading voice')], [true, true]);
  const phone = speechRowView({ ...base, model: FC, offer: offer({ installed: true }), engine: READY, canChoose: false });
  assert.equal(phone.primary.disabled, true);
  assert.equal(speechRowView({ ...base, model: FC, offer: offer(), engine: READY, canPull: false }).primary.disabled, true);
});

test('the band: the runtime\'s own download as one line with Open; a failed one can be dismissed; a click\'s download is not shown', () => {
  const calls: string[] = [];
  const actions = { open: () => calls.push('open'), dismiss: (id: string) => calls.push(`dismiss:${id}`) };
  assert.equal(speechPullNotice([pull('downloading', 84)], 20, actions), null, 'a download the person started shows in its row');
  const line = speechPullNotice([pull('downloading', 84, { auto: true })], 20, actions)!;
  assert.deepEqual([line.id, line.tone, line.text, line.priority], [SPEECH_NOTICE_ID, 'info', 'Downloading the speech model · FastConformer German 42 %', 20]);
  assert.deepEqual(line.actions?.map((action) => action.label), ['Open']);
  line.actions![0].run();
  const tagger = speechPullNotice([{ id: AUDIO_TAGGER.id, state: 'downloading', done: 1, total: 4, auto: true }], 20, actions)!;
  assert.equal(tagger.text, 'Downloading the sound recognizer · CED Mini 25 %');
  assert.equal(speechPullNotice([pull('done', 200, { auto: true })], 20, actions), null, 'done: the line goes');
  const failed = speechPullNotice([pull('failed', 3, { auto: true, error: 'No internet connection.' })], 20, actions)!;
  assert.deepEqual([failed.tone, failed.text], ['warn', 'No internet connection.']);
  failed.onDismiss!();
  assert.deepEqual(calls, ['open', `dismiss:${FC.id}`]);
  const both = speechPullNotice([pull('failed', 3, { auto: true }), { id: VOICE.id, state: 'unpacking', done: 9, total: 9, auto: true }], 20, actions)!;
  assert.equal(both.text, 'Downloading the local voice · Supertonic 3 unpacking…', 'a running download comes before a failed one');
});
