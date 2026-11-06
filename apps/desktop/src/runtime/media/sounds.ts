// B-058 G9: which sounds occur when in a stored recording or video, heard on this PC – CED Mini audio
// tagging (sherpa-onnx AudioTagging, 527 AudioSet classes; shared/model/local-speech-models.ts AUDIO_TAGGER)
// over 16 kHz samples (media/hear-any.ts pcmOf), merged into time spans ("Music 0:00–0:42 (0.87)").
// Windows: one per cell of ≥ 1 s (≤ MAX_WINDOWS cells), each heard with
// context on both sides (window = 2 cells, 2 … 10 s); a window is never shorter than 1 s (CED aborts the
// whole process on inputs under ~0.2 s, measured 29.10.2026). compute() is synchronous: the loop yields to
// the event loop after every window and stops at a CPU budget (the report is then `partial`). One tagger
// per data folder, one tagging at a time, loaded on use (the local engine's memory rule: small, so never refused) and dropped after
// IDLE_MS; the model is downloaded once on demand (voice/local/download.ts: catalog URL, SHA-256; in the app
// through voice/local/auto.ts ensureTagger, whose 'voice.pull' events show the progress in the notice band).
// Owns: the tagger's residency, the window plan, the label → span merge and their texts. Never: sends
// audio anywhere, stores results, reads settings, or decodes files itself.

import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { AUDIO_TAGGER } from '../../shared/model/local-speech-models.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { sherpa, threadsFor } from '../voice/local/addon.ts';
import { ensureTagger } from '../voice/local/auto.ts';
import { installModel, type DownloadFetch, type InstallDeps } from '../voice/local/download.ts';
import { MIN_FREE_SHARE, SMALL_MODEL_MB } from '../voice/local/engine.ts';
import { isInstalled, modelDir } from '../voice/local/store.ts';

const RATE = 16_000;
/** A label counts in a window from this probability on; a window's top label already from WEAK. */
export const SOUND_THRESHOLD = 0.3;
export const WEAK_THRESHOLD = 0.2;
export const MAX_WINDOWS = 150;
/** CPU time one tagging may take (the windows after it are left out: partial). */
export const TAG_BUDGET_MS = 12_000;
export const IDLE_MS = 30_000;
const MIN_WINDOW = RATE;
const TOP_K = 5;
const MAX_LABELS = 12;
const MAX_SPANS = 6;

export interface SoundEvent { name: string; prob: number }
export interface SoundSpan { startMs: number; endMs: number }
export interface SoundLabel { label: string; peak: number; coveredMs: number; spans: SoundSpan[] }
/** The labels of [startMs, endMs) of a file (times in the file); partial = the CPU budget ended it early. */
export interface SoundReport { startMs: number; endMs: number; labels: SoundLabel[]; partial: boolean }

interface TaggerStream { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void }
export interface TaggerHandle { createStream(): TaggerStream; compute(stream: TaggerStream, topK: number): SoundEvent[] }
export interface TaggerAddon { AudioTagging?: new (config: Record<string, unknown>) => TaggerHandle }

/** "0:07", "12:00", "1:02:03" (whole seconds). */
export function timeText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** "0:12" for a moment (under 2 s), else "0:05–0:42". */
export const spanText = (span: SoundSpan): string =>
  (span.endMs - span.startMs < 2_000 ? timeText(span.startMs) : `${timeText(span.startMs)}–${timeText(span.endMs)}`);

/** The windows over `length` samples: cells tile them; each window centres its cell (shifted inside at the ends). */
export function tagWindows(length: number): { hop: number; windows: Array<{ from: number; to: number; cellFrom: number; cellTo: number }> } {
  const hop = Math.max(RATE, Math.ceil(length / MAX_WINDOWS / (RATE / 2)) * (RATE / 2));
  const size = Math.min(10 * RATE, Math.max(2 * RATE, 2 * hop));
  const windows: Array<{ from: number; to: number; cellFrom: number; cellTo: number }> = [];
  for (let cellFrom = 0; cellFrom < length; cellFrom += hop) {
    const cellTo = Math.min(length, cellFrom + hop);
    let from = Math.round((cellFrom + cellTo) / 2 - size / 2);
    let to = from + size;
    if (from < 0) { to -= from; from = 0; }
    if (to > length) { from = Math.max(0, from - (to - length)); to = length; }
    windows.push({ from, to, cellFrom, cellTo });
  }
  return { hop, windows };
}

