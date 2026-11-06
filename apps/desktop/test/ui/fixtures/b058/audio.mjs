// Audio helpers of the B-058 live window test (test/ui/b058-dictation-window.test.mjs): word error rate, PCM16 WAV
// read/write and where a recorded take starts inside the recording the fake microphone played.
// Owns: these measurements. Never: touches the app or its profile.

import assert from 'node:assert/strict';

export const words = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Word error rate in % (case- and punctuation-insensitive; the rule of the B-058 measurements). */
export function wer(reference, hypothesis) {
  const r = words(reference), h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length, wer: Math.round((d[r.length][h.length] / r.length) * 1000) / 10 };
}

/** The PCM16 mono data of a WAV file's bytes. */
export function pcm16(buf, what = 'WAV') {
  let at = 12, rate = 0, channels = 0, bits = 0, data;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4), size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(at + 10); rate = buf.readUInt32LE(at + 12); bits = buf.readUInt16LE(at + 22); }
    if (id === 'data') data = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  assert.ok(data && channels === 1 && bits === 16 && rate > 0, `${what}: a mono 16-bit PCM WAV`);
  return { rate, data };
}

export function wav(rate, data) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const FRAME_MS = 10;

/** RMS per 10 ms frame. */
function envelope(data, rate) {
  const n = Math.round((rate * FRAME_MS) / 1000), out = [];
  for (let i = 0; i + 2 * n <= data.length; i += 2 * n) {
    let sum = 0;
    for (let j = 0; j < n; j++) { const v = data.readInt16LE(i + 2 * j); sum += v * v; }
    out.push(Math.sqrt(sum / n));
  }
  return out;
}

/** Where speech first starts (first 10 ms frame above -40 dBFS), in ms. */
export function onsetMs(data, rate) {
  const index = envelope(data, rate).findIndex((value) => value > 328);
  return index < 0 ? undefined : index * FRAME_MS;
}

/**
 * Where in `source` the take begins (ms, 10 ms steps, 0–5 s): the shift with the best correlation of the two loudness
 * envelopes over the take's first 10 s (the app's echo cancelling, noise suppression and gain change the level, not the timing).
 */
export function takeStart(take, source, rate) {
  const a = envelope(take, rate), b = envelope(source, rate);
  let best = 0, score = -Infinity;
  for (let shift = 0; shift <= 500 && shift < b.length; shift++) {
    const len = Math.min(a.length, b.length - shift, 1000);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < len; i++) { const x = a[i], y = b[i + shift]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
    const r = (sab - (sa * sb) / len) / Math.sqrt(((saa - (sa * sa) / len) * (sbb - (sb * sb) / len)) || 1);
    if (r > score) { score = r; best = shift; }
  }
  return { ms: best * FRAME_MS, r: Math.round(score * 1000) / 1000 };
}
