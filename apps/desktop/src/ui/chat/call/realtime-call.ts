// Realtime voice on this device (the chat header's call cell with settings.voice.realtime 'auto', CallHeader.tsx):
// the microphone at 24 kHz PCM16 goes to the runtime in ~100 ms pieces (calls.realtimeSend – the provider
// connection and its key stay in the runtime), the answer audio comes back through a long poll
// (calls.realtimePull: each call waits for the runtime's next events, nothing ticks) and is played gap-free
// in order; when the person talks over it ('interrupted') playback stops at once and the runtime is told
// how much was heard. When it ends by itself the chat's voice conversation takes over (CallHeader.tsx). The
// audio output is made inside the tap (prepareRealtimeOutput) – mobile browsers keep a context made later
// suspended, so no answer would be heard. AF-015: the call view reads its state (realtimeOpened, realtimeAnswering) and
// levels (each microphone block's RMS, the answer through an output meter); a muted call sends silence.
// Owns: capture, playback and the two loops of one session. Never: provider protocol, keys, or the chat.

import { signal } from '@preact/signals';
import type { RealtimeOut } from '../../../shared/model/call.ts';
import { REALTIME_RATE } from '../../../shared/model/call.ts';
import { openMicrophone } from '../../lib/microphone.ts';
import type { Microphone, SampleListener } from '../../lib/microphone.ts';
import { Pcm16Encoder, pcm16ToFloat } from '../../lib/pcm.ts';
import { bridge } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';
import { toastError } from '../../lib/toasts.ts';
import { micBlocked, outputMeter, reportMicLevel } from './call-levels.ts';
import { rms } from '../../lib/pcm.ts';

const CHUNK_BYTES = 4800; // 100 ms of 24 kHz PCM16

/** The chat whose realtime session runs on this device (null: none). */
export const realtimeChat = signal<string | null>(null);
/** AF-015: the session is open (its provider connection stands). */
export const realtimeOpened = signal(false);
/** AF-015: the model's answer plays now (from 'speaking' to 'done' or 'interrupted'). */
export const realtimeAnswering = signal(false);

export interface RealtimeDeps {
  call: typeof rpc.call;
  openMicrophone(onSamples: SampleListener): Promise<Microphone>;
  /** Desktop: main arms the microphone for this page (a user gesture came first). */
  arm?(): Promise<void>;
  newOutput(): AudioContext;
  /** AF-015: each microphone block's RMS (the call view's level). */
  level?(rms: number): void;
  /** AF-015: the call is muted (or a call signal plays): silence goes out instead. */
  muted?(): boolean;
  /** AF-015: where answer audio connects (an output meter in front of the destination). */
  meter?(output: AudioContext): AudioNode;
}

