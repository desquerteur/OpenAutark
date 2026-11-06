// B-058 G1: this PC's own speech model is the dictation path without a click. Once – while no local model is
// chosen, no speech-to-text service is chosen in settings (routing.stt) and the local engine loads on
// this PC – the runtime downloads the model fitLocalSpeech recommends for the person's speech language (with
// Silero VAD) in the background, from the first start on (no wait for the first run): LocalSpeech.pull(id,
// { auto }) – 'voice.pull' events with `auto: true` (the status line, and the mic's "Speech model downloading
// NN %", ui/lib/dictation.ts) – then voice.localStt, so the next dictation uses it (still only when nothing was
// chosen meanwhile). Not again after it ran (kv voice.local/autoStt), nor after the person removed a local model
// on purpose (localStt from an id to '' – remembered there), nor while the disk is low (LOW_DISK_BYTES must stay
// free after it); a failed download is tried again at the next start, at most MAX_TRIES times. It starts
// START_DELAY_MS after the runtime and on settings changes – one timer, nothing polls. An isolated test profile
// (WORKFORCE_TEST_DATA) never downloads by itself.
// ensureTagger(): the audio tagger (AUDIO_TAGGER, download only) once, on demand.
// Owns: when the automatic download runs, its kv record, ensureTagger. Never: downloads more than the one
// recommended model (and the VAD), or changes a setting other than through the pull.

import { statfs } from 'node:fs/promises';
import type { RuntimeServices } from '../../contracts.ts';
import { AUDIO_TAGGER, SILERO_VAD, localSpeechModel, type LocalSpeechModel } from '../../../shared/model/local-speech-models.ts';
import type { Settings } from '../../../shared/model/system.ts';
import { USE_AUTO, useValue } from '../../../shared/model/models-uses.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { KvRepo } from '../../store/kv.ts';
import { installModel, type DownloadFetch } from './download.ts';
import type { LocalSpeech } from './service.ts';
import { isInstalled, speechRoot } from './store.ts';

export const AUTO_NS = 'voice.local';
export const AUTO_KEY = 'autoStt';
export const START_DELAY_MS = 30_000;
/** Disk space that must stay free after the automatic download. */
export const LOW_DISK_BYTES = 2_000_000_000;
export const MAX_TRIES = 3;

/** The kv record: 'running' left by a stopped runtime counts as a failed try. */
export interface AutoRecord { state: 'running' | 'done' | 'failed' | 'declined'; id?: string; tries: number; at: number }

type Kv = Pick<KvRepo, 'get' | 'set'>;

export interface LocalSpeechAutoDeps {
  services: () => RuntimeServices;
  local: LocalSpeech;
  kv?: Kv;
  /** Free bytes on the disk of `dir` (default statfs; undefined = unknown, not checked). */
  freeDisk?: (dir: string) => Promise<number | undefined>;
  delayMs?: number;
  /** Default: not in an isolated test profile (WORKFORCE_TEST_DATA – no network download there, like the updater). */
  enabled?: boolean;
}

/** The settings that keep the automatic download away: a local model or a speech-to-text service chosen. */
export function settingsBlock(settings: Settings | undefined): string | undefined {
  if (!settings) return 'no settings';
  if (settings.voice?.localStt) return 'chosen';
  if (useValue(settings.routing, 'stt') !== USE_AUTO) return 'service chosen'; // a service chosen, or speech to text off
  return undefined;
}

async function diskFree(dir: string): Promise<number | undefined> {
  try { const info = await statfs(dir); return Number(info.bavail) * Number(info.bsize); } catch { return undefined; }
}

export class LocalSpeechAuto {
  private readonly deps: LocalSpeechAutoDeps;
  private offs: Array<() => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private armed = false; // the start delay is over
  private job?: Promise<void>;
  private tried = false; // one try per runtime start
  private lastStt?: string;

  constructor(deps: LocalSpeechAutoDeps) { this.deps = deps; }

