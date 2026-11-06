// Speech to text for the person's dictation and conversations (RPC voice.transcribe) and agents hearing
// recordings (attachment transcripts, media.transcribe) – one instance, RuntimeServices.stt. One fixed order:
//   1. this PC's speech model (settings voice.localStt, local/service.ts) when it is downloaded and can read the
//      take (WAV/PCM itself; other formats through the desktop app's decoder, media/hear-any.ts);
//   2. else – also when the local model could not hear it (memory, a failed load, a format it cannot read) – the
//      speech-to-text function model (models/functions.ts: routing.stt, else the first connected one)
//      at its OpenAI-compatible /audio/transcriptions (transcribe-endpoint.ts), with the learned words as prompt;
//   3. else a listening model on a free or plan account (listen-transcribe.ts);
//   4. else the local model's reason, or "not set up" (the composer keeps the recording).
// A dictation the recognizer heard no words in is empty text ({ text: '' }), not a failure (SM9); agent hearing
// keeps the "no usable text" error. A service or a listener gets no English hint on a PC whose OS speaks another
// language (local/service.ts serviceLanguage: it detects). A decode hears a recording's first 20 minutes: such a
// result is `partial`, and an agent transcript then starts with partialNote's line. A heard dictation take (the
// caller's fresh upload only) goes to the blob clean-up, due after a hold (files/cleanup.ts).
// Owns: that order, the transcript cache in the file's text column (secret-redacted, one agent transcription at a
// time) and user-safe errors. Never: logs or returns the key or the provider's raw error body, or sends audio
// anywhere but the one endpoint or listener.

import type { RuntimeServices, SpeechToText, SpeechToTextState } from '../contracts.ts';
import type { VoiceApi } from '../rpc/extras.ts';
import type { Account } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { vocabularyPrompt } from '../../shared/voice/vocabulary.ts';
import { endpointFor } from '../engines/http/common.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { functionStatus } from '../models/functions.ts';
import { FileRepo } from '../store/files.ts';
import type { LocalSpeechModels, SpokenAudio } from '../../shared/model/local-speech-models.ts';
import { readsTake, serviceLanguage, type LocalSpeech } from './local/service.ts';
import { systemEnvironment } from '../settings/defaults.ts';
import { canListen, listenerReady, listenTranscript } from './listen-transcribe.ts';
import { endpointHeard, partialNote, uploadOf, uploadWay, type FetchFn, type Heard } from './transcribe-endpoint.ts';
import type { Listener } from '../decision/engine-runner.ts';

export { audioExtension, LANGUAGES_FIELD, languageCode, MAX_AUDIO_BYTES, PIECE_MS } from './transcribe-endpoint.ts';
export type { FetchFn, Heard, HeardPart } from './transcribe-endpoint.ts';

/** Providers without an OpenAI-compatible /audio/transcriptions (plans, CLIs, media-only APIs). */
const NO_TRANSCRIPTION = new Set(['codex', 'claude', 'anthropic', 'gemini-cli', 'copilot', 'kimi-cli', 'elevenlabs', 'fal']);
const NOT_SET_UP = 'Speech to text is not set up yet: this PC downloads its speech model by itself (Settings › Models › Speech to text), or connect an OpenAI or OpenAI-compatible account with a transcription model.';
/** A dictation transcribes the take it uploaded just before (the run itself takes ≤ 120 s) … */
export const FRESH_TAKE_MS = 5 * 60_000;
/** … and its heard take waits this long for the clean-up (a client whose connection dropped attaches it meanwhile). */
export const HEARD_TAKE_HOLD_MS = 10 * 60_000;

export interface TranscriberDeps {
  services: () => RuntimeServices;
  fetch?: FetchFn;
  timeoutMs?: number; // per request, default 120 s
  /** This PC's local speech models (absent: the service and listener only). */
  local?: LocalSpeech;
  /** The listening turn (default: decision/engine-runner.ts createListener over the services; tests). */
  listener?: Listener;
  /** The OS locale (default: Intl, settings/defaults.ts systemEnvironment). */
  systemLocale?: () => string;
  /** The longest decoded piece one request uploads (default transcribe-endpoint.ts PIECE_MS; tests). */
  pieceMs?: number;
}

