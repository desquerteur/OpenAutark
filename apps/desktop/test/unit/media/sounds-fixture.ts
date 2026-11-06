// Fixture for the local hearing tests (B-058 G9): the sound model's files as the download leaves them,
// a fake sherpa AudioTagging that answers per window, and a host that decodes stored files to 16 kHz.
// Owns: fixtures only. Never: imported by production code, loads the real model.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DecodedAudio } from '../../../src/shared/api/host-bridge.ts';
import { AUDIO_TAGGER } from '../../../src/shared/model/local-speech-models.ts';
import type { SoundEvent, TaggerAddon } from '../../../src/runtime/media/sounds.ts';
import { MANIFEST, modelDir } from '../../../src/runtime/voice/local/store.ts';
import { pcm16Bytes } from '../../../src/shared/voice/wav.ts';

export const RATE = 16_000;

/** Writes the tagger's files and manifest as the download would. */
export function installFakeTagger(dataDir: string): void {
  const dir = modelDir(dataDir, AUDIO_TAGGER);
  mkdirSync(dir, { recursive: true });
  for (const file of AUDIO_TAGGER.files) writeFileSync(path.join(dir, file), 'x');
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ id: AUDIO_TAGGER.id, sha256: AUDIO_TAGGER.download.sha256 }));
}

/** A fake AudioTagging: answers `events(windowIndex, samples)`, records the configs and window lengths. */
export function fakeAddon(events: (index: number, samples: Float32Array) => SoundEvent[]) {
  const seen = { configs: [] as Array<Record<string, unknown>>, lengths: [] as number[] };
  class FakeTagging {
    constructor(config: Record<string, unknown>) { seen.configs.push(config); }
    createStream() {
      const stream = { wave: new Float32Array(0) as Float32Array, acceptWaveform(input: { samples: Float32Array }) { stream.wave = input.samples; } };
      return stream;
    }
    compute(stream: { acceptWaveform(input: { samples: Float32Array }): void }): SoundEvent[] {
      const wave = (stream as unknown as { wave: Float32Array }).wave;
      seen.lengths.push(wave.length);
      return events(seen.lengths.length - 1, wave);
    }
  }
  const addon: TaggerAddon = { AudioTagging: FakeTagging };
  return { addon, seen };
}

/** 16 kHz samples: `tone` seconds of a 440 Hz tone at half scale, then `silence` seconds of nothing. */
export function toneThenSilence(tone: number, silence: number): Float32Array {
  const samples = new Float32Array(Math.round((tone + silence) * RATE));
  for (let i = 0; i < tone * RATE; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  return samples;
}

/** A pop-like loop at 120 BPM: I–V–vi–IV piano-ish chords with bass, kick, snare and hi-hat (for the live tagger). */
export function musicLoop(seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  const chords = [[261.63, 329.63, 392.0], [196.0, 246.94, 293.66], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63]];
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    const chord = chords[Math.floor(t / 2) % 4];
    const beat = t % 0.5;
    const count = Math.floor(t / 0.5) % 4;
    let value = 0;
    for (const f of chord) for (let h = 1; h <= 4; h++) value += (0.12 / h) * Math.sin(2 * Math.PI * f * h * t) * Math.exp(-3 * beat);
    value += 0.25 * Math.sin(Math.PI * chord[0] * t) * Math.exp(-2 * beat);
    if (count % 2 === 0 && beat < 0.15) value += 0.6 * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-30 * beat)) * beat) * Math.exp(-20 * beat);
    if (count % 2 === 1 && beat < 0.2) value += 0.35 * noise() * Math.exp(-25 * beat);
    if (t % 0.25 < 0.05) value += 0.08 * noise() * Math.exp(-80 * (t % 0.25));
    samples[i] = value * 0.6;
  }
  return samples;
}

/** What the host's `media.audio` answers for a file of `samples`: the asked span as PCM16, the whole length, partial. */
export function decodedSpan(samples: Float32Array, input: { startMs?: number; maxMs?: number }): DecodedAudio {
  const from = Math.min(samples.length, Math.round(((input.startMs ?? 0) / 1000) * RATE));
  const to = Math.min(samples.length, from + Math.round(((input.maxMs ?? 1_200_000) / 1000) * RATE));
  return { sampleRate: RATE, pcm: pcm16Bytes(samples.subarray(from, to)), durationMs: Math.round((samples.length / RATE) * 1000), startMs: input.startMs ?? 0, partial: to < samples.length };
}