/** Labels per cell → time spans (a gap of one cell is bridged); the strongest (time covered × peak) in order of their first span. */
export function mergeSounds(cells: Array<SoundSpan & { events: SoundEvent[] }>, hopMs: number): SoundLabel[] {
  const labels = new Map<string, SoundLabel>();
  for (const cell of cells) {
    const events = [...cell.events].filter((event) => typeof event?.name === 'string' && Number.isFinite(event.prob)).sort((a, b) => b.prob - a.prob);
    events.forEach((event, rank) => {
      if (event.prob < SOUND_THRESHOLD && (rank > 0 || event.prob < WEAK_THRESHOLD)) return;
      const label = event.name.trim();
      if (!label) return;
      let entry = labels.get(label);
      if (!entry) { entry = { label, peak: 0, coveredMs: 0, spans: [] }; labels.set(label, entry); }
      entry.peak = Math.max(entry.peak, Math.round(event.prob * 100) / 100);
      entry.coveredMs += cell.endMs - cell.startMs;
      const last = entry.spans.at(-1);
      if (last && cell.startMs - last.endMs <= hopMs) last.endMs = Math.max(last.endMs, cell.endMs);
      else entry.spans.push({ startMs: cell.startMs, endMs: cell.endMs });
    });
  }
  return [...labels.values()].sort((a, b) => b.coveredMs * b.peak - a.coveredMs * a.peak).slice(0, MAX_LABELS)
    .sort((a, b) => a.spans[0].startMs - b.spans[0].startMs || b.peak - a.peak);
}

/** One line per label: "Music 0:00–0:42, 1:10–1:30 (0.87)". */
export function soundsText(labels: readonly SoundLabel[]): string[] {
  return labels.map((entry) => {
    const spans = entry.spans.slice(0, MAX_SPANS).map(spanText).join(', ');
    const more = entry.spans.length > MAX_SPANS ? ` +${entry.spans.length - MAX_SPANS} more` : '';
    return `${entry.label} ${spans}${more} (${entry.peak.toFixed(2)})`;
  });
}

let gc: (() => void) | undefined;
function collectGarbage(): void {
  try {
    gc ??= (globalThis as { gc?: () => void }).gc ?? (v8.setFlagsFromString('--expose-gc'), vm.runInNewContext('gc') as () => void);
    gc();
  } catch { /* the memory returns at the next natural collection */ }
}

const NOT_DOWNLOADED = `${AUDIO_TAGGER.label}, the local sound model, is not downloaded on this PC yet.`;

export interface TaggerDeps {
  dataDir: () => string | undefined;
  log: Logger;
  addon?: () => TaggerAddon;
  install?: (model: typeof AUDIO_TAGGER, deps: InstallDeps) => Promise<void>;
  fetch?: DownloadFetch;
  freeMemoryMb?: () => number;
  cpuCores?: () => number;
  idleMs?: number;
  collect?: () => void;
  /** CPU clock for the budget (default performance.now). */
  now?: () => number;
}

export class SoundTagger {
  private readonly deps: TaggerDeps;
  private value: TaggerHandle | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pulling?: Promise<void>;

  constructor(deps: TaggerDeps) { this.deps = deps; }

  installed(): boolean {
    const dataDir = this.deps.dataDir();
    return Boolean(dataDir && isInstalled(dataDir, AUDIO_TAGGER));
  }

  /** Whether the model is in memory now. */
  loaded(): boolean { return this.value !== null; }