export class Transcriber implements VoiceApi, SpeechToText {
  private readonly deps: TranscriberDeps;
  private readonly hearing = new Map<string, Promise<string>>(); // fileId → agent transcription
  private queue: Promise<unknown> = Promise.resolve(); // agent transcriptions run one at a time

  constructor(deps: TranscriberDeps) {
    this.deps = deps;
  }

  state(): SpeechToTextState {
    try {
      const s = this.deps.services();
      if (this.deps.local?.sttModel()) return 'ready'; // this PC's own model
      const status = functionStatus(s, 'stt');
      if (status.off) return 'off';
      if (!status.choice) return listenerReady(s) ? 'ready' : 'missing';
      const account = s.accounts.get(status.choice.accountId);
      return account?.enabled && !NO_TRANSCRIPTION.has(account.provider) ? 'ready' : 'missing';
    } catch {
      return 'missing';
    }
  }

  /**
   * Dictation and conversations (RPC voice.transcribe), nothing cached; '' when no words were heard. A heard take
   * only carried its words, so it goes to the blob clean-up – due after the hold, since the runtime cannot tell
   * whether the answer arrived – and only the caller's fresh upload (a chat device may name any file here). The
   * clean-up keeps what a draft or a message uses; a failed take stays: the composer may attach it.
   */
  async transcribe(input: { fileId: string; language?: string }): Promise<Heard> {
    const heard = await this.run(input, true);
    try { this.release(input.fileId); } catch { /* the clean-up logs its own failures */ }
    return heard;
  }

  /** Queues the caller's fresh take for the blob clean-up, due after HEARD_TAKE_HOLD_MS (see transcribe). */
  private release(fileId: string): void {
    const s = this.deps.services();
    const now = s.clock.now();
    const take = s.files.get(fileId);
    if (!take || now - take.createdAt > FRESH_TAKE_MS) return;
    reclaimerOf(s.files)?.reclaim([fileId], { notBefore: now + HEARD_TAKE_HOLD_MS });
  }

  transcript(fileId: string): Promise<string> {
    const known = this.cached(fileId);
    if (known) return Promise.resolve(known);
    const running = this.hearing.get(fileId);
    if (running) return running;
    const job = this.queue.then(() => this.hear(fileId));
    this.queue = job.catch(() => undefined);
    this.hearing.set(fileId, job);
    const done = () => { this.hearing.delete(fileId); };
    job.then(done, done);
    return job;
  }

  /** One queued agent transcription: recognized text (after partialNote's line when only the start was heard), redacted, cached for every later reader. */
  private async hear(fileId: string): Promise<string> {
    const known = this.cached(fileId); // an earlier caller in the queue may have heard it already
    if (known) return known;
    const s = this.deps.services();
    const heard = await this.run({ fileId }, false);
    const text = heard.partial ? `${partialNote(heard.partial)}\n${heard.text}` : heard.text;
    let clean = text;
    try { clean = s.secrets.redact(text); } catch { /* vault locked: the context redacts again before any engine sees it */ }
    try { new FileRepo(s.db).setText(fileId, clean); } catch (error) { s.log.debug('transcript not cached', { fileId, error: String(error) }); }
    return clean;
  }

  private cached(fileId: string): string | undefined {
    try { return new FileRepo(this.deps.services().db).cachedText(fileId) || undefined; } catch { return undefined; }
  }

