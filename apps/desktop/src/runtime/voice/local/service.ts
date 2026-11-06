// B-047 D14: local speech as the runtime offers it – voice.localModels (the catalog fitted to this PC's
// memory and cores, which models are downloaded, and whether the engine loads here at all), voice.pullLocal
// (one download per model at a time – a second call joins it; a speech-to-text model brings Silero VAD
// along, fetched once even for two pulls at a time; progress as 'voice.pull' events; once installed it becomes settings.voice.localStt / localTts),
// voice.speak (one line of the chosen local voice as PCM16) and the hearing of a stored take for
// voice/transcribe.ts, which comes first whenever the model is downloaded and reads the take (readsTake).
// B-058 G6: it reads WAV/PCM itself and – when the host decodes (media/hear-any.ts pcmOf: the app window's
// Chromium) – every common compressed format. A WAV/PCM over hear-any.ts WHOLE_BYTES is read by span, never
// whole; a decode hears the first 20 minutes and says `partial` when the recording goes on. voice.speak stops
// after a caller's signal.
// B-058 G3: the language a model runs in never silently translates (modelLanguage, speechLanguage).
// B-058 G1: pull(id, { auto }) is also the runtime's own download (auto.ts); the tagger (purpose 'tagging',
// AUDIO_TAGGER) is downloaded like the others but never chosen as a setting.
// Owns: these rules, the pull jobs and their events, the language choice per model. Never: decodes
// compressed audio itself, sends audio anywhere, or changes a setting other than localStt / localTts.

import os from 'node:os';
import type { RuntimeServices } from '../../contracts.ts';
import { fitLocalSpeech, localSpeechModel, SILERO_VAD, type LocalSpeechModel, type LocalSpeechModels, type LocalSpeechOffer, type LocalSpeechPull, type SpeechHardware, type SpokenAudio } from '../../../shared/model/local-speech-models.ts';
import { pcm16Bytes, type MonoAudio } from '../../../shared/voice/wav.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { hearFormat, hostDecodes, pcmOf, WHOLE_BYTES } from '../../media/hear-any.ts';
import { partOf, type HeardPart } from '../transcribe-endpoint.ts';
import { systemEnvironment } from '../../settings/defaults.ts';
import { installModel, type DownloadFetch, type InstallDeps } from './download.ts';
import { LocalSpeechEngine } from './engine.ts';
import { decodeRecording, localFormat, localTranscript, type LocalTranscript } from './hear.ts';
import { isInstalled } from './store.ts';

const WHERE = 'Settings › Models';
export const MAX_SPEAK_CHARS = 2_000;
/** Lines waiting for the local voice at once (every device reads through one model). */
export const MAX_SPEAKING = 4;

export interface LocalSpeechDeps {
  services: () => RuntimeServices;
  engine?: LocalSpeechEngine;
  install?: (model: LocalSpeechModel, deps: InstallDeps) => Promise<void>;
  fetch?: DownloadFetch;
  hardware?: () => SpeechHardware;
  /** The OS locale (default: Intl, settings/defaults.ts systemEnvironment). */
  systemLocale?: () => string;
}

const code = (language: string | undefined) => /^([a-z]{2,3})(?:[-_]|$)/i.exec(language?.trim() ?? '')?.[1]?.toLowerCase();

/**
 * B-058 G3: the language the person speaks, for choosing a model: the profile language – except an English
 * one when the OS language is another (see modelLanguage) –, else the OS language, else English.
 */
export function speechLanguage(profile: string | undefined, system: string | undefined): string {
  const person = code(profile);
  const os = code(system);
  if (person && !(person === 'en' && os && os !== 'en')) return person;
  return os ?? person ?? 'en';
}

/**
 * B-058 G3: the language a model runs in – for Canary also the language it writes, so a wrong one silently
 * translates (German speech heard as 'en' came back in English, measured 29.10.2026). `hints`: the person's
 * language (the take's hint, then the profile language); `system`: the OS language. A recognizer hears in
 * the first hint it speaks – except an English one when the OS language is another one it speaks: the app is
 * English-only and the profile language is the one agents reply in, so an English profile on a German
 * Windows is no proof of English speech (a German speaker with an English profile gets German) –; else in
 * the OS language when it speaks it; else in its first language. A voice reads in the first hint it speaks
 * (the reply's language), with the same fallbacks.
 */
export function modelLanguage(model: LocalSpeechModel, hints: ReadonlyArray<string | undefined>, system?: string): string {
  const speaks = (lang: string | undefined): lang is string => lang !== undefined && model.languages.includes(lang);
  const person = hints.map(code).filter((lang): lang is string => Boolean(lang));
  const os = code(system);
  if (model.purpose === 'stt' && person[0] === 'en' && os !== 'en' && speaks(os)) return os;
  return person.find(speaks) ?? (speaks(os) ? os : model.languages[0] ?? 'en');
}

/**
 * B-058 G3 (review) for a transcription service or a listening model: the take's language hint, except an English
 * one on a PC whose OS language is another – no proof of English speech (see modelLanguage) – then none: those
 * detect the spoken language themselves (Whisper with language=en on German speech answers in English).
 */
