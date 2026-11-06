// Dictation, one path on the desktop and the phone: the microphone (microphone.ts, 16 kHz through the
// worklet tap) → the take as a 16 kHz mono WAV → files.upload → voice.transcribe → editable text. The
// runtime decides who hears it: this PC's speech model, else a transcription service, else a listening
// model (runtime/voice/transcribe.ts). While this PC's speech model still downloads and nothing else can
// hear, dictationNote() says "Speech model downloading NN %" (the mic shows it).
// One take at a time: a newer start tells the older caller its take ended, a start overtaken while the
// microphone opens throws DictationCancelled. A take whose transcription failed comes back as
// TakeNotTranscribed with its upload when it is worth attaching (≥ KEEP_TAKE_MS); an answer lost with the
// connection may still have been heard, so the take is stored again in the background (same bytes, same id).
// keep() only uploads the take (an audio attachment where nothing can transcribe).
// Owns: the take's microphone lifetime, its WAV and the "can this page dictate" note. Never: API keys or
// provider calls, audio sent anywhere but the runtime's blob store, a microphone left open after
// finish/keep/cancel.

import type { ResultOf } from '../../shared/api/methods.ts';
import { localSpeechModel } from '../../shared/model/local-speech-models.ts';
import { functionCandidates } from '../../shared/model/providers.ts';
import { useValue } from '../../shared/model/models-uses.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { languageHint } from '../../shared/voice/conversation.ts';
import { pullPercent, running } from '../settings/speech-models-text.ts';
import { speechPulls, watchSpeechPulls } from '../settings/speech-models.ts';
import { uploadRef } from './files.ts';
import { openMicrophone } from './microphone.ts';
import type { Microphone, SampleListener } from './microphone.ts';
import { LevelHistory, meterLevel, PCM_RATE, Pcm16Encoder, rms, wavFile } from './pcm.ts';
import { RpcError, rpc } from './rpc.ts';
import { blockedNote } from './session.ts';
import { models, settings } from './store.ts';
import { takeName } from './take-name.ts';

/** A take at least this long is handed back for attaching when its transcription failed. */
export const KEEP_TAKE_MS = 2000;
/** At most ~10 min of 16 kHz PCM16 (the upload limit is 20 MB); later audio is not kept. */
const MAX_BYTES = 600 * 32_000;
const BLOCK_MS = 32;

/** The running take's input levels (0..1, the waveform beside the mic button reads them). */
export const dictationLevels = new LevelHistory(48);

/** A finished take: its text ('' when nothing was heard). */
export interface DictationResult { text: string }

/** The transcription failed after the upload; `recording` is the take when it is worth attaching. */
export class TakeNotTranscribed extends Error {
  readonly recording?: FileRef;
  constructor(cause: unknown, recording?: FileRef) {
    super(cause instanceof Error && cause.message ? cause.message : 'The transcription failed.');
    this.name = 'TakeNotTranscribed';
    this.recording = recording;
  }
}

/** Thrown by a start that a newer start or a cancel overtook (double tap, another panel) – not a failure. */
export class DictationCancelled extends Error {
  constructor() {
    super('Dictation was cancelled.');
    this.name = 'DictationCancelled';
  }
}

export interface DictationDeps {
  /** Why this page cannot record (no microphone API, plain http), or undefined. */
  problem(): string | undefined;
  openMicrophone(onSamples: SampleListener): Promise<Microphone>;
  upload(blob: Blob, name: string): Promise<FileRef>;
  transcribe(params: { fileId: string; language?: string }): Promise<ResultOf<'voice.transcribe'>>;
  now(): number;
  /** The transcription call was lost with the connection, not answered (absent: never). */
  lost?(error: unknown): boolean;
}

interface Take {
  mic: Microphone | null;
  encoder: Pcm16Encoder | null;
  pcm: Uint8Array[];
  bytes: number;
  startedAt: number;
  onEnded?: () => void;
}

export class Dictation {
  private readonly deps: DictationDeps;
  private take: Take | null = null;
  /** Bumped by every start and cancel: a start that is no longer the latest gives up. */
  private starts = 0;

  constructor(deps: DictationDeps) {
    this.deps = deps;
  }

  /** A take holds the microphone. */
  get active(): boolean { return this.take !== null; }

  /** Opens the microphone and records. `onEnded` fires when a newer start takes the microphone. */
  async start(onEnded?: () => void): Promise<void> {
    const previous = this.take;
    if (previous) {
      this.cancel(); // one microphone at a time: the other caller is told its take ended
      previous.onEnded?.();
    }
    const ticket = ++this.starts;
    const problem = this.deps.problem();
    if (problem) throw new Error(problem);
    const take: Take = { mic: null, encoder: null, pcm: [], bytes: 0, startedAt: this.deps.now(), onEnded };
    this.take = take;
    dictationLevels.clear();
    let mic: Microphone;
    try {
      mic = await this.deps.openMicrophone((samples, rate) => this.heard(take, samples, rate));
    } catch (error) {
      if (this.take === take) this.take = null;
      throw error;
    }
    if (ticket !== this.starts || this.take !== take) { mic.close(); throw new DictationCancelled(); }
    take.mic = mic;
    take.startedAt = this.deps.now();
  }