  private async run(input: { fileId: string; language?: string }, dictation: boolean): Promise<Heard> {
    const s = this.deps.services();
    const ref = s.files.get(input.fileId);
    if (!ref) throw new WorkforceError('not_found', 'The recording was not found. Record again.');
    if (!ref.size) throw new WorkforceError('bad_request', 'The recording is empty. Record again.');
    let failed: WorkforceError | undefined; // this PC's model could not hear the take
    const local = this.deps.local;
    const model = local?.sttModel();
    const decodes = local?.hostDecodes() ?? false;
    if (model && !readsTake(model, ref.mime, ref.name, decodes)) {
      failed = new WorkforceError('bad_request', decodes ? "This PC's speech model cannot read this recording format." : "This PC's speech model reads WAV recordings only; this recording is compressed.");
    }
    else if (local && model) {
      let heard: Heard | undefined;
      try {
        heard = await local.hear({ fileId: input.fileId, mime: ref.mime, name: ref.name, language: input.language, dictation });
      } catch (error) {
        if (!(error instanceof WorkforceError)) throw error;
        failed = error;
        s.log.info('local transcription falls back', { code: error.code });
      }
      if (heard) {
        // No words heard is no failure to fall back after (silence must not go on to a paid service).
        if (!heard.text && !dictation) throw new WorkforceError('unavailable', 'The transcription returned no usable text.');
        return heard;
      }
    }
    const status = functionStatus(s, 'stt');
    const hint = serviceLanguage(input.language, this.systemLocale()); // no 'en' for speech of another language
    if (status.choice && !status.off) return this.endpoint(s, ref, status.choice, hint, dictation);
    if (!status.off && canListen(s, ref)) {
      try {
        const text = await listenTranscript(s, ref, hint, this.deps.listener);
        if (!text && !dictation) throw new WorkforceError('unavailable', 'The transcription returned no usable text.');
        return { text };
      } catch (error) {
        if (!failed) throw error;
        s.log.info('listening fallback failed', { code: error instanceof WorkforceError ? error.code : 'internal' });
      }
    }
    if (failed) throw failed; // the local model's reason (memory, blocked engine) is the one the person can act on
    if (status.off) throw new WorkforceError('unavailable', 'Speech to text is turned off (routing.stt in settings.json).');
    throw new WorkforceError('unavailable', status.settingUnavailable
      ? 'The chosen speech-to-text model is not available. Connect its account again or choose another one (routing.stt in settings.json).'
      : NOT_SET_UP);
  }

  /** The take heard by the speech-to-text function model's transcription endpoint. */
  private async endpoint(s: RuntimeServices, ref: { id: string; mime: string; name: string; size: number }, choice: { accountId: string; model: string }, language: string | undefined, dictation: boolean): Promise<Heard> {
    const account: Account | undefined = s.accounts.get(choice.accountId);
    if (!account || !account.enabled) throw new WorkforceError('unavailable', 'The speech-to-text account is not available. Turn it on or connect another one (Settings › Models).');
    if (NO_TRANSCRIPTION.has(account.provider)) throw new WorkforceError('bad_request', 'This account offers no transcription endpoint. Connect an OpenAI or OpenAI-compatible account (Settings › Models).');
    let url: string;
    try { url = `${endpointFor(account)}/audio/transcriptions`; } catch (error) {
      throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'The transcription account has no valid server URL.');
    }
    const way = uploadWay(s, ref); // as it is, or decoded (over 25 MB, a format the endpoint does not take)
    let key: string | undefined;
    try { key = await s.accounts.apiKey(account.id); } catch { key = undefined; }
    let prompt: string | undefined;
    try { prompt = vocabularyPrompt(s.settings.get().voice?.vocabulary); } catch { prompt = undefined; }
    try {
      const upload = await uploadOf(s, ref, way, this.deps.pieceMs);
      return await endpointHeard({ url, key, model: choice.model, language, prompt, dictation, fetch: this.deps.fetch ?? fetch, timeoutMs: this.deps.timeoutMs ?? 120_000 }, upload);
    } catch (error) {
      if (error instanceof WorkforceError) throw error;
      throw new WorkforceError('unavailable', 'The transcription failed.');
    }
  }

  private systemLocale(): string | undefined {
    try { return this.deps.systemLocale?.() ?? systemEnvironment().locale; } catch { return undefined; }
  }

  localModels(): LocalSpeechModels { return this.localSpeech().models(); }
  pullLocal(id: string): Promise<{ ok: true }> { return this.localSpeech().pull(id); }
  /** `signal`: the caller gave up (stop, deadline) – the local voice speaks no further sentence (local/engine.ts). */
  speak(input: { text: string; voice?: string; language?: string; signal?: AbortSignal }): Promise<SpokenAudio> { return this.localSpeech().speak(input); }

  private localSpeech(): LocalSpeech {
    if (!this.deps.local) throw new WorkforceError('unavailable', 'Local speech is not available in this runtime.');
    return this.deps.local;
  }
}
