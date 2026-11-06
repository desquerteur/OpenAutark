// The microphone feed of a voice conversation (pwa-conversation.ts runs the loop in this page, on the desktop
// and the phone alike): a level detector cuts utterances (MediaRecorder); each one is uploaded and handed to the
// sink, only while the microphone's view is 'listening' and not right after a reply was spoken (echo guard: its
// tail may still reach the microphone). Replies are read through the page's one speech output (device-speech.ts);
// while anything is read (and its tail) the capture takes nothing. Self barge-in (`bargeIn`): with the browser's
// echo cancellation on, a voice clearly above the reading's echo stops the reading and is taken at once
// (ui/lib/barge-in.ts); without it the echo guard stays as it was.
// Owns: the capture's microphone/recorder lifetime. Never: the conversation loop (shared/voice/conversation.ts),
// chat messages or reading aloud.

import type { VoiceSessionView } from '../../../shared/voice/conversation.ts';
import { uploadRef } from '../../lib/files.ts';
import { openMicrophone } from '../../lib/microphone.ts';
import type { Microphone, SampleListener } from '../../lib/microphone.ts';
import { UtteranceDetector, rms } from '../../lib/pcm.ts';
import { BargeInDetector, echoCancelled } from '../../lib/barge-in.ts';
import { deviceSpeech } from './device-speech.ts';

/** After a spoken reply its tail (room echo, a slow speaker) is not taken for the person. */
export const ECHO_TAIL_MS = 450;

/** The MediaRecorder surface a capture uses (a fake in tests). */
export interface RecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

/** Where captured speech goes: the page's conversation loop. */
export interface CaptureSink {
  /** One uploaded utterance. */
  utterance(micId: string, fileId: string): Promise<void>;
  /** Self barge-in: the person talks over this device's own reading; true when the reading stopped for it. */
  bargeIn?(micId: string): boolean;
}

export interface CaptureDeps {
  openMicrophone(onSamples: SampleListener): Promise<Microphone>;
  newRecorder(stream: MediaStream): RecorderLike;
  upload(blob: Blob, name: string): Promise<{ id: string }>;
  now(): number;
  /** This device reads something aloud now (or just stopped): the microphone may hear it (echo guard). */
  speaking?(): boolean;
}

export const browserCapture: CaptureDeps = {
  openMicrophone: (onSamples) => openMicrophone(onSamples),
  newRecorder: (stream) => new MediaRecorder(stream),
  upload: (blob, name) => uploadRef(blob, name),
  now: () => Date.now(),
  speaking: () => deviceSpeech.speaking(ECHO_TAIL_MS),
};

/** One conversation's microphone: opened first, bound to the microphone's id by the first `follow`. */
export class ConversationCapture {
  private readonly sink: CaptureSink;
  private readonly onFailure: (error: unknown) => void;
  private readonly deps: CaptureDeps;
  private micId: string | null = null;
  private status: VoiceSessionView['status'] = 'starting';
  private mic: Microphone | null = null;
  private recorder: RecorderLike | null = null;
  private readonly detector = new UtteranceDetector();
  private readonly barge = new BargeInDetector();
  private busy = false; // an utterance is being uploaded and handed over
  private closed = false;
  private quietUntil = 0;
  private aec = false; // the browser cancels this device's echo on the microphone
  private barged = false; // this take began by talking over the device's own reading

  constructor(sink: CaptureSink, onFailure: (error: unknown) => void, deps: CaptureDeps = browserCapture) {
    this.sink = sink;
    this.onFailure = onFailure;
    this.deps = deps;
  }

  get sessionId(): string | null { return this.micId; }

  /** Opens the microphone (blocks before the first `follow` are dropped). */
  async open(): Promise<void> {
    const mic = await this.deps.openMicrophone((samples) => this.samples(samples));
    if (this.closed) { mic.close(); return; } // stopped while the microphone opened
    this.mic = mic;
    this.aec = echoCancelled(mic.stream);
  }

  /** Follows the microphone's view; the first view binds the capture to its id. */
  follow(view: VoiceSessionView): void {
    if (this.closed) return;
    this.micId ??= view.id;
    if (view.id !== this.micId) return;
    if (this.status === 'speaking' && view.status !== 'speaking' && !this.barged) this.quietUntil = this.deps.now() + ECHO_TAIL_MS;
    if (view.status !== 'speaking') this.barge.stop();
    this.status = view.status;
  }

  close(): void {
    this.discard();
    this.closed = true;
    this.mic?.close();
    this.mic = null;
  }

  private samples(samples: Float32Array): void {
    const micId = this.micId;
    if (this.closed || !micId) return;
    const echo = this.deps.speaking?.() === true; // another reader of this device is heard aloud
    const now = this.deps.now();
    const level = rms(samples);
    if (this.status === 'speaking' && this.aec && this.sink.bargeIn && !this.busy && this.barge.feed(level, now) && this.sink.bargeIn(micId)) {
      this.barged = true; // talked over this device's own reading: take it now, no echo tail
      this.status = 'listening';
      this.quietUntil = 0;
      this.detector.reset();
      this.detector.feed(Number.POSITIVE_INFINITY, now); // the take has begun
      this.record();
      return;
    }
    if (this.status !== 'listening' || this.busy || now < this.quietUntil || (echo && !this.barged)) {
      this.discard(); // the loop ignores utterances while it transcribes or speaks
      this.detector.reset();
      return;
    }
    const edge = this.detector.feed(level, now);
    if (edge === 'start') this.record(); else if (edge === 'end') this.finish();
  }

  private record(): void {
    if (!this.mic || this.recorder) return;
    // Each take keeps its own chunks: the last data of a stopped take arrives after the next
    // take may already have started.
    const chunks: Blob[] = [];
    const recorder = this.deps.newRecorder(this.mic.stream);
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => void this.send(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    recorder.start(250);
    this.recorder = recorder;
  }

  private finish(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.barged = false;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  /** Drops a running take. */
  private discard(): void {
    const recorder = this.recorder;
    this.recorder = null;
    this.barged = false;
    if (!recorder || recorder.state === 'inactive') return;
    recorder.onstop = null;
    recorder.stop();
  }

  private async send(blob: Blob): Promise<void> {
    const micId = this.micId;
    if (this.closed || !micId || !blob.size) return;
    this.busy = true;
    try {
      const ref = await this.deps.upload(blob, 'Utterance.webm');
      if (!this.closed) await this.sink.utterance(micId, ref.id);
    } catch (error) {
      if (!this.closed) this.onFailure(error);
    } finally {
      this.busy = false;
    }
  }
}

// ------------------------------------------------------------------ speaking

export type { SpeechOutput } from './device-speech.ts';
export { browserSpeech } from './device-speech.ts';

/**
 * Mobile Safari reads aloud only after speech was started inside a tap: call this synchronously
 * in the "Start conversation" click (an empty utterance; nothing is heard).
 */
export function primeSpeech(): void {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
  try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* reading aloud may still work */ }
}
