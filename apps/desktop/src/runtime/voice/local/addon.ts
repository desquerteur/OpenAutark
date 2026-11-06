// B-047 D14: the sherpa-onnx native addon (npm sherpa-onnx-node, pinned; its N-API binaries come from
// sherpa-onnx-<platform>-<arch> and are unpacked from the asar, package.json build.asarUnpack) – loaded
// lazily, once, through a require of its own (esbuild leaves it external: the runtime bundle never inlines
// a native module), plus the narrow typed surface the local engine uses and the model configs per kind.
// A failed load is remembered for RETRY_MS (Windows blocks unsigned new binaries under Smart App Control;
// that does not change from one call to the next) and reported as one user-safe sentence.
// Owns: the load, the error wording and the configs. Never: loads a model or reads audio (engine.ts does).

import { createRequire } from 'node:module';
import path from 'node:path';
import type { LocalSpeechModel } from '../../../shared/model/local-speech-models.ts';
import { WorkforceError } from '../../../shared/errors.ts';

export interface SherpaWave { samples: Float32Array; sampleRate: number }
export interface SherpaStream { acceptWaveform(wave: SherpaWave): void }
/** The recognizer's result (sherpa OfflineRecognitionResult::AsJsonString). */
export interface SherpaResult { text?: string; lang?: string; tokens?: string[]; timestamps?: number[]; durations?: number[]; ys_log_probs?: number[] }
export interface SherpaRecognizer {
  config: Record<string, unknown>;
  createStream(): SherpaStream;
  setConfig(config: Record<string, unknown>): void;
  decodeAsync(stream: SherpaStream): Promise<SherpaResult>;
}
export interface SherpaTts {
  sampleRate: number;
  numSpeakers: number;
  generateAsync(request: { text: string; sid: number; speed: number; generationConfig?: unknown }): Promise<SherpaWave>;
}
export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
}
export interface SherpaAddon {
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> };
  GenerationConfig: new (options: Record<string, unknown>) => unknown;
  Vad: new (config: unknown, bufferSeconds: number) => SherpaVad;
  version?: string;
}

/** A failed load is tried again after this long (an update or a trust decision may have changed it). */
export const RETRY_MS = 10 * 60_000;
const BLOCKED = 'Windows blocked the local speech engine (Smart App Control or an app control policy does not trust its files on this PC yet).';
const MISSING = 'The local speech engine could not be loaded on this PC.';

let loaded: SherpaAddon | undefined;
let failed: { at: number; error: WorkforceError } | undefined;

/** The user-safe error for a failed native load (exported for tests). */
export function loadError(error: unknown): WorkforceError {
  const text = error instanceof Error ? error.message : String(error);
  return new WorkforceError('unavailable', /application control|smart app control|blocked/i.test(text) ? BLOCKED : MISSING, { cause: error });
}

/**
 * require('sherpa-onnx-node'), and when it fails the platform binary's own load error: the package's loader
 * swallows the native error and throws "Could not find sherpa-onnx-node" (review fix: a Smart App Control
 * block then read as a missing engine), so the binary is required directly to learn why.
 */
export function requireAddon(req: (id: string) => unknown = createRequire(import.meta.url)): unknown {
  try { return req('sherpa-onnx-node'); } catch (error) {
    req(`sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}/sherpa-onnx.node`); // throws the real reason
    throw error;
  }
}

/** The addon (loaded on first use); throws the remembered WorkforceError while a failed load is recent. */
export function sherpa(now = Date.now(), load: () => unknown = () => requireAddon()): SherpaAddon {
  if (loaded) return loaded;
  if (failed && now - failed.at < RETRY_MS) throw failed.error;
  try {
    const value = load() as SherpaAddon;
    if (!value || typeof value.OfflineRecognizer?.createAsync !== 'function') throw new Error('sherpa-onnx-node has no OfflineRecognizer');
    loaded = value;
    failed = undefined;
    return value;
  } catch (error) {
    failed = { at: now, error: loadError(error) };
    throw failed.error;
  }
}

/** Forgets the load result (tests). */
export function resetSherpa(): void { loaded = undefined; failed = undefined; }

/** Threads per model: half the cores, 1 … 4 (the PC keeps cores for the app and the person). */
export const threadsFor = (cores: number) => Math.max(1, Math.min(4, Math.floor(cores / 2)));

/** The recognizer config of a speech-to-text model in `dir` (`language`: Canary's source and target language). */
export function recognizerConfig(model: LocalSpeechModel, dir: string, threads: number, language: string): Record<string, unknown> {
  const file = (name: string) => path.join(dir, name);
  const common = { tokens: file('tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0 };
  if (model.kind === 'canary') {
    return { featConfig: { sampleRate: 16_000, featureDim: 80 }, modelConfig: { ...common, canary: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), srcLang: language, tgtLang: language, usePnc: 1 } } };
  }
  if (model.kind === 'nemo-transducer') {
    return { featConfig: { sampleRate: 16_000, featureDim: 80 }, modelConfig: { ...common, modelType: 'nemo_transducer', transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') } } };
  }
  throw new WorkforceError('bad_request', `${model.label} is no speech-to-text model.`);
}

/** The TTS config of a text-to-speech model in `dir`. */
export function ttsConfig(model: LocalSpeechModel, dir: string, threads: number): Record<string, unknown> {
  if (model.kind !== 'supertonic') throw new WorkforceError('bad_request', `${model.label} is no text-to-speech model.`);
  const file = (name: string) => path.join(dir, name);
  return {
    model: {
      supertonic: {
        durationPredictor: file('duration_predictor.int8.onnx'), textEncoder: file('text_encoder.int8.onnx'), vectorEstimator: file('vector_estimator.int8.onnx'),
        vocoder: file('vocoder.int8.onnx'), ttsJson: file('tts.json'), unicodeIndexer: file('unicode_indexer.bin'), voiceStyle: file('voice.bin'),
      },
      numThreads: threads, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
  };
}

/** The Silero VAD config (16 kHz; utterances ≤ 20 s so every recognizer takes them whole). */
export function vadConfig(file: string): Record<string, unknown> {
  return { sileroVad: { model: file, threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.2, windowSize: 512, maxSpeechDuration: 20 }, sampleRate: 16_000, numThreads: 1, provider: 'cpu', debug: 0 };
}