  /** Downloads the model once (a second caller joins the running download). */
  ensure(): Promise<void> {
    if (this.installed()) return Promise.resolve();
    const dataDir = this.deps.dataDir();
    if (!dataDir) return Promise.reject(new WorkforceError('unavailable', 'Sounds cannot be recognised in this runtime.'));
    this.pulling ??= (this.deps.install ?? installModel)(AUDIO_TAGGER, { dataDir, fetch: this.deps.fetch })
      .then(() => this.deps.log.info('sound model installed', { model: AUDIO_TAGGER.id }))
      .finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  /** The sounds of 16 kHz samples that start at `startMs` of their file; one tagging at a time. */
  tag(samples: Float32Array, opts: { startMs?: number; signal?: AbortSignal; budgetMs?: number } = {}): Promise<SoundReport> {
    const run = this.queue.then(() => this.run(samples, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Drops the model now when nothing uses it. */
  unload(): void {
    if (this.busy || !this.value) return;
    this.value = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    (this.deps.collect ?? collectGarbage)();
  }

  private async run(samples: Float32Array, opts: { startMs?: number; signal?: AbortSignal; budgetMs?: number }): Promise<SoundReport> {
    const startMs = Math.max(0, opts.startMs ?? 0);
    const ms = (count: number) => Math.round((count / RATE) * 1000);
    if (samples.length < RATE / 10) return { startMs, endMs: startMs + ms(samples.length), labels: [], partial: false };
    const tagger = this.load();
    const now = this.deps.now ?? (() => performance.now());
    const plan = tagWindows(samples.length);
    const budget = opts.budgetMs ?? TAG_BUDGET_MS;
    const cells: Array<SoundSpan & { events: SoundEvent[] }> = [];
    let spent = 0;
    let partial = false;
    this.busy++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      for (const window of plan.windows) {
        if (opts.signal?.aborted) throw new WorkforceError('cancelled', 'Stopped before the sounds were recognised.');
        if (spent >= budget) { partial = true; break; }
        let part = samples.subarray(window.from, window.to);
        if (part.length < MIN_WINDOW) { const padded = new Float32Array(MIN_WINDOW); padded.set(part); part = padded; }
        const began = now();
        const stream = tagger.createStream();
        stream.acceptWaveform({ samples: part, sampleRate: RATE });
        const events = tagger.compute(stream, TOP_K);
        spent += now() - began;
        cells.push({ startMs: startMs + ms(window.cellFrom), endMs: startMs + ms(window.cellTo), events: Array.isArray(events) ? events : [] });
        await new Promise<void>((resolve) => setImmediate(resolve)); // compute() blocks: let the runtime breathe between windows
      }
    } finally {
      this.busy--;
      this.idle();
    }
    const endMs = partial ? (cells.at(-1)?.endMs ?? startMs) : startMs + ms(samples.length);
    return { startMs, endMs, labels: mergeSounds(cells, ms(plan.hop)), partial };
  }

  private load(): TaggerHandle {
    if (this.value) return this.value;
    const dataDir = this.deps.dataDir();
    if (!dataDir || !isInstalled(dataDir, AUDIO_TAGGER)) throw new WorkforceError('unavailable', NOT_DOWNLOADED);
    const addon = (this.deps.addon ?? (() => sherpa() as unknown as TaggerAddon))();
    if (typeof addon.AudioTagging !== 'function') throw new WorkforceError('unavailable', 'The local speech engine on this PC cannot recognise sounds.');
    // B-058 G4, the local speech engine's rule (voice/local/engine.ts): a model of at most SMALL_MODEL_MB – the tagger –
    // always loads (Windows pages it in; its "free" memory read 105 MB with GBs to give); a larger one not when far too little is free.
    const free = this.deps.freeMemoryMb?.() ?? Math.round(os.freemem() / 1_048_576);
    if (AUDIO_TAGGER.ramMb > SMALL_MODEL_MB && free < AUDIO_TAGGER.ramMb * MIN_FREE_SHARE) throw new WorkforceError('unavailable', `Not enough free memory to recognise sounds: ${AUDIO_TAGGER.label} needs about ${AUDIO_TAGGER.ramMb} MB, ${free} MB are free.`);
    const dir = modelDir(dataDir, AUDIO_TAGGER);
    const threads = threadsFor(this.deps.cpuCores?.() ?? os.availableParallelism?.() ?? os.cpus().length);
    const started = Date.now();
    try {
      this.value = new addon.AudioTagging({
        model: { ced: path.join(dir, AUDIO_TAGGER.files[0]), numThreads: threads, provider: 'cpu', debug: 0 },
        labels: path.join(dir, AUDIO_TAGGER.files[1]), topK: TOP_K,
      });
    } catch (error) {
      this.deps.log.warn('sound tagger failed to load', { error: String(error) });
      throw new WorkforceError('unavailable', `${AUDIO_TAGGER.label} could not be loaded on this PC.`);
    }
    this.deps.log.info('sound tagger loaded', { ms: Date.now() - started, threads, freeMb: free });
    return this.value;
  }

  private idle(): void {
    if (this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.busy || !this.value) return;
      this.unload();
      this.deps.log.info('sound tagger unloaded (idle)', {});
    }, this.deps.idleMs ?? IDLE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/** What the local hearing reads: the data folder (the model), the log and – for the download's progress – the bus. */
export type SoundServices = Partial<Pick<RuntimeServices, 'paths' | 'log' | 'bus'>>;

const taggers = new Map<string, SoundTagger>();
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** The data folder's tagger (one per folder), or undefined in a runtime without one. */
export function soundTagger(s: SoundServices): SoundTagger | undefined {
  const { paths, bus } = s;
  const dataDir = paths?.data;
  if (!dataDir) return undefined;
  let tagger = taggers.get(dataDir);
  if (!tagger) {
    // With a bus the download is voice/local/auto.ts ensureTagger's: 'voice.pull' progress in the notice band (G1).
    const install = paths && bus ? (_model: typeof AUDIO_TAGGER, deps: InstallDeps) => ensureTagger({ paths, bus }, { fetch: deps.fetch }).then(() => undefined) : undefined;
    tagger = new SoundTagger({ dataDir: () => dataDir, log: s.log ?? quiet, install });
    taggers.set(dataDir, tagger);
  }
  return tagger;
}

/** Puts `tagger` in place for a data folder, or forgets it (tests). */
export function setSoundTagger(dataDir: string, tagger: SoundTagger | undefined): void {
  if (tagger) taggers.set(dataDir, tagger); else taggers.delete(dataDir);
}
