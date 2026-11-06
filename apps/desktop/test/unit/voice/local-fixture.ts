// Shared fakes for the local speech tests (B-047 D14): a temporary data folder, "installed" model folders
// (one-byte files plus the manifest – the engine never reads them, the fake addon stands in), a fake
// sherpa-onnx addon that records what it was asked and a WAV of a test signal.
// Owns: these fixtures only. Never: the real addon, a real model or the network.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalSpeechModel } from '../../../src/shared/model/local-speech-models.ts';
import type { SherpaAddon, SherpaResult, SherpaWave } from '../../../src/runtime/voice/local/addon.ts';
import { MANIFEST, modelDir } from '../../../src/runtime/voice/local/store.ts';
import { encodeWav } from '../../../src/shared/voice/wav.ts';

export function tempData(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-local-speech-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes `model`'s files (one byte each) and its manifest, so isInstalled() says yes. */
export function installFake(dataDir: string, model: LocalSpeechModel, sha256 = model.download.sha256): string {
  const dir = modelDir(dataDir, model);
  mkdirSync(dir, { recursive: true });
  for (const file of model.files) writeFileSync(path.join(dir, file), 'x');
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ id: model.id, sha256, installedAt: 1 }));
  return dir;
}

export interface FakeAddonState {
  recognizers: Array<{ config: Record<string, unknown>; setConfigs: number; decodes: number }>;
  tts: Array<{ config: unknown; requests: Array<{ text: string; sid: number; config: Record<string, unknown> }> }>;
  vads: number;
  active: number;
  maxActive: number;
}

/** What the fake recognizer answers for the wave of a stream. */
export type FakeResult = (wave: SherpaWave) => SherpaResult;

/** A fake addon: decode answers `result(samples)` after a tick; the VAD cuts at runs of exact zeros. */
export function fakeAddon(options: { result?: FakeResult; loadMs?: number; speakers?: number; fail?: boolean } = {}): { addon: SherpaAddon; state: FakeAddonState } {
  const state: FakeAddonState = { recognizers: [], tts: [], vads: 0, active: 0, maxActive: 0 };
  const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
  class GenerationConfig { constructor(options: Record<string, unknown>) { Object.assign(this, options); } }
  class Vad {
    private buffer: number[] = [];
    private start = 0;
    private seen = 0;
    private readonly out: Array<{ start: number; samples: Float32Array }> = [];
    constructor() { state.vads++; }
    acceptWaveform(samples: Float32Array) {
      for (const value of samples) {
        if (value !== 0) { if (!this.buffer.length) this.start = this.seen; this.buffer.push(value); } else this.cut();
        this.seen++;
      }
    }
    private cut() { if (this.buffer.length) { this.out.push({ start: this.start, samples: Float32Array.from(this.buffer) }); this.buffer = []; } }
    isEmpty() { return this.out.length === 0; }
    front() { return this.out[0]; }
    pop() { this.out.shift(); }
    flush() { this.cut(); }
  }
  const addon = {
    OfflineRecognizer: {
      async createAsync(config: Record<string, unknown>) {
        await tick(options.loadMs ?? 1);
        if (options.fail) throw new Error('load failed');
        const entry = { config, setConfigs: 0, decodes: 0 };
        state.recognizers.push(entry);
        return {
          config,
          setConfig: (next: Record<string, unknown>) => { entry.setConfigs++; entry.config = structuredClone(next); },
          createStream() { const waves: SherpaWave[] = []; return { waves, acceptWaveform: (wave: SherpaWave) => { waves.push(wave); } }; },
          async decodeAsync(stream: { waves: SherpaWave[] }) {
            entry.decodes++;
            state.active++; state.maxActive = Math.max(state.maxActive, state.active);
            await tick(2);
            state.active--;
            return options.result ? options.result(stream.waves[0]) : { text: `heard ${stream.waves[0].samples.length}` };
          },
        };
      },
    },
    OfflineTts: {
      async createAsync(config: unknown) {
        await tick();
        const entry = { config, requests: [] as Array<{ text: string; sid: number; config: Record<string, unknown> }> };
        state.tts.push(entry);
        return {
          sampleRate: 44_100, numSpeakers: options.speakers ?? 10,
          async generateAsync(request: { text: string; sid: number; generationConfig?: unknown }) {
            entry.requests.push({ text: request.text, sid: request.sid, config: { ...(request.generationConfig as Record<string, unknown>) } });
            await tick();
            return { samples: new Float32Array([0, 0.5, -0.5, 1]), sampleRate: 44_100 };
          },
        };
      },
    },
    GenerationConfig,
    Vad,
    version: 'fake',
  } as unknown as SherpaAddon;
  return { addon, state };
}

export const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

/** `seconds` of a 440 Hz tone at `rate` as a 16-bit WAV. */
export function toneWav(seconds: number, rate = 16_000): Uint8Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return encodeWav(samples, rate);
}