export function serviceLanguage(hint: string | undefined, system: string | undefined): string | undefined {
  const person = code(hint);
  const os = code(system);
  return person === 'en' && os && os !== 'en' ? undefined : person;
}

/** This PC's speech `model` (downloaded) reads the take: WAV/PCM itself, other formats when the host decodes. */
export function readsTake(model: LocalSpeechModel | undefined, mime: string, name: string, hostDecodes: boolean): boolean {
  const format = hearFormat(mime, name);
  return Boolean(model) && (format === 'wav' || format === 'pcm' || (format === 'host' && hostDecodes));
}

export class LocalSpeech {
  readonly engine: LocalSpeechEngine;
  private readonly deps: LocalSpeechDeps;
  private readonly pulls = new Map<string, Promise<{ ok: true }>>();
  private readonly installs = new Map<string, Promise<void>>(); // part id → its running install (the VAD is shared)
  private speaking = 0;

  constructor(deps: LocalSpeechDeps) {
    this.deps = deps;
    const s = () => deps.services();
    this.engine = deps.engine ?? new LocalSpeechEngine({ dataDir: () => s().paths.data, log: { debug: (m, d) => s().log.debug(m, d), info: (m, d) => s().log.info(m, d), warn: (m, d) => s().log.warn(m, d), error: (m, d) => s().log.error(m, d) } });
  }

  private dataDir(): string { return this.deps.services().paths.data; }

  installed(model: LocalSpeechModel): boolean { return isInstalled(this.dataDir(), model); }

  /** The chosen speech-to-text model when it is downloaded. */
  sttModel(): LocalSpeechModel | undefined { return this.chosen('stt'); }

  /** The chosen local voice when it is downloaded. */
  ttsModel(): LocalSpeechModel | undefined { return this.chosen('tts'); }

  /** B-058 G6: the host decodes compressed audio for local hearing (hear-any.ts pcmOf). */
  hostDecodes(): boolean {
    try { return hostDecodes(this.deps.services()); } catch { return false; }
  }

  private chosen(purpose: 'stt' | 'tts'): LocalSpeechModel | undefined {
    let voice: { localStt?: string; localTts?: string } | undefined;
    try { voice = this.deps.services().settings.get().voice; } catch { return undefined; }
    const model = localSpeechModel(purpose === 'stt' ? voice?.localStt : voice?.localTts, purpose);
    return model && this.installed(model) ? model : undefined;
  }

  private profileLanguage(): string | undefined {
    try { return this.deps.services().settings.get().profile?.language; } catch { return undefined; }
  }

  private systemLocale(): string {
    try { return this.deps.systemLocale?.() ?? systemEnvironment().locale; } catch { return 'en'; }
  }

  /** B-058 G3: the language the person speaks (speechLanguage over the profile and the OS). */
  speechLanguage(): string { return speechLanguage(this.profileLanguage(), this.systemLocale()); }

  private hardware(): SpeechHardware {
    return this.deps.hardware?.() ?? { totalRamMb: Math.round(os.totalmem() / 1_048_576), freeRamMb: Math.round(os.freemem() / 1_048_576), cpuCores: os.availableParallelism?.() ?? os.cpus().length };
  }

  /** The fitted rows for the person's speech language. */
  offers(): LocalSpeechOffer[] {
    return fitLocalSpeech(this.hardware(), this.speechLanguage(), (id) => { const model = localSpeechModel(id); return Boolean(model && this.installed(model)); });
  }

  /** voice.localModels. */
  models(): LocalSpeechModels {
    const models = this.offers();
    try { this.engine.check(); return { models, engine: { ready: true } }; } catch (error) {
      return { models, engine: { ready: false, error: error instanceof WorkforceError ? error.message : 'The local speech engine could not be loaded on this PC.' } };
    }
  }

  /**
   * voice.pullLocal: downloads `id` (and Silero VAD with a speech-to-text model), then chooses it; the audio
   * tagger (B-058) is only downloaded. `auto`: the runtime's own download (G1, auto.ts) – its events say so;
   * `choose` (auto): asked once it is there – false keeps the settings as they are (the person chose meanwhile).
   */
  pull(id: string, options: { auto?: boolean; choose?: () => boolean } = {}): Promise<{ ok: true }> {
    const model = localSpeechModel(id);
    if (!model || model.purpose === 'vad') return Promise.reject(new WorkforceError('bad_request', `Unknown local speech model: ${id}.`));
    const running = this.pulls.get(model.id);
    if (running) return running;
    const job = this.run(model, options.auto === true, options.choose).finally(() => this.pulls.delete(model.id));
    this.pulls.set(model.id, job);
    return job;
  }

