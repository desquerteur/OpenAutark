// The voice conversation of this page – ONE loop on the desktop window and the phone (shared/voice/conversation.ts
// VoiceSessions): the level detector cuts an utterance → it is uploaded → voice.transcribe (the profile language as
// the hint) → messages.send marked spoken live → the agent's reply is read aloud → listen again. Up to three chats
// talk over the one microphone; the chat started or focused last listens. The microphone opens once, inside the tap
// of the first chat; later chats just join the loop. While a reply is spoken (and its tail) nothing is taken (echo
// guard), unless the person talks over it (barge-in). The screen stays on (wake lock); on a phone every conversation
// ends when the page is hidden (app switched, screen locked) – a phone never keeps listening in the background.
// Owns: the page side (capture, speaking, wake lock, hide, the chat topics it holds). Never: audio processing beyond
// the capture, API keys (the runtime transcribes), or messages the loop did not send.

import { effect } from '@preact/signals';
import { newId } from '../../../shared/ids.ts';
import type { Topic } from '../../../shared/api/protocol.ts';
import { VoiceSessions } from '../../../shared/voice/conversation.ts';
import type { ConversationRpc, VoiceSessionEntry, VoiceSessionView } from '../../../shared/voice/conversation.ts';
import { recordingProblem } from '../../lib/dictation.ts';
import { platform } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';
import { activeConversationId, settings } from '../../lib/store.ts';
import { browserCapture, browserSpeech, ConversationCapture } from './conversation-audio.ts';
import type { CaptureDeps, SpeechOutput } from './conversation-audio.ts';

/** What the page conversation needs (browser defaults: createBrowserConversation). */
export interface PageConversationDeps {
  rpc: Pick<ConversationRpc, 'call' | 'on'>;
  /** Keeps the chat's topic subscribed until the release is called. */
  holdTopic(topic: Topic): () => void;
  capture: CaptureDeps;
  speech: SpeechOutput;
  /** Keeps the screen on; null when this browser cannot. */
  wakeLock(): Promise<{ release(): unknown } | null>;
  /** Calls `listener` once the page is hidden; returns the removal. */
  onHide(listener: () => void): () => void;
  /** Why this page cannot record (no microphone API, plain http), or undefined. */
  microphoneProblem(): string | undefined;
  /** The transcription's language hint: the profile language ("de", "en-US"). */
  language?(): string | undefined;
  publish(mic: VoiceSessionView | null, error: string | undefined, chats: VoiceSessionEntry[]): void;
  after(ms: number, fn: () => void): () => void;
  newId(): string;
}

/** The conversation was ended while it was starting – nothing to report. */
export class ConversationCancelled extends Error {
  constructor() { super('Voice conversation was cancelled.'); this.name = 'ConversationCancelled'; }
}

export class PageConversation {
  private readonly deps: PageConversationDeps;
  private readonly sessions: VoiceSessions;
  private capture: ConversationCapture | null = null;
  private opening: Promise<void> | null = null; // the microphone opening (a second tap meanwhile waits for it)
  private stops = 0; // bumped by every stop: a start that a stop overtook gives up quietly
  private releases: Array<() => void> = [];

  constructor(deps: PageConversationDeps) {
    this.deps = deps;
    this.sessions = new VoiceSessions({
      rpc: {
        call: deps.rpc.call.bind(deps.rpc),
        on: deps.rpc.on.bind(deps.rpc),
        subscribe: async (topic) => deps.holdTopic(topic),
      },
      publish: (mic, error, chats) => this.published(mic, error, chats),
      speak: (micId, text) => deps.speech.speak(text, () => this.sessions.spokenDone(micId)),
      silence: () => deps.speech.cancel(),
      newId: deps.newId,
      after: deps.after,
      language: () => deps.language?.(),
    });
  }

  get active(): boolean { return this.capture !== null || this.sessions.active; }

  /** The chats talking now, the listening one first. */
  chats(): VoiceSessionEntry[] { return this.sessions.sessions(); }

  /** Talks in `conversationId` (call from the tap: the first chat opens the microphone); a running chat listens now. */
  async start(conversationId: string): Promise<VoiceSessionView> {
    const stops = this.stops;
    if (!this.capture) this.opening = this.openCapture().finally(() => { this.opening = null; });
    if (this.opening) await this.opening;
    if (stops !== this.stops) throw new ConversationCancelled();
    try {
      return await this.sessions.start(conversationId);
    } catch (error) {
      if (!this.sessions.active) this.teardown();
      throw stops !== this.stops ? new ConversationCancelled() : error;
    }
  }

