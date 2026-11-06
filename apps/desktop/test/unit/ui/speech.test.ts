// The microphone's audio helpers (ui/lib/pcm.ts, pcm-worklet.ts): floats → 16 kHz PCM16 LE, the take's
// WAV, the conversation's utterance detector and the level meter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelHistory, meterLevel, PCM_RATE, Pcm16Encoder, UtteranceDetector, pcm16ToFloat, rms, wavFile } from '../../../src/ui/lib/pcm.ts';
import { PCM_TAP, registerPcmTap } from '../../../src/ui/lib/pcm-worklet.ts';

function samples(values: number[]): Float32Array {
  return Float32Array.from(values);
}

test('Pcm16Encoder: 48 kHz → 16 kHz, little-endian, clamped, phase carried across blocks', () => {
  const encoder = new Pcm16Encoder(48_000);
  const block = new Float32Array(4096).map((_, i) => (i % 3 === 0 ? 0.5 : 0));
  const first = encoder.push(block);
  const second = encoder.push(block);
  // 8192 input samples at a 3:1 ratio give 2731 output samples (one per started step).
  assert.equal((first.length + second.length) / 2, Math.ceil(8192 / 3));
  assert.equal(first.length % 2, 0);
  const view = new DataView(first.buffer);
  assert.equal(view.getInt16(0, true), Math.round(0.5 * 32767));
  assert.equal(first[0], Math.round(0.5 * 32767) & 0xff, 'low byte first');

  const loud = new Pcm16Encoder(PCM_RATE).push(samples([2, -2, 0.25]));
  const loudView = new DataView(loud.buffer);
  assert.deepEqual([loudView.getInt16(0, true), loudView.getInt16(2, true), loudView.getInt16(4, true)], [32767, -32767, Math.round(0.25 * 32767)]);
});

test('rms + UtteranceDetector: start on sound, end after 1.1 s silence or the 120 s cap', () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(rms(samples([0.5, -0.5])) - 0.5) < 1e-9);

  const detector = new UtteranceDetector();
  assert.equal(detector.feed(0.001, 0), null);
  assert.equal(detector.feed(0.05, 100), 'start');
  assert.equal(detector.speaking, true);
  assert.equal(detector.feed(0.001, 900), null);
  assert.equal(detector.feed(0.05, 1000), null, 'sound again keeps the utterance');
  assert.equal(detector.feed(0.001, 2000), null);
  assert.equal(detector.feed(0.001, 2101), 'end');
  assert.equal(detector.speaking, false);

  const capped = new UtteranceDetector({ maxMs: 500 });
  assert.equal(capped.feed(0.05, 0), 'start');
  assert.equal(capped.feed(0.05, 499), null);
  assert.equal(capped.feed(0.05, 500), 'end');
  capped.feed(0.05, 600);
  capped.reset();
  assert.equal(capped.speaking, false);
});

// ------------------------------------------------------------------ D13: clean audio, level meter

const tone = (hz: number, rate: number, seconds: number) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
const levelOf = (bytes: Uint8Array) => rms(pcm16ToFloat(bytes).subarray(200)); // past the filter's start

test('Pcm16Encoder lowPass: 48 kHz → 16 kHz keeps speech and suppresses what nearest-sample decimation folds into it (regression)', () => {
  const alias = tone(12_000, 48_000, 0.5); // 12 kHz folds to 4 kHz at 16 kHz
  const naive = levelOf(new Pcm16Encoder(48_000).push(alias));
  assert.ok(naive > 0.3, `nearest-sample decimation keeps the alias at full level (${naive})`);
  const filtered = new Pcm16Encoder(48_000, PCM_RATE, { lowPass: true });
  const blocks = [0, 1, 2, 3, 4].map((index) => alias.subarray(index * 4800, (index + 1) * 4800)); // across block borders
  const out = blocks.map((block) => filtered.push(block));
  out.push(filtered.flush());
  const total = out.reduce((sum, bytes) => sum + bytes.length, 0) / 2;
  assert.ok(Math.abs(total - 8000) <= 2, `one output per three inputs, nothing lost (${total})`);
  const joined = new Uint8Array(total * 2);
  let offset = 0;
  for (const bytes of out) { joined.set(bytes, offset); offset += bytes.length; }
  assert.ok(levelOf(joined) < 0.02, `the alias is gone (${levelOf(joined)})`);
  const voice = new Pcm16Encoder(44_100, PCM_RATE, { lowPass: true }).push(tone(1000, 44_100, 0.3));
  const kept = levelOf(voice.subarray(0, voice.length - 100));
  assert.ok(Math.abs(kept - 0.5 / Math.SQRT2) < 0.03, `a 1 kHz tone passes at its level (${kept})`);
  assert.equal(new Pcm16Encoder(16_000, PCM_RATE, { lowPass: true }).push(Float32Array.from([0.25, -0.25])).length, 4, 'at 16 kHz already: passed through');
});

test('wavFile: a 16 kHz mono PCM16 WAV of the take (dictation uploads it)', () => {
  const wav = wavFile([new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0])]);
  const view = new DataView(wav.buffer);
  const text = (from: number) => String.fromCharCode(...wav.subarray(from, from + 4));
  assert.deepEqual([text(0), text(8), text(12), text(36)], ['RIFF', 'WAVE', 'fmt ', 'data']);
  assert.deepEqual([view.getUint32(4, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)], [42, 1, 16_000, 16, 6]);
  assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
});

test('meterLevel + LevelHistory: block RMS → 0..1 bars on a dB scale, a fixed-size history oldest first', () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(0.001), 0, '−60 dB is silence');
  assert.equal(meterLevel(0.5), 1);
  assert.ok(meterLevel(0.01) > 0.3 && meterLevel(0.01) < 0.5);
  const history = new LevelHistory(3);
  const before = history.version;
  for (const level of [0.1, 0.2, 0.3, 2]) history.push(level);
  assert.deepEqual(history.list().map((value) => Math.round(value * 10) / 10), [0.2, 0.3, 1]);
  assert.ok(history.version > before, 'the waveform repaints only on a new level');
  history.clear();
  assert.deepEqual(history.list(), [0, 0, 0]);
});

test('pcm-worklet: the tap posts fixed-size blocks from the 128-frame render quanta, and registers only in a worklet scope', () => {
  const posted: Float32Array[] = [];
  let registered: (new (options?: { processorOptions?: { blockFrames?: number } }) => { process(inputs: Float32Array[][]): boolean }) | null = null;
  class Base { readonly port = { postMessage: (data: Float32Array) => { posted.push(data); } } as unknown as MessagePort; }
  const scope = { AudioWorkletProcessor: Base, registerProcessor: (name: string, processor: unknown) => { assert.equal(name, PCM_TAP); registered = processor as typeof registered; } };
  assert.equal(registerPcmTap({}), false, 'a window is no worklet scope');
  assert.equal(registerPcmTap(scope as never), true);
  const tap = new registered!({ processorOptions: { blockFrames: 200 } });
  for (let quantum = 0; quantum < 4; quantum++) assert.equal(tap.process([[Float32Array.from({ length: 128 }, (_, i) => quantum * 128 + i)]]), true);
  assert.deepEqual(posted.map((block) => block.length), [200, 200]);
  assert.deepEqual([posted[0][0], posted[1][0], posted[1][199]], [0, 200, 399], 'in order, nothing dropped at the block border');
  assert.equal(tap.process([]), true, 'no input: keeps running');
});
