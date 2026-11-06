// B-047 D14: the local speech engine inside the runtime process – one resident recognizer or voice per
// downloaded model (sherpa-onnx, addon.ts), loaded on first use (createAsync: off the event loop), each
// one's calls in turn (a queue per model; decoding runs on the addon's worker thread), unloaded after
// IDLE_MS without use (a timer per model, unref'd – nothing polls) and the memory handed back at once
// (the addon frees its models in GC finalizers, so an unload collects). Before a load the PC's free memory
// is read: idle models of the other purpose go first when it is short. B-058 G4: Windows' free memory
// (os.freemem) is what is available without paging, standby cache included – 105 MB "free" was measured
// on the 8 GB reference PC while it had GBs to give. Paging a model of up to SMALL_MODEL_MB in is
// acceptable, refusing a dictation is not: such models always load; only a larger one is refused, and only
// when free memory is far below its estimate (MIN_FREE_SHARE). The caller (voice/transcribe.ts) falls back
// after a refusal, a load error or a failed decode (every native failure is a user-safe 'unavailable'). Recordings are resampled to 16 kHz and cut by segments.ts (G5: takes up
// to 20 s whole with their silence trimmed, longer ones packed at their longest pauses; no words heard is
// '' then). Words, timestamps and token probabilities come back when the model gives them. A voice speaks a line in
// sentence-sized pieces, one queue turn each, and stops before the next piece once the caller's signal aborted.
// Owns: residency, the memory gate, segmentation, the voice's pieces and result shaping. Never: downloads, reads settings or
// files of the app (service.ts and hear.ts do), sends audio anywhere.

import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Logger } from '../../contracts.ts';
import type { HeardSegment, HeardWord } from '../../../shared/api/methods-app.ts';
import { SILERO_VAD, type LocalSpeechModel } from '../../../shared/model/local-speech-models.ts';
import { resample, type MonoAudio } from '../../../shared/voice/wav.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { recognizerConfig, sherpa, threadsFor, ttsConfig, vadConfig, type SherpaAddon, type SherpaRecognizer, type SherpaResult, type SherpaTts, type SherpaVad } from './addon.ts';
import { packSpeech, padFor, piecesOf, quietCuts, RATE, WHOLE_SECONDS, type Piece, type Span } from './segments.ts';
import { isInstalled, modelDir } from './store.ts';

export const IDLE_MS = 5 * 60_000;
/** B-058 G4: models whose memory estimate is at most this always load (Windows pages them in). */
export const SMALL_MODEL_MB = 600;
/** A larger model is refused when less than this share of its memory estimate is free. */
export const MIN_FREE_SHARE = 0.25;
export { RATE };
const VOICES = 'Settings › Models';

export type { HeardSegment, HeardWord };
export interface LocalHeard { text: string; segments: HeardSegment[]; words: HeardWord[] }

export interface EngineDeps {
  dataDir: () => string;
  log: Logger;
  addon?: () => SherpaAddon;
  freeMemoryMb?: () => number;
  cpuCores?: () => number;
  idleMs?: number;
  /** Runs a garbage collection after an unload (default: V8's gc, exposed on first use). */
  collect?: () => void;
}

/** `value` is cleared on unload: no closure (an idle timer, a settled queue) may keep the native model alive. */
interface Resident { model: LocalSpeechModel; value: SherpaRecognizer | SherpaTts | null; queue: Promise<unknown>; busy: number; timer?: ReturnType<typeof setTimeout>; language?: string }

let gc: (() => void) | undefined;
/** V8's collector: the native models' memory returns only when their handles are collected. */
function collectGarbage(): void {
  try {
    gc ??= (globalThis as { gc?: () => void }).gc ?? (v8.setFlagsFromString('--expose-gc'), vm.runInNewContext('gc') as () => void);
    gc();
  } catch { /* without a collector the memory returns at the next natural GC */ }
}

/** How a voice speaks (`sid`: the speaker; `language`: one of the model's languages). */
interface SpeakOptions { sid?: number; language: string; speed?: number; steps?: number }

/** The longest piece of text one voice call speaks (~20 s of compute on the reference PC at ~65 ms per character). */
export const SPEAK_PIECE_CHARS = 300;

