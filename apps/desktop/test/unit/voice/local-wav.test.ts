// B-047 D14 audio for local speech (src/shared/voice/wav.ts): WAV reading in every PCM/float encoding and
// channel count, raw PCM16, band-limited resampling (no aliasing when 48 kHz goes to 16 kHz), WAV writing
// and a page's decoded take as a 16 kHz WAV.
// Owns: these assertions only. Never: the native addon or a real recording.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, parseWav, pcm16Bytes, pcm16Samples, resample, wavFromDecoded } from '../../../src/shared/voice/wav.ts';

/** A WAV with arbitrary fields (format tag, bits, channels) and interleaved raw sample bytes. */
function rawWav(format: number, bits: number, channels: number, rate: number, body: Uint8Array, extensible = false): Uint8Array {
  const fmtSize = extensible ? 40 : 16;
  const out = new Uint8Array(12 + 8 + fmtSize + 8 + body.byteLength);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, out.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : format, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * (bits / 8), true); view.setUint16(32, channels * (bits / 8), true); view.setUint16(34, bits, true);
  if (extensible) { view.setUint16(36, 22, true); view.setUint16(44, format, true); }
  const data = 20 + fmtSize;
  tag(data, 'data'); view.setUint32(data + 4, body.byteLength, true);
  out.set(body, data + 8);
  return out;
}

test('parseWav reads 16-bit mono, 24-bit stereo (mixed to mono), float32 and WAVE_FORMAT_EXTENSIBLE', () => {
  const mono = parseWav(encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16_000));
  assert.equal(mono.sampleRate, 16_000);
  assert.deepEqual([...mono.samples].map((v) => Math.round(v * 100) / 100), [0, 0.5, -0.5, 1]);

  const stereo24 = new Uint8Array(6); // one frame: left = +0.5, right = -0.25 → mono 0.125
  const put24 = (at: number, value: number) => { const int = Math.round(value * 8388608) & 0xffffff; stereo24[at] = int & 255; stereo24[at + 1] = (int >> 8) & 255; stereo24[at + 2] = (int >> 16) & 255; };
  put24(0, 0.5); put24(3, -0.25);
  const mixed = parseWav(rawWav(1, 24, 2, 48_000, stereo24));
  assert.equal(mixed.sampleRate, 48_000);
  assert.ok(Math.abs(mixed.samples[0] - 0.125) < 1e-6);

  const floats = new Uint8Array(new Float32Array([0.25, -0.75]).buffer);
  assert.deepEqual([...parseWav(rawWav(3, 32, 1, 22_050, floats)).samples], [0.25, -0.75]);
  assert.deepEqual([...parseWav(rawWav(3, 32, 1, 22_050, floats, true)).samples], [0.25, -0.75], 'extensible with a float sub-format');
});

test('parseWav refuses what it cannot read with a plain reason', () => {
  assert.throws(() => parseWav(new Uint8Array([1, 2, 3])), /not a WAV/);
  assert.throws(() => parseWav(rawWav(85, 16, 1, 16_000, new Uint8Array(4))), /unsupported WAV encoding/); // MP3 in WAV
  assert.throws(() => parseWav(rawWav(1, 16, 1, 1_000, new Uint8Array(4))), /sample rate/);
});

test('raw PCM16 and PCM16 bytes are inverse within one step', () => {
  const samples = new Float32Array([0, 0.25, -1, 0.999]);
  const back = pcm16Samples(pcm16Bytes(samples));
  samples.forEach((value, index) => assert.ok(Math.abs(back[index] - value) < 1 / 16_000));
});

const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
const tone = (hz: number, rate: number, seconds = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));

test('resample keeps speech-band tones and removes what 16 kHz cannot hold (no aliasing)', () => {
  const speech = resample(tone(1_000, 48_000), 48_000, 16_000);
  assert.equal(speech.length, 8_000);
  assert.ok(Math.abs(rms(speech.subarray(200, -200)) - rms(tone(1_000, 16_000))) < 0.02, '1 kHz keeps its level');
  const high = resample(tone(11_000, 48_000), 48_000, 16_000); // naive decimation would fold it to 5 kHz
  assert.ok(rms(high.subarray(200, -200)) < 0.02, `11 kHz is filtered out, rms ${rms(high)}`);
  const up = resample(tone(440, 8_000), 8_000, 16_000);
  assert.equal(up.length, 8_000);
  assert.ok(Math.abs(rms(up.subarray(200, -200)) - 0.3536) < 0.02, 'upsampling keeps the level');
  const same = tone(440, 16_000);
  assert.equal(resample(same, 16_000, 16_000), same);
});

test('wavFromDecoded mixes a decoded take to mono and writes 16 kHz', () => {
  const left = tone(500, 48_000, 0.1);
  const right = new Float32Array(left.length);
  const wav = parseWav(wavFromDecoded({ numberOfChannels: 2, sampleRate: 48_000, length: left.length, getChannelData: (channel) => (channel ? right : left) }));
  assert.equal(wav.sampleRate, 16_000);
  assert.equal(wav.samples.length, Math.round(left.length / 3));
  assert.ok(Math.abs(rms(wav.samples.subarray(100, -100)) - rms(left) / 2) < 0.02, 'half the level: one silent channel');
});
