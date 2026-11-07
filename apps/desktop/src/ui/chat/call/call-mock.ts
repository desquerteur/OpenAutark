// AF-015: the mock voice engine for tests and demos – a call without microphone, speaker or any speech key. It goes
// through the same phases as a real call and makes the same levels: it connects (calls.start opens the call's row in
// the chat), "the person" says the next scripted line (rising microphone levels, none while muted – a muted call waits),
// the line is sent like a spoken one (messages.send, marked live with the call's id), the call works until an agent of
// the chat answers (or MOCK_REPLY_WAIT_MS pass), then "the agent speaks" (playback levels as long as its words take)
// and listens again. Hanging up ends the call (calls.end), so the chat keeps its call card with the transcript.
// It runs only when this device asks for it (localStorage 'wf.callEngine' = 'mock', call-session.ts) – never by itself.
// Owns: the script's timing and levels. Never: real audio, transcription, or messages beyond its scripted lines.

import type { EventMap } from '../../../shared/api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../../../shared/api/methods.ts';
import type { CallPhase } from './call-model.ts';

/** What the mock needs of its page (fakes in tests). */
export interface MockCallDeps {
  call<M extends MethodName>(method: M, params?: ParamsOf<M>): Promise<ResultOf<M>>;
  on(event: 'message.created' | 'message.updated', listener: (message: EventMap['message.created']) => void): () => void;
  /** Runs `fn` once after `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  newId(): string;
  /** The person's microphone level (0..1 on the meter scale). */
  mic(level: number): void;
  /** The agent's playback level (0..1). */
  out(level: number): void;
  /** The phase changed. */
  phase(phase: CallPhase): void;
}

/** The person's lines, in order (the call then just listens). */
export const MOCK_LINES = [
  'Hi, can you hear me?',
  'What is the plan for today?',
  'Thanks, please send me the summary later.',
] as const;

export const MOCK_CONNECT_MS = 900;
export const MOCK_PAUSE_MS = 1200;
export const MOCK_TICK_MS = 80;
export const MOCK_REPLY_WAIT_MS = 8000;
/** How long the agent "speaks" per character of its answer (bounded). */
export const MOCK_MS_PER_CHAR = 45;

/** A smooth, speech-like level for tick `index` (deterministic: the same call looks the same every time). */
export function mockLevel(index: number): number {
  const wave = 0.55 + 0.3 * Math.sin(index * 0.9) + 0.15 * Math.sin(index * 2.3 + 1);
  return Math.max(0.2, Math.min(1, wave));
}

/** How long the agent speaks an answer of `text` (ms). */
export function speakingMs(text: string): number {
  return Math.min(6000, Math.max(1200, text.length * MOCK_MS_PER_CHAR));
}

export class MockCall {
  readonly conversationId: string;
  private readonly deps: MockCallDeps;
  private callId: string | null = null;
  private line = 0;
  private sentSeq: number | null = null;
  private muted = false;
  private stopped = false;
  private current: CallPhase = 'connecting';
  private cancel: (() => void) | null = null;
  private readonly off: () => void;
  private waiting = false; // a scripted line waits for the microphone (muted)

  constructor(conversationId: string, deps: MockCallDeps) {
    this.conversationId = conversationId;
    this.deps = deps;
    const listener = (message: EventMap['message.created']) => this.observe(message);
    const offCreated = deps.on('message.created', listener);
    const offUpdated = deps.on('message.updated', listener);
    this.off = () => { offCreated(); offUpdated(); };
  }

  get phase(): CallPhase { return this.current; }
  get id(): string | null { return this.callId; }

  /** Connects: the call's row opens, then the person speaks first. */
  async start(): Promise<void> {
    this.set('connecting');
    const opened = await this.deps.call('calls.start', { conversationId: this.conversationId });
    if (this.stopped) { void this.deps.call('calls.end', { callId: opened.callId }).catch(() => undefined); return; }
    this.callId = opened.callId;
    this.schedule(MOCK_CONNECT_MS, () => { this.set('listening'); this.schedule(MOCK_PAUSE_MS, () => this.say()); });
  }

  /** Mute: the person's lines wait; unmute: a waiting line is said now. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.deps.mic(0);
    else if (this.waiting && !this.stopped) { this.waiting = false; this.say(); }
  }

  /** Hang up: the call's row gets its end. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    this.off();
    this.deps.mic(0);
    this.deps.out(0);
    if (this.callId) void this.deps.call('calls.end', { callId: this.callId }).catch(() => undefined);
  }

  /** The person says the next line: levels for a moment, then it is sent. */
  private say(): void {
    if (this.stopped || this.current !== 'listening') return;
    const text = MOCK_LINES[this.line];
    if (text === undefined) return; // the script is over: the call just listens
    if (this.muted) { this.waiting = true; return; }
    const ticks = Math.max(8, Math.round(text.length * 40 / MOCK_TICK_MS));
    this.ticks(ticks, (index) => this.deps.mic(this.muted ? 0 : mockLevel(index)), () => {
      this.deps.mic(0);
      if (this.muted) { this.waiting = true; return; } // muted while saying it: said again once unmuted
      this.line += 1;
      void this.send(text);
    });
  }

  private async send(text: string): Promise<void> {
    this.set('working');
    try {
      const message = await this.deps.call('messages.send', {
        conversationId: this.conversationId, body: text, clientId: this.deps.newId(),
        speech: { source: 'endpoint', live: true, ...(this.callId ? { call: this.callId } : {}) },
      });
      if (this.stopped) return;
      this.sentSeq = message.seq;
      this.schedule(MOCK_REPLY_WAIT_MS, () => this.answered('')); // nobody answered: listen again
    } catch {
      if (!this.stopped) this.answered('');
    }
  }

  private observe(message: EventMap['message.created']): void {
    if (this.stopped || message.conversationId !== this.conversationId || this.sentSeq === null) return;
    if (message.authorKind !== 'agent' || message.seq <= this.sentSeq || message.kind === 'status' || message.silent) return;
    if (message.state !== 'final' || this.current !== 'working') return;
    this.answered(message.body);
  }

  /** The agent answers: it speaks as long as its words take, then the call listens. */
  private answered(text: string): void {
    if (this.stopped) return;
    this.sentSeq = null;
    this.cancel?.();
    this.cancel = null;
    if (!text) { this.listen(); return; }
    this.set('speaking');
    const ticks = Math.round(speakingMs(text) / MOCK_TICK_MS);
    this.ticks(ticks, (index) => this.deps.out(mockLevel(index + 3)), () => { this.deps.out(0); this.listen(); });
  }

  private listen(): void {
    this.set('listening');
    this.schedule(MOCK_PAUSE_MS, () => this.say());
  }

  private ticks(count: number, each: (index: number) => void, done: () => void): void {
    let index = 0;
    const step = () => {
      if (this.stopped) return;
      if (index >= count) { done(); return; }
      each(index++);
      this.schedule(MOCK_TICK_MS, step);
    };
    step();
  }

  private schedule(ms: number, fn: () => void): void {
    this.cancel?.();
    this.cancel = this.deps.after(ms, () => { this.cancel = null; if (!this.stopped) fn(); });
  }

  private set(phase: CallPhase): void {
    if (this.current === phase && phase !== 'connecting') return;
    this.current = phase;
    this.deps.phase(phase);
  }
}