  start(): void {
    if (this.offs.length || !(this.deps.enabled ?? !process.env.WORKFORCE_TEST_DATA)) return;
    const s = this.deps.services();
    this.lastStt = this.settings()?.voice?.localStt || undefined;
    this.offs.push(s.bus.on('settings.updated', (settings) => this.changed(settings)));
    this.timer = setTimeout(() => { this.timer = undefined; this.armed = true; void this.check(); }, this.deps.delayMs ?? START_DELAY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The running automatic download (tests). */
  running(): Promise<void> | undefined { return this.job; }

  private kv(): Kv { return this.deps.kv ?? new KvRepo(this.deps.services().db); }

  private settings(): Settings | undefined {
    try { return this.deps.services().settings.get(); } catch { return undefined; }
  }

  private record(): AutoRecord | undefined {
    try { return this.kv().get<AutoRecord>(AUTO_NS, AUTO_KEY); } catch { return undefined; }
  }

  private write(record: Omit<AutoRecord, 'at'>): void {
    const now = this.deps.services().clock.now();
    try { this.kv().set(AUTO_NS, AUTO_KEY, { ...record, at: now }, now); } catch (error) { this.deps.services().log.warn('local speech auto record not saved', { error: String(error) }); }
  }

  private changed(settings: Settings | undefined): void {
    const stt = settings?.voice?.localStt || undefined;
    if (this.lastStt && !stt) this.write({ state: 'declined', id: this.lastStt, tries: this.record()?.tries ?? 0 }); // removed on purpose
    this.lastStt = stt;
    if (this.armed) void this.check();
  }

  /** Why nothing is downloaded now, or undefined (see the header). */
  private blocked(settings: Settings | undefined): string | undefined {
    const chosen = settingsBlock(settings);
    if (chosen) return chosen;
    const record = this.record();
    if (record && (record.state === 'done' || record.state === 'declined' || record.tries >= MAX_TRIES)) return 'done';
    return undefined;
  }

  /** Starts the automatic download when nothing blocks it; resolves when it ended (or did not start). */
  check(): Promise<void> {
    if (this.job || this.tried || this.blocked(this.settings())) return this.job ?? Promise.resolve();
    this.tried = true;
    this.job = this.run().finally(() => { this.job = undefined; });
    return this.job;
  }

  private async run(): Promise<void> {
    const s = this.deps.services();
    const { local } = this.deps;
    try { local.engine.check(); } catch { s.log.info('local speech auto download skipped: the engine does not load here'); return; }
    const pick = local.offers().find((row) => row.purpose === 'stt' && row.recommended);
    const model = localSpeechModel(pick?.id, 'stt');
    if (!pick || !model) return;
    if (pick.installed) { this.write({ state: 'declined', id: model.id, tries: 0 }); return; } // downloaded once and not chosen: the person's choice
    const needed = model.download.bytes + model.sizeMb * 1_000_000 + (local.installed(SILERO_VAD) ? 0 : SILERO_VAD.download.bytes) + LOW_DISK_BYTES;
    const free = await (this.deps.freeDisk ?? diskFree)(speechRoot(s.paths.data)).catch(() => undefined);
    if (free !== undefined && free < needed) { s.log.info('local speech auto download skipped: disk low', { model: model.id }); return; }
    const tries = (this.record()?.tries ?? 0) + 1;
    this.write({ state: 'running', id: model.id, tries });
    s.log.info('local speech auto download', { model: model.id, tries });
    try {
      await local.pull(model.id, { auto: true, choose: () => !settingsBlock(this.settings()) });
      this.write({ state: 'done', id: model.id, tries });
    } catch (error) {
      this.write({ state: 'failed', id: model.id, tries });
      s.log.warn('local speech auto download failed', { model: model.id, error: String(error) });
    }
  }
}

/**
 * B-058: the audio tagger downloaded once (download only, no setting) – for media/sounds.ts and the abilities
 * overview; 'voice.pull' events (id 'ced-mini', auto) while it loads. Resolves with the installed model.
 */
export async function ensureTagger(s: Pick<RuntimeServices, 'paths' | 'bus'>, options: { fetch?: DownloadFetch } = {}): Promise<LocalSpeechModel> {
  const dataDir = s.paths.data;
  if (isInstalled(dataDir, AUDIO_TAGGER)) return AUDIO_TAGGER;
  const total = AUDIO_TAGGER.download.bytes;
  const emit = (state: 'downloading' | 'unpacking' | 'done' | 'failed', done: number, error?: string) => s.bus.emit('voice.pull', { id: AUDIO_TAGGER.id, state, done, total, auto: true, ...(error ? { error } : {}) });
  try {
    await installModel(AUDIO_TAGGER, { dataDir, fetch: options.fetch, progress: (state, done) => emit(state, done) });
  } catch (error) {
    emit('failed', 0, error instanceof WorkforceError ? error.message : `${AUDIO_TAGGER.label} could not be downloaded.`); // review fix: user-safe text only (as service.ts pull)
    throw error;
  }
  emit('done', total);
  return AUDIO_TAGGER;
}