  private async run(model: LocalSpeechModel, auto: boolean, choose?: () => boolean): Promise<{ ok: true }> {
    const s = this.deps.services();
    const parts = model.purpose === 'stt' && !this.installed(SILERO_VAD) ? [SILERO_VAD, model] : [model];
    const total = parts.reduce((sum, part) => sum + part.download.bytes, 0);
    const emit = (progress: Omit<LocalSpeechPull, 'id' | 'total'>) => s.bus.emit('voice.pull', { id: model.id, total, ...progress, ...(auto ? { auto: true } : {}) });
    emit({ state: 'downloading', done: 0 });
    let base = 0;
    try {
      for (const part of parts) {
        await this.install(part, {
          dataDir: s.paths.data, fetch: this.deps.fetch,
          progress: (state, done) => { if (part === model || state === 'downloading') emit({ state, done: base + done }); },
        });
        base += part.download.bytes;
      }
    } catch (error) {
      const message = error instanceof WorkforceError ? error.message : `${model.label} could not be downloaded.`;
      s.log.warn('local speech download failed', { model: model.id, error: String(error) });
      emit({ state: 'failed', done: base, error: message });
      throw error instanceof WorkforceError ? error : new WorkforceError('unavailable', message);
    }
    if ((model.purpose === 'stt' || model.purpose === 'tts') && (choose?.() ?? true)) s.settings.update({ voice: model.purpose === 'stt' ? { localStt: model.id } : { localTts: model.id } });
    s.log.info('local speech model installed', { model: model.id, auto });
    emit({ state: 'done', done: total });
    return { ok: true };
  }

  /**
   * One install per file set at a time (review fix: two speech-to-text pulls at once both fetched Silero VAD
   * into the same .part file and broke each other's checksum); a second one waits for the first.
   */
  private install(part: LocalSpeechModel, deps: InstallDeps): Promise<void> {
    const running = this.installs.get(part.id);
    if (running) return running;
    const job = (this.deps.install ?? installModel)(part, deps).finally(() => this.installs.delete(part.id));
    this.installs.set(part.id, job);
    return job;
  }

  /** A stored take heard by the chosen local model (readsTake); `partial`: only its start was heard (the first 20 minutes). */
  async hear(input: { fileId: string; mime: string; name: string; language?: string; dictation: boolean }): Promise<LocalTranscript & { partial?: HeardPart }> {
    const model = this.sttModel();
    if (!model) throw new WorkforceError('unavailable', `No local speech model is downloaded on this PC (${WHERE}).`);
    const audio = await this.audioOf(input);
    const heard = await this.engine.transcribe(model, audio, modelLanguage(model, [input.language, this.profileLanguage()], this.systemLocale()));
    const out = localTranscript(heard, input.dictation);
    return audio.partial ? { ...out, partial: audio.partial } : out;
  }

  /** The take as mono samples: a WAV/PCM up to WHOLE_BYTES decoded here whole, a larger one by span and other formats by the host (hear-any.ts pcmOf). */
  private async audioOf(input: { fileId: string; mime: string; name: string }): Promise<MonoAudio & { partial?: HeardPart }> {
    const s = this.deps.services();
    const large = (s.files.get(input.fileId)?.size ?? 0) > WHOLE_BYTES; // B-058: a long WAV is never read whole (pcmOf reads its span)
    if (!localFormat(input.mime, input.name) || large) {
      try {
        const heard = await pcmOf(s, input.fileId);
        const partial = partOf(heard);
        return { samples: heard.samples, sampleRate: heard.sampleRate, ...(partial ? { partial } : {}) };
      } catch (error) {
        if (error instanceof WorkforceError) throw error;
        s.log.warn('host audio decode failed', { error: String(error) }); // review fix: a user-safe failure the caller falls back after
        throw new WorkforceError('unavailable', 'This recording could not be decoded on this PC.');
      }
    }
    const bytes = await s.files.read(input.fileId);
    try { return decodeRecording(bytes, input.mime, input.name); } catch {
      throw new WorkforceError('bad_request', 'This recording could not be read as WAV audio. Record again.');
    }
  }

  /** voice.speak: one line in the chosen local voice (`voice`: the speaker number, '0' …); after `signal` aborted no further sentence is spoken (engine.ts synthesize). */
  async speak(input: { text: string; voice?: string; language?: string; signal?: AbortSignal }): Promise<SpokenAudio> {
    const model = this.ttsModel();
    if (!model) throw new WorkforceError('unavailable', `No local voice is downloaded on this PC (${WHERE}).`);
    const text = input.text.replace(/\s+/g, ' ').trim();
    if (!text) return { audio: '', sampleRate: 0, durationMs: 0 };
    if (text.length > MAX_SPEAK_CHARS) throw new WorkforceError('bad_request', `One spoken line holds at most ${MAX_SPEAK_CHARS} characters.`);
    if (this.speaking >= MAX_SPEAKING) throw new WorkforceError('conflict', 'The local voice is busy. Try again in a moment.');
    const sid = /^\d{1,2}$/.test(input.voice ?? '') ? Number(input.voice) : 0;
    this.speaking++;
    try {
      const audio = await this.engine.synthesize(model, text, { sid, language: modelLanguage(model, [input.language, this.profileLanguage()], this.systemLocale()), signal: input.signal });
      const rate = audio.sampleRate || 24_000;
      return { audio: Buffer.from(pcm16Bytes(audio.samples)).toString('base64'), sampleRate: rate, durationMs: Math.round((audio.samples.length / rate) * 1000) };
    } finally { this.speaking--; }
  }
}