const base64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const unbase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export class RealtimeCall {
  readonly conversationId: string;
  private readonly deps: RealtimeDeps;
  private sessionId: string | null = null;
  private mic: Microphone | null = null;
  private encoder: Pcm16Encoder | null = null;
  private pending: number[] = [];
  private output: AudioContext | null = null;
  private playing = new Set<AudioBufferSourceNode>();
  private playAt = 0;
  private answerStarted = 0; // output clock when the current answer began
  private closed = false;

  private readonly prepared: AudioContext | null;

  /** `output`: the audio output made in the tap (else one is made when the session opened). */
  constructor(conversationId: string, deps: RealtimeDeps, output?: AudioContext | null) {
    this.conversationId = conversationId;
    this.deps = deps;
    this.prepared = output ?? null;
  }

  async start(onEnd: (reason?: string) => void): Promise<void> {
    await this.deps.arm?.();
    const opened = await this.deps.call('calls.realtimeOpen', { conversationId: this.conversationId });
    if (this.closed) { void this.deps.call('calls.realtimeClose', { sessionId: opened.sessionId }).catch(() => undefined); return; }
    this.sessionId = opened.sessionId;
    realtimeOpened.value = true;
    this.output = this.prepared ?? this.deps.newOutput();
    this.mic = await this.deps.openMicrophone((samples, rate) => this.capture(samples, rate));
    void this.pullLoop(onEnd);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.mic?.close();
    this.mic = null;
    this.cut();
    const output = this.output ?? this.prepared;
    void output?.close().catch(() => undefined);
    this.output = null;
    if (this.sessionId) void this.deps.call('calls.realtimeClose', { sessionId: this.sessionId }).catch(() => undefined);
  }

  private capture(samples: Float32Array, rate: number): void {
    if (this.closed || !this.sessionId) return;
    const muted = this.deps.muted?.() === true;
    this.deps.level?.(muted ? 0 : rms(samples));
    if (muted) samples = new Float32Array(samples.length); // the provider hears a pause, never a cut-off word
    this.encoder ??= new Pcm16Encoder(rate, REALTIME_RATE);
    for (const byte of this.encoder.push(samples)) this.pending.push(byte);
    while (this.pending.length >= CHUNK_BYTES) {
      const chunk = Uint8Array.from(this.pending.splice(0, CHUNK_BYTES));
      void this.deps.call('calls.realtimeSend', { sessionId: this.sessionId, audio: base64(chunk) }).catch(() => undefined);
    }
  }

  private async pullLoop(onEnd: (reason?: string) => void): Promise<void> {
    let after = 0;
    while (!this.closed && this.sessionId) {
      let pull;
      try { pull = await this.deps.call('calls.realtimePull', { sessionId: this.sessionId, after }); } catch (error) { // a lost connection rejects it
        if (!this.closed) { this.stop(); onEnd((error as Error).message || 'Realtime voice stopped.'); }
        return;
      }
      for (const event of pull.events) this.handle(event);
      after = pull.next;
      if (pull.closed) { if (!this.closed) { this.stop(); onEnd(pull.closed); } return; }
    }
  }

  private handle(event: RealtimeOut): void {
    if (event.type === 'audio') this.play(unbase64(event.data));
    else if (event.type === 'speaking') { this.answerStarted = Math.max(this.output?.currentTime ?? 0, this.playAt); realtimeAnswering.value = true; }
    else if (event.type === 'done') realtimeAnswering.value = false;
    else if (event.type === 'interrupted') { realtimeAnswering.value = false; this.interrupted(); }
    else if (event.type === 'error') toastError(new Error(event.message), 'Realtime voice');
  }

  private play(pcm: Uint8Array): void {
    const output = this.output;
    if (!output || !pcm.byteLength) return;
    const samples = pcm16ToFloat(pcm);
    const buffer = output.createBuffer(1, samples.length, REALTIME_RATE);
    buffer.getChannelData(0).set(samples);
    const source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(this.deps.meter?.(output) ?? output.destination);
    this.playAt = Math.max(this.playAt, output.currentTime);
    source.start(this.playAt);
    this.playAt += buffer.duration;
    this.playing.add(source);
    source.onended = () => this.playing.delete(source);
  }

  /** The person talked over the answer: playback stops now and the runtime learns how much was heard. */
  private interrupted(): void {
    const output = this.output;
    if (!output || !this.playing.size) return;
    const heardMs = Math.max(0, (output.currentTime - this.answerStarted) * 1000);
    this.cut();
    if (this.sessionId) void this.deps.call('calls.realtimeInterrupt', { sessionId: this.sessionId, playedMs: Math.round(heardMs) }).catch(() => undefined);
  }

  private cut(): void {
    for (const source of this.playing) { try { source.stop(); } catch { /* already stopped */ } }
    this.playing.clear();
    this.playAt = this.output?.currentTime ?? 0;
  }
}

const browserDeps: RealtimeDeps = {
  call: rpc.call,
  openMicrophone: (onSamples) => openMicrophone(onSamples),
  arm: bridge ? () => bridge!.armMedia(['audio']) : undefined,
  newOutput: () => new AudioContext({ sampleRate: REALTIME_RATE }),
  level: (value) => reportMicLevel(value),
  muted: () => micBlocked(),
  meter: (output) => outputMeter(output),
};

let current: RealtimeCall | null = null;

/** The answer audio's output, made and resumed synchronously inside the tap; null where audio cannot play. */
export function prepareRealtimeOutput(): AudioContext | null {
  try {
    const output = browserDeps.newOutput();
    void output.resume?.().catch(() => undefined);
    return output;
  } catch { return null; }
}

/** A prepared output no session took. */
export function discardRealtimeOutput(output: unknown): void {
  if (output && typeof (output as AudioContext).close === 'function') void (output as AudioContext).close().catch(() => undefined);
}

/** Starts realtime voice in `conversationId` on this device (from a tap); `onEnd` runs once it stops by itself. */
export async function startRealtime(conversationId: string, onEnd: (reason?: string) => void, deps: RealtimeDeps = browserDeps, output?: AudioContext | null): Promise<void> {
  current?.stop();
  const call = new RealtimeCall(conversationId, deps, output);
  current = call;
  realtimeChat.value = conversationId;
  realtimeOpened.value = false;
  realtimeAnswering.value = false;
  const ended = (reason?: string) => { if (current === call) { current = null; realtimeChat.value = null; realtimeOpened.value = false; realtimeAnswering.value = false; } onEnd(reason); };
  try {
    await call.start(ended);
  } catch (error) {
    call.stop();
    if (current === call) { current = null; realtimeChat.value = null; realtimeOpened.value = false; }
    throw error;
  }
}

export function stopRealtime(): void {
  const call = current;
  current = null;
  realtimeChat.value = null;
  realtimeOpened.value = false;
  realtimeAnswering.value = false;
  call?.stop();
}