  /** Stops the take and transcribes it ('' when nothing was recorded or heard); `language` is a hint ("de", "en-US"). */
  async finish(language?: string, { attachable = true }: { attachable?: boolean } = {}): Promise<DictationResult> {
    const recorded = this.stopTake();
    if (!recorded) return { text: '' };
    const ref = await this.deps.upload(recorded.blob, recorded.name);
    const lang = languageHint(language);
    let heard: ResultOf<'voice.transcribe'>;
    try {
      heard = await this.deps.transcribe(lang ? { fileId: ref.id, language: lang } : { fileId: ref.id });
    } catch (error) {
      const keep = attachable && recorded.lengthMs >= KEEP_TAKE_MS;
      // Sent again once the connection is back, before the draft that attaches the take is saved.
      if (keep && this.deps.lost?.(error)) void this.deps.upload(recorded.blob, recorded.name).catch(() => undefined);
      throw new TakeNotTranscribed(error, keep ? ref : undefined);
    }
    return { text: typeof heard?.text === 'string' ? heard.text.trim() : '' };
  }

  /** Stops the take and uploads it without transcribing (an audio attachment); null when empty. */
  async keep(): Promise<FileRef | null> {
    const recorded = this.stopTake();
    return recorded ? this.deps.upload(recorded.blob, recorded.name) : null;
  }

  /** Discards the take; a start still opening the microphone gives up, too. */
  cancel(): void {
    this.starts += 1;
    const take = this.take;
    this.take = null;
    take?.mic?.close();
  }

  private heard(take: Take, samples: Float32Array, rate: number): void {
    if (this.take !== take) return;
    dictationLevels.push(meterLevel(rms(samples)));
    take.encoder ??= new Pcm16Encoder(rate, PCM_RATE, { lowPass: true }); // at 16 kHz already: no resampling
    this.keepPcm(take, take.encoder.push(samples));
  }

  private keepPcm(take: Take, bytes: Uint8Array | undefined): void {
    if (!bytes?.byteLength || take.bytes + bytes.byteLength > MAX_BYTES) return;
    take.pcm.push(bytes);
    take.bytes += bytes.byteLength;
  }

  /** Detaches the take (a start or cancel meanwhile leaves it alone) and releases the microphone; null without audio. */
  private stopTake(): { blob: Blob; name: string; lengthMs: number } | null {
    const take = this.take;
    this.take = null;
    if (!take) return null;
    take.mic?.close();
    this.keepPcm(take, take.encoder?.flush()); // the resampler's delayed tail
    if (!take.bytes) return null;
    const blob = new Blob([wavFile(take.pcm).buffer as ArrayBuffer], { type: 'audio/wav' });
    return { blob, name: takeName('audio/wav', new Date(take.startedAt)), lengthMs: this.deps.now() - take.startedAt };
  }
}

// ------------------------------------------------------------------ this page

/** Why this browser cannot record, or undefined. */
export function recordingProblem(): string | undefined {
  const supported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioContext !== 'undefined';
  if (supported) return undefined;
  if (typeof isSecureContext === 'boolean' && !isSecureContext) return 'Open the HTTPS address to dictate: browsers allow the microphone only there.';
  return 'This browser cannot record audio.';
}

/** "Speech model downloading NN %" while this PC's first speech model downloads and no transcription service could hear meanwhile. */
function downloadNote(): string | undefined {
  watchSpeechPulls();
  const current = settings.value;
  if (current?.voice?.localStt) return undefined;
  if (functionCandidates('stt', useValue(current?.routing, 'stt'), models.value).length) return undefined; // a service hears meanwhile
  const pull = Object.values(speechPulls.value).find((entry) => running(entry) && localSpeechModel(entry.id)?.purpose === 'stt');
  if (!pull) return undefined;
  return pull.state === 'unpacking' ? 'Speech model unpacking…' : `Speech model downloading ${pullPercent(pull)} %`;
}

/** Why the mic gives no text on this page right now (reactive), or undefined when it can dictate. */
export function dictationNote(): string | undefined {
  return blockedNote('voice.transcribe') ?? blockedNote('files.upload') ?? recordingProblem() ?? downloadNote();
}

/** This page's dictation: the browser's microphone, the app's rpc. */
export const dictation = new Dictation({
  problem: recordingProblem,
  openMicrophone: (onSamples) => openMicrophone(onSamples, { sampleRate: PCM_RATE, blockMs: BLOCK_MS }),
  upload: (blob, name) => uploadRef(blob, name),
  transcribe: (params) => rpc.call('voice.transcribe', params),
  now: () => Date.now(),
  // rpc rejects every pending call with 'unavailable' once the connection is closed.
  lost: (error) => error instanceof RpcError && error.code === 'unavailable' && rpc.status.peek() !== 'open',
});
