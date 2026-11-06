// B-058 G9 live: media.listen without a listening model hears real recordings with the real CED Mini
// model through the real sherpa-onnx addon (media/sounds.ts) – a speech recording and a rendered music
// loop. Skipped unless WF_TAGGER_DATA names a data folder with the model installed (models/speech/ced-mini,
// as voice/local/download.ts leaves it); WF_TAGGER_SPEECH may name a speech WAV. The transcript comes from
// a fake speech-to-text service (one model in memory at a time on small PCs).
// Owns: this live check. Never: downloads the model or reaches the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { soundTagger } from '../../../src/runtime/media/sounds.ts';
import { encodeWav } from '../../../src/shared/voice/wav.ts';
import { account, call, listenSetup, model, textOf } from './listen-fixture.ts';
import { musicLoop, RATE } from './sounds-fixture.ts';

const DATA = process.env.WF_TAGGER_DATA;
const SPEECH = process.env.WF_TAGGER_SPEECH;
const ready = Boolean(DATA && soundTagger({ paths: { data: DATA } as never })?.installed());

test('live: media.listen without a listening model tags real speech and music with CED Mini on this PC', { skip: ready ? false : 'set WF_TAGGER_DATA to a data folder with ced-mini installed' }, async () => {
  const t = await listenSetup({ accounts: (base) => [account('acc_local', 'vllm', 'local', base)], models: () => [model('vllm:llama-3.1-8b', 'acc_local')] });
  let transcribed = 0;
  Object.assign(t.h.services, { paths: { temp: t.temp.dir, data: DATA }, stt: { state: () => 'ready', transcript: async () => { transcribed++; return 'Transcript from the speech service.'; } } });
  try {
    const song = await t.put(encodeWav(musicLoop(12), RATE), 'loop.wav');
    t.attach(t.chat.id, song);
    const files = [song];
    if (SPEECH && existsSync(SPEECH)) {
      const speech = await t.put(new Uint8Array(readFileSync(SPEECH)), 'ansage.wav');
      t.attach(t.chat.id, speech);
      files.push(speech);
    }
    await t.media.idle();
    const started = Date.now();
    const music = (await call({ fileId: song.id, question: 'What is this?' }, t.ctx())).out;
    assert.equal(music.isError, undefined, textOf(music));
    const heardMusic = music.structured as Record<string, unknown>;
    console.log(`  loop.wav (${Date.now() - started} ms, ${Math.round(os.freemem() / 1_048_576)} MB free):`, JSON.stringify(heardMusic.sounds));
    assert.ok((heardMusic.sounds as string[]).some((line) => /^Music 0:00–0:1[12] \(0\.[5-9]\d\)$/.test(line)), String(heardMusic.sounds));
    assert.match(String(heardMusic.transcriptNote), /^No speech was recognised, so nothing was transcribed/);
    assert.equal(transcribed, 0);

    if (files[1]) {
      const speech = (await call({ fileId: files[1].id, question: 'Who speaks?' }, t.ctx())).out.structured as Record<string, unknown>;
      console.log('  ansage.wav:', JSON.stringify(speech.sounds), speech.heard);
      assert.ok((speech.sounds as string[]).some((line) => /^Speech /.test(line)), String(speech.sounds));
      assert.equal(speech.transcript, 'Transcript from the speech service.');
      assert.equal(transcribed, 1);
    }
    assert.equal(t.chats().length, 0, 'no model was asked');
  } finally { soundTagger({ paths: { data: DATA } as never })?.unload(); await t.close(); }
});
