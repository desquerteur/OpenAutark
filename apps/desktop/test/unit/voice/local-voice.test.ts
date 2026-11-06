// B-047 D14 the PC's local voice in a page's speech output (src/ui/chat/composer/device-speech.ts):
// sentences split for voice.speak (short pieces joined, long ones cut at a space), the next sentence asked
// while the current one plays, the line ends once after its last sentence, a failed call or playback hands
// the rest of the line to speechSynthesis, a cut line asks and plays nothing more, and without a local
// voice everything stays with speechSynthesis (regression: German answers were read by robotic Windows
// voices even with a neural voice on the PC).
// Owns: these assertions only. Never: real audio or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSpeech, localVoiceEngine, MAX_SENTENCE, sentences, type LocalVoiceDeps, type SpeechEngine } from '../../../src/ui/chat/composer/device-speech.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { active?: boolean; failAt?: number; playFails?: boolean } = {}) {
  const asked: string[] = [];
  const playing: Array<{ ended: () => void; stopped: boolean }> = [];
  const fallback: string[] = [];
  let fallbackEnd: (() => void) | undefined;
  let fallbackStops = 0;
  const synthesis: SpeechEngine = { play: (text, _reading, ended) => { fallback.push(text); fallbackEnd = ended; }, stop: () => { fallbackStops++; } };
  const deps: LocalVoiceDeps = {
    active: () => options.active ?? true,
    speak: async ({ text }) => {
      asked.push(text);
      if (options.failAt !== undefined && asked.length - 1 === options.failAt) throw new Error('busy');
      return { audio: Buffer.from([0, 0, 255, 127]).toString('base64'), sampleRate: 44_100, durationMs: 1 };
    },
    play: async (_samples, _rate, ended) => {
      if (options.playFails) throw new Error('audio output is not allowed yet');
      const entry = { ended, stopped: false };
      playing.push(entry);
      return () => { entry.stopped = true; };
    },
  };
  const engine = localVoiceEngine(deps, synthesis);
  return { engine, asked, playing, fallback, fallbackEnd: () => fallbackEnd?.(), fallbackStops: () => fallbackStops };
}

test('sentences: split after . ! ? and line breaks, short pieces join, long ones are cut at a space', () => {
  assert.deepEqual(sentences('Hallo Gerd, wie geht es dir heute? Mir geht es gut. Ja.\nDas Meeting ist um 14 Uhr.'),
    ['Hallo Gerd, wie geht es dir heute?', 'Mir geht es gut. Ja. Das Meeting ist um 14 Uhr.']);
  assert.deepEqual(sentences('Ok.'), ['Ok.']);
  const long = sentences(`${'wort '.repeat(150)}ende.`);
  assert.ok(long.length >= 2 && long.every((piece) => piece.length <= MAX_SENTENCE && !piece.startsWith(' ')));
});

test('sentence by sentence: the next one is asked while one plays; the line ends once after the last', async () => {
  const h = harness();
  let ended = 0;
  h.engine.play('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.', { language: 'de-DE' }, () => { ended++; });
  await tick(); await tick();
  assert.equal(h.playing.length, 1);
  assert.deepEqual(h.asked, ['Das ist der erste Satz für den Test.', 'Das ist der zweite Satz für den Test.'], 'the second is asked while the first plays');
  h.playing[0].ended();
  await tick(); await tick();
  assert.equal(h.playing.length, 2);
  assert.equal(h.asked.length, 3);
  h.playing[1].ended();
  await tick(); await tick();
  h.playing[2].ended();
  await tick();
  assert.equal(ended, 1);
  assert.deepEqual(h.fallback, []);
});

test('a failed call hands the rest of the line to speechSynthesis; so does audio that cannot play', async () => {
  const h = harness({ failAt: 1 });
  let ended = 0;
  h.engine.play('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.', {}, () => { ended++; });
  await tick(); await tick();
  h.playing[0].ended();
  await tick(); await tick();
  assert.deepEqual(h.fallback, ['Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.']);
  h.fallbackEnd();
  assert.equal(ended, 1);
  const muted = harness({ playFails: true });
  muted.engine.play('Ein ganzer Satz für den Test.', {}, () => {});
  await tick(); await tick();
  assert.deepEqual(muted.fallback, ['Ein ganzer Satz für den Test.']);
});

test('a cut line stops its audio and asks for nothing more; the queue moves on', async () => {
  const h = harness();
  const speech = new DeviceSpeech(h.engine);
  const reader = speech.channel();
  const done: string[] = [];
  reader.speak('Das ist der erste Satz für den Test. Das ist der zweite Satz für den Test. Das ist der dritte Satz für den Test.', () => done.push('first'));
  await tick(); await tick();
  reader.cancel();
  assert.equal(h.playing[0].stopped, true);
  const asked = h.asked.length;
  h.playing[0].ended();
  await tick(); await tick();
  assert.equal(h.asked.length, asked, 'nothing more after the cut');
  assert.deepEqual(done, [], 'a cancelled line never reports done');
  assert.equal(speech.speaking(), false);
});

test("the audio output is opened in the reader's own call, before voice.speak is awaited (review fix: a phone's tap was over)", () => {
  const order: string[] = [];
  const synthesis: SpeechEngine = { play: () => order.push('fallback'), stop: () => {} };
  const engine = localVoiceEngine({
    active: () => true,
    prepare: () => order.push('prepare'),
    speak: async () => { order.push('speak'); return { audio: '', sampleRate: 0, durationMs: 0 }; },
    play: async () => () => {},
  }, synthesis);
  engine.play('Ein ganzer Satz für den Test.', {}, () => {});
  assert.deepEqual(order, ['prepare', 'speak'], 'prepared synchronously, first');
  const idle = localVoiceEngine({ active: () => false, prepare: () => order.push('idle-prepare'), speak: async () => ({ audio: '', sampleRate: 0, durationMs: 0 }), play: async () => () => {} }, synthesis);
  idle.play('Hallo.', {}, () => {});
  assert.ok(!order.includes('idle-prepare'), 'no output opened without a local voice');
});

test('without a local voice every line stays with speechSynthesis', async () => {
  const h = harness({ active: false });
  let ended = 0;
  h.engine.play('Hallo.', {}, () => { ended++; });
  assert.deepEqual(h.fallback, ['Hallo.']);
  assert.deepEqual(h.asked, []);
  h.fallbackEnd();
  assert.equal(ended, 1);
  h.engine.stop();
  assert.equal(h.fallbackStops(), 1);
});
