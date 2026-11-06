// One speech output per device page (src/ui/chat/composer/device-speech.ts): lines of several readers (chats of
// the voice conversation) take turns; a reader's cancel stops only its own line and queued lines; a line cut by
// someone else counts as finished so the queue never stalls; a late end of a cut line finishes nothing; the
// output says while it reads (and its tail), which the capture's echo guard uses (conversation-capture.test.ts).
// Owns: these assertions only. Never: a real speech engine, microphone or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSpeech } from '../../../src/ui/chat/composer/device-speech.ts';
import type { SpeechEngine } from '../../../src/ui/chat/composer/device-speech.ts';

function fakeEngine() {
  const played: Array<{ text: string; ended: () => void }> = [];
  let stops = 0;
  const engine: SpeechEngine = { play: (text, _reading, ended) => { played.push({ text, ended }); }, stop: () => { stops += 1; } };
  return { engine, played, texts: () => played.map((line) => line.text), stops: () => stops };
}

test('readers take turns; a cancel stops only its own lines; a line cut by someone else finishes; a late end does nothing', () => {
  let now = 1_000;
  const f = fakeEngine();
  const speech = new DeviceSpeech(f.engine, () => now);
  const a = speech.channel();
  const b = speech.channel();
  const done: string[] = [];
  a.speak('A1', () => done.push('A1'));
  b.speak('B1', () => done.push('B1'));
  a.speak('A2', () => done.push('A2'));
  assert.deepEqual(f.texts(), ['A1'], 'one line at a time');
  assert.equal(speech.speaking(), true);
  b.cancel(); // B's queued line goes, A's line is not touched
  assert.equal(f.stops(), 0);
  f.played[0].ended();
  assert.deepEqual([done, f.texts()], [['A1'], ['A1', 'A2']]);
  b.speak('B2', () => done.push('B2'));
  a.cancel(); // A's own line stops; its done never runs; B's line goes on at once
  assert.equal(f.stops(), 1);
  assert.deepEqual(f.texts(), ['A1', 'A2', 'B2']);
  f.played[1].ended(); // the late end of the cut line
  assert.deepEqual(done, ['A1'], 'a cut line finishes nothing');
  f.played[2].ended(); // cut by the system ('interrupted'): it counts as finished
  assert.deepEqual(done, ['A1', 'B2']);
  assert.equal(speech.speaking(), false);
  assert.equal(speech.speaking(450), true, 'its tail may still reach the microphone');
  now += 500;
  assert.equal(speech.speaking(450), false);
});
