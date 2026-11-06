// B-058 G5 packing of a take before the local recognizer (src/runtime/voice/local/segments.ts): a short take
// whole with its silence trimmed, a long one cut at its longest pauses into chunks of at most 20 s, padding
// that never reaches a neighbour's speech, Canary unpadded, and the quiet cuts without a VAD.
// Owns: these assertions only. Never: the addon or a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packSpeech, padFor, PAD_SECONDS, piecesOf, quietCuts, WHOLE_SECONDS } from '../../../src/runtime/voice/local/segments.ts';

const RATE = 100; // 100 samples per second keeps the numbers readable
const span = (start: number, end: number) => ({ start: Math.round(start * RATE), end: Math.round(end * RATE) });
const seconds = (spans: Array<{ start: number; end: number }>) => spans.map((s) => [s.start / RATE, s.end / RATE]);

test('a take whose speech spans at most 20 s is one piece, trimmed to its speech plus the padding', () => {
  const chunks = packSpeech([span(1, 3), span(4, 9.5), span(10, 12)], 15 * RATE, RATE);
  assert.deepEqual(seconds(chunks), [[1 - PAD_SECONDS, 12 + PAD_SECONDS]]);
  assert.deepEqual(seconds(packSpeech([span(0.1, 2)], 3 * RATE, RATE)), [[0, 2.3]], 'the padding stops at the take');
  assert.deepEqual(packSpeech([], 10 * RATE, RATE), [], 'no speech, no pieces');
  assert.deepEqual(seconds(packSpeech([span(1, 3)], 5 * RATE, RATE, WHOLE_SECONDS, padFor('canary'))), [[1, 3]], 'Canary hears the speech unpadded');
});

test('a long take is cut at its longest pauses into chunks of at most 20 s, each a run of whole sentences', () => {
  // "Hallo." + 1.5 s pause + a 39 s run with short pauses: the longest pause goes first.
  const spans = [span(0, 1), span(2.5, 10), span(10.4, 19), span(19.9, 28), span(28.3, 41.5)];
  const chunks = packSpeech(spans, 42 * RATE, RATE, 20, 0);
  for (const chunk of chunks) assert.ok(chunk.end - chunk.start <= 20 * RATE, `chunk ${chunk.start / RATE}–${chunk.end / RATE} ≤ 20 s`);
  assert.deepEqual(seconds(chunks), [[0, 1], [2.5, 19], [19.9, 28], [28.3, 41.5]]);
  const padded = packSpeech([span(0, 9.9), span(10.1, 19.9)], 20 * RATE, RATE, 10, 0.3);
  assert.deepEqual(seconds(padded), [[0, 10], [10, 20]], 'padding stops halfway to the neighbour');
  assert.equal(padFor('nemo-transducer'), PAD_SECONDS);
});

test('pieces are views of the take; without a VAD only long takes are cut, at the quietest moment', () => {
  const samples = new Float32Array(10 * RATE).fill(0.5);
  const pieces = piecesOf(samples, [span(1, 2), span(5, 7)]);
  assert.deepEqual(pieces.map((piece) => [piece.start, piece.samples.length]), [[100, 100], [500, 200]]);
  assert.equal(pieces[0].samples.buffer, samples.buffer, 'no copy');
  const long = new Float32Array(16_000 * 30).fill(0.3);
  long.fill(0, 16_000 * 18, 16_000 * 18 + 800);
  const cut = quietCuts(long);
  assert.equal(cut.length, 2);
  assert.ok(Math.abs(cut[1].start / 16_000 - 18) < 0.06);
  assert.equal(quietCuts(new Float32Array(16_000 * 5)).length, 1);
});