/** A line in the pieces the voice speaks one call each: whole sentences packed up to `max` characters; a longer sentence is cut at a space. */
export function speechPieces(text: string, max = SPEAK_PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let piece = '';
  const flush = () => { if (piece) pieces.push(piece); piece = ''; };
  for (let sentence of text.trim().split(/(?<=[.!?…])\s+/)) {
    while (sentence.length > max) {
      const space = sentence.lastIndexOf(' ', max);
      const at = space > max / 2 ? space : max;
      flush();
      pieces.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (piece && piece.length + 1 + sentence.length > max) flush();
    if (sentence) piece = piece ? `${piece} ${sentence}` : sentence;
  }
  flush();
  return pieces.length ? pieces : [text];
}

/** Token texts → words: a token starting with '▁' or a space begins a word, others (pieces, punctuation) join it. */
export function wordsOf(result: SherpaResult, offset: number): HeardWord[] {
  const tokens = result.tokens ?? [];
  const times = result.timestamps ?? [];
  if (!tokens.length || times.length !== tokens.length) return [];
  const durations = result.durations ?? [];
  const logprobs = result.ys_log_probs ?? [];
  const words: HeardWord[] = [];
  let current: { text: string; start: number; end: number; low?: number } | undefined;
  const close = () => {
    const text = current?.text.trim();
    if (current && text) words.push({ text, start: current.start, end: current.end, ...(current.low !== undefined ? { confidence: Math.exp(current.low) } : {}) });
    current = undefined;
  };
  tokens.forEach((token, index) => {
    const start = offset + times[index];
    const end = start + (durations[index] > 0 ? durations[index] : 0.08);
    const opens = /^[▁ ]/.test(token);
    const piece = token.replace(/▁/g, ' ');
    if (opens || !current) { close(); current = { text: piece, start, end }; } else { current.text += piece; current.end = end; }
    const logprob = logprobs[index];
    if (typeof logprob === 'number' && Number.isFinite(logprob)) current!.low = Math.min(current!.low ?? 0, logprob);
  });
  close();
  return words;
}

/** A recognizer's text as written: single spaces, none before . and , (nor before ! ? ; : outside French typography). */
export function tidy(text: string, language: string): string {
  const spaced = text.replace(/\s+/g, ' ').trim().replace(/ +([.,])/g, '$1');
  return language === 'fr' ? spaced : spaced.replace(/ +([!?;:])/g, '$1');
}

export class LocalSpeechEngine {
  private readonly deps: EngineDeps;
  private readonly residents = new Map<string, Resident>();
  private readonly loading = new Map<string, Promise<Resident>>();

  constructor(deps: EngineDeps) { this.deps = deps; }

  /** The ids of the models in memory now. */
  resident(): string[] { return [...this.residents.keys()]; }

  /** Loads the addon (no model) – whether local speech can run on this PC at all; throws the user-safe reason. */
  check(): void { this.addon(); }

  /** Text, segments and words of a recording (`language`: one of the model's languages). */
  async transcribe(model: LocalSpeechModel, audio: MonoAudio, language: string): Promise<LocalHeard> {
    const samples = audio.sampleRate === RATE ? audio.samples : resample(audio.samples, audio.sampleRate, RATE);
    if (model.purpose !== 'stt') throw new WorkforceError('bad_request', `${model.label} is no speech-to-text model.`);
    if (samples.length < RATE / 10) return { text: '', segments: [], words: [] };
    const parts = await this.utterances(samples, model);
    if (!parts.length) return { text: '', segments: [], words: [] };
    return this.use(model, async (resident) => {
      const recognizer = resident.value as SherpaRecognizer;
      const segments: HeardSegment[] = [];
      const words: HeardWord[] = [];
      try {
        if (model.kind === 'canary' && resident.language !== language) this.canaryLanguage(resident, language);
        for (const part of parts) {
          const stream = recognizer.createStream();
          stream.acceptWaveform({ samples: part.samples, sampleRate: RATE });
          const result = await recognizer.decodeAsync(stream);
          const text = tidy(result.text ?? '', language);
          if (!text) continue;
          const start = part.start / RATE;
          segments.push({ text, start, end: start + part.samples.length / RATE });
          words.push(...wordsOf(result, start));
        }
      } catch (error) {
        // Review fix (B-058): a native failure (onnxruntime out of memory, a broken model) is a model that could not
        // hear the take – user-safe and 'unavailable', so the caller falls back – never a raw internal error.
        if (error instanceof WorkforceError) throw error;
        this.deps.log.warn('local speech model failed to transcribe', { model: model.id, error: String(error) });
        throw new WorkforceError('unavailable', `${model.label} could not transcribe this recording. Try again, or download the model again (${VOICES}).`);
      }
      return { text: segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim(), segments, words };
    }, language);
  }

  /**
   * One spoken line (`sid`: the voice; `language`: one of the model's languages). B-058: sherpa's generateAsync cannot
   * be cancelled, so the line is spoken in sentence-sized pieces (speechPieces), each its own turn in the model's queue:
   * another call waits at most one piece, and once `signal` aborted (the caller's stop or deadline) no further piece
   * starts – the call rejects 'cancelled' and the voice is free after the piece in progress.
   */
  async synthesize(model: LocalSpeechModel, text: string, options: SpeakOptions & { signal?: AbortSignal }): Promise<MonoAudio> {
    const stopped = () => new WorkforceError('cancelled', 'Speaking stopped.');
    if (options.signal?.aborted) throw stopped();
    const parts: Float32Array[] = [];
    let rate = 0;
    let cut = false;
    await this.hold(model, async (turn) => {
      for (const piece of speechPieces(text)) {
        const audio = await turn((resident) => (options.signal?.aborted ? Promise.resolve(undefined) : this.speakPiece(resident, piece, options)));
        if (!audio) { cut = true; return; }
        parts.push(audio.samples);
        rate = audio.sampleRate;
      }
    });
    if (cut) throw stopped();
    if (parts.length === 1) return { samples: parts[0], sampleRate: rate };
    const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { samples.set(part, at); at += part.length; }
    return { samples, sampleRate: rate };
  }

  private async speakPiece(resident: Resident, text: string, options: SpeakOptions): Promise<MonoAudio> {
    const tts = resident.value as SherpaTts;
    const sid = Math.max(0, Math.min(Math.max(0, tts.numSpeakers - 1), Math.floor(options.sid ?? 0)));
    const speed = options.speed ?? 1;
    const generationConfig = new (this.addon().GenerationConfig)({ sid, speed, numSteps: options.steps ?? 6, extra: { lang: options.language } });
    const audio = await tts.generateAsync({ text, sid, speed, generationConfig });
    return { samples: audio.samples, sampleRate: audio.sampleRate || tts.sampleRate };
  }

  /** Drops every idle model now (the next use loads it again). */
  unloadIdle(): void {
    let dropped = false;
    for (const resident of [...this.residents.values()]) if (!resident.busy) { this.drop(resident); dropped = true; }
    if (dropped) (this.deps.collect ?? collectGarbage)();
  }

  private addon(): SherpaAddon { return (this.deps.addon ?? sherpa)(); }

  /** Runs `job` with the model resident, one call per model at a time; the idle timer restarts after it. */
  private use<T>(model: LocalSpeechModel, job: (resident: Resident) => Promise<T>, language?: string): Promise<T> {
    return this.hold(model, (turn) => turn(job), language);
  }

  /** Keeps the model resident while `body` runs; each `turn` is one call in the model's queue (another caller's call may come between two turns). */
  private async hold<T>(model: LocalSpeechModel, body: (turn: <R>(job: (resident: Resident) => Promise<R>) => Promise<R>) => Promise<T>, language?: string): Promise<T> {
    const resident = await this.load(model, language);
    resident.busy++;
    if (resident.timer) { clearTimeout(resident.timer); resident.timer = undefined; }
    const turn = <R>(job: (held: Resident) => Promise<R>): Promise<R> => {
      const run = resident.queue.then(() => {
        if (!resident.value) throw new WorkforceError('unavailable', `${model.label} was unloaded. Try again.`);
        return job(resident);
      });
      resident.queue = run.catch(() => undefined);
      return run;
    };
    try { return await body(turn); } finally {
      resident.busy--;
      if (!resident.busy) this.idle(resident);
    }
  }

  private idle(resident: Resident): void {
    resident.timer = setTimeout(() => {
      if (resident.busy || this.residents.get(resident.model.id) !== resident) return;
      this.drop(resident);
      (this.deps.collect ?? collectGarbage)();
      this.deps.log.info('local speech model unloaded (idle)', { model: resident.model.id });
    }, this.deps.idleMs ?? IDLE_MS);
    (resident.timer as { unref?: () => void }).unref?.();
  }

  private drop(resident: Resident): void {
    if (resident.timer) clearTimeout(resident.timer);
    resident.timer = undefined;
    resident.value = null;
    resident.queue = Promise.resolve();
    this.residents.delete(resident.model.id);
  }

  private load(model: LocalSpeechModel, language?: string): Promise<Resident> {
    const known = this.residents.get(model.id);
    if (known) return Promise.resolve(known);
    const running = this.loading.get(model.id);
    if (running) return running;
    const job = this.create(model, language).finally(() => this.loading.delete(model.id));
    this.loading.set(model.id, job);
    return job;
  }

  private async create(model: LocalSpeechModel, language?: string): Promise<Resident> {
    const dataDir = this.deps.dataDir();
    if (!isInstalled(dataDir, model)) throw new WorkforceError('unavailable', `${model.label} is not downloaded on this PC (${VOICES}).`);
    const addon = this.addon();
    this.makeRoom(model);
    const dir = modelDir(dataDir, model);
    const threads = threadsFor(this.deps.cpuCores?.() ?? os.availableParallelism?.() ?? os.cpus().length);
    const started = Date.now();
    let value: SherpaRecognizer | SherpaTts;
    try {
      value = model.purpose === 'tts'
        ? await addon.OfflineTts.createAsync(ttsConfig(model, dir, threads))
        : await addon.OfflineRecognizer.createAsync(recognizerConfig(model, dir, threads, language ?? model.languages[0] ?? 'en'));
    } catch (error) {
      this.deps.log.warn('local speech model failed to load', { model: model.id, error: String(error) });
      throw new WorkforceError('unavailable', `${model.label} could not be loaded. Download it again (${VOICES}).`);
    }
    const resident: Resident = { model, value, queue: Promise.resolve(), busy: 0, language };
    this.residents.set(model.id, resident);
    this.deps.log.info('local speech model loaded', { model: model.id, ms: Date.now() - started, threads });
    return resident;
  }

  /** Unloads idle models of other ids when memory is short, then refuses a large model when it is still far too little (G4). */
  private makeRoom(model: LocalSpeechModel): void {
    const free = () => this.deps.freeMemoryMb?.() ?? Math.round(os.freemem() / 1_048_576);
    if (free() < model.ramMb) {
      let dropped = false;
      for (const other of [...this.residents.values()]) if (other.model.id !== model.id && !other.busy) { this.drop(other); dropped = true; }
      if (dropped) (this.deps.collect ?? collectGarbage)();
    }
    if (model.ramMb <= SMALL_MODEL_MB) return;
    const left = free();
    if (left < model.ramMb * MIN_FREE_SHARE) {
      throw new WorkforceError('unavailable', `Not enough free memory for ${model.label}: it needs about ${model.ramMb} MB, ${left} MB are free. Close some programs or choose a smaller model (${VOICES}).`, { details: { memory: true } });
    }
  }

  private canaryLanguage(resident: Resident, language: string): void {
    const recognizer = resident.value as SherpaRecognizer;
    const config = recognizer.config as { modelConfig?: { canary?: { srcLang?: string; tgtLang?: string } } };
    if (!config.modelConfig?.canary) return;
    config.modelConfig.canary.srcLang = language;
    config.modelConfig.canary.tgtLang = language;
    recognizer.setConfig(recognizer.config);
    resident.language = language;
  }

  /** The pieces of a 16 kHz recording (segments.ts): the VAD's speech packed into chunks, else quiet cuts of long takes. */
  private async utterances(samples: Float32Array, model: LocalSpeechModel): Promise<Piece[]> {
    const dataDir = this.deps.dataDir();
    if (!isInstalled(dataDir, SILERO_VAD)) return quietCuts(samples);
    let vad: SherpaVad;
    try {
      vad = new (this.addon().Vad)(vadConfig(path.join(modelDir(dataDir, SILERO_VAD), SILERO_VAD.files[0])), Math.ceil(samples.length / RATE) + 5);
    } catch (error) {
      this.deps.log.warn('silero vad failed to load', { error: String(error) });
      return quietCuts(samples);
    }
    const spans: Span[] = [];
    const take = () => { while (!vad.isEmpty()) { const front = vad.front(false); spans.push({ start: front.start, end: front.start + front.samples.length }); vad.pop(); } };
    const step = 512;
    try {
      for (let at = 0; at < samples.length; at += step) {
        vad.acceptWaveform(samples.subarray(at, Math.min(samples.length, at + step)));
        take();
        if (at % (step * 64) === 0) await new Promise<void>((resolve) => setImmediate(resolve)); // ~2 s of audio per slice: the loop stays responsive
      }
      vad.flush();
      take();
    } catch (error) {
      this.deps.log.warn('silero vad failed', { error: String(error) }); // review fix: the take is still heard, cut at its quiet moments
      return quietCuts(samples);
    }
    return piecesOf(samples, packSpeech(spans, samples.length, RATE, WHOLE_SECONDS, padFor(model.kind)));
  }
}