  /** Ends the chat's conversation (without one: the listening chat's). */
  stop(conversationId?: string): void {
    this.stops += 1;
    this.sessions.stop(conversationId);
    if (!this.sessions.active) this.teardown();
  }

  /** Ends every conversation (a dictation takes the microphone, the page hid, the microphone failed). */
  stopAll(error?: string): void {
    this.stops += 1;
    this.sessions.stopAll(error);
    this.teardown();
  }

  private async openCapture(): Promise<void> {
    const problem = this.deps.microphoneProblem();
    if (problem) throw new Error(problem);
    const capture = new ConversationCapture(
      { utterance: (micId, fileId) => this.sessions.utterance(micId, fileId), bargeIn: (micId) => this.sessions.bargeIn(micId) },
      (error) => { if (this.capture === capture) this.stopAll(error instanceof Error ? error.message : 'The utterance could not be sent.'); },
      this.deps.capture,
    );
    this.capture = capture;
    try {
      await capture.open();
    } catch (error) {
      if (this.capture === capture) { this.sessions.stopAll(); this.teardown(); }
      throw error;
    }
    if (this.capture !== capture) throw new ConversationCancelled(); // ended while the microphone opened
    this.releases.push(this.deps.onHide(() => { if (this.capture === capture) this.stopAll(); }));
    this.keepAwake(capture);
  }

  private published(mic: VoiceSessionView | null, error: string | undefined, chats: VoiceSessionEntry[]): void {
    if (mic) this.capture?.follow(mic);
    else if (!this.sessions.active) this.teardown();
    this.deps.publish(mic, error, chats);
  }

  private keepAwake(capture: ConversationCapture): void {
    void this.deps.wakeLock().then((lock) => {
      if (!lock) return;
      const release = () => { try { void Promise.resolve(lock.release()).catch(() => undefined); } catch { /* already released */ } };
      if (this.capture === capture) this.releases.push(release);
      else release();
    }, () => undefined); // no wake lock (battery saver, policy): the conversation still works
  }

  private teardown(): void {
    const capture = this.capture;
    this.capture = null;
    capture?.close();
    this.deps.speech.cancel();
    for (const release of this.releases.splice(0)) { try { release(); } catch { /* ignore */ } }
  }
}

// ------------------------------------------------------------------ browser defaults

/**
 * Holds `chat:<id>` while talking. store-events keeps only the open chat's topic and drops this
 * one when the person opens another chat – it is taken back right after that change (a
 * microtask, after every effect of the navigation ran); on release it stays when that chat is open.
 */
export function holdChatTopic(topic: Topic): () => void {
  let held = true;
  rpc.subscribe([topic]);
  const dispose = effect(() => {
    void activeConversationId.value;
    queueMicrotask(() => { if (held) rpc.subscribe([topic]); });
  });
  return () => {
    if (!held) return;
    held = false;
    dispose();
    if (`chat:${activeConversationId.peek()}` !== topic) rpc.unsubscribe([topic]);
  };
}

interface WakeLockApi { request(type: 'screen'): Promise<{ release(): Promise<void> }> }

function screenWakeLock(): Promise<{ release(): unknown } | null> {
  const api = (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock);
  return api ? api.request('screen') : Promise.resolve(null);
}

/** The phone page hidden (app switched, screen locked); the desktop window keeps talking when minimized. */
function onPageHidden(listener: () => void): () => void {
  if (platform !== 'pwa' || typeof document === 'undefined') return () => {};
  const changed = () => { if (document.visibilityState === 'hidden') listener(); };
  document.addEventListener('visibilitychange', changed);
  window.addEventListener('pagehide', listener);
  return () => {
    document.removeEventListener('visibilitychange', changed);
    window.removeEventListener('pagehide', listener);
  };
}

/** The page conversation with the browser's microphone, speech, wake lock and the app's rpc. */
export function createBrowserConversation(publish: PageConversationDeps['publish']): PageConversation {
  return new PageConversation({
    rpc,
    holdTopic: holdChatTopic,
    capture: browserCapture,
    speech: browserSpeech(),
    wakeLock: screenWakeLock,
    onHide: onPageHidden,
    microphoneProblem: () => recordingProblem() ?? (typeof MediaRecorder === 'undefined' ? 'This browser cannot record audio.' : undefined),
    language: () => settings.value?.profile.language,
    publish,
    after: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
    newId: () => newId('req'),
  });
}
