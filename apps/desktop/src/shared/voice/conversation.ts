// Voice conversation ("wie ChatGPT Voice / Siri – wenn man spricht, spricht die KI zurück"), one loop for the
// desktop window and the phone page (ui/chat/composer/pwa-conversation.ts owns the microphone and the speech
// output): an utterance the page cut and uploaded → voice.transcribe → messages.send (marked spoken live, with the
// call's id) → the agent's reply is read aloud → listen again. Each talking chat is a call on this device (calls.start
// when it starts – the call's row in the chat, written by this device's PC – and calls.end when it ends; a page that
// cannot start calls, a person's, talks without one). The first reply is usually the agent's live voice, a fast small
// model (runtime/calls/talker.ts), and the agent's own answer follows when it is done; both are read. The wait for a
// reply goes on while an agent of the chat works (a row that streams, also one synced from another PC) and ends
// REPLY_TIMEOUT_MS after the line otherwise; an agent that starts working later opens it again. A call is this same
// mode started from the chat header (realtime voice is the other way, ui/chat/call/realtime-call.ts).
// Parallel voice (SM11, simplest form): up to MAX_VOICE_SESSIONS chats talk at once over the one microphone. The
// chat started or focused last hears the next utterance; replies are read one at a time, the listening chat's
// first, another chat's with its title in front. Speech while a reply is awaited goes out at once (that reply is
// then not read; it stays in the chat). Nothing is taken while a reply is read (the page's echo guard), unless
// the person talks over it (bargeIn). Talking never stops agent work.
// Owns: the chats, the reading queue and the microphone's view (publish's first argument; every chat is its
// third). Never: touches a microphone, timer or platform global (all injected), or changes what was said.

import type { EventMap } from '../api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../api/methods.ts';
import type { Topic } from '../api/protocol.ts';
import type { Message, SpeechMeta } from '../model/chat.ts';

/** What the microphone does: the listening chat and its state ('speaking' while any reply is read). */
export interface VoiceSessionView {
  id: string;
  conversationId: string;
  status: 'starting' | 'listening' | 'transcribing' | 'responding' | 'speaking';
  hint?: string;
}

/** One talking chat (the listening one first). */
export interface VoiceSessionEntry extends VoiceSessionView {
  listening: boolean;
  /** Replies of this chat waiting to be read aloud. */
  queued?: number;
}

/** The runtime surface a conversation needs (the app's rpc). */
export interface ConversationRpc {
  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
  on<E extends 'message.created' | 'message.updated'>(event: E, listener: (data: EventMap[E]) => void): () => void;
  /** Holds the topic until the returned release is called. */
  subscribe(topic: Topic): Promise<() => void>;
}

export interface VoiceSessionsDeps {
  rpc: ConversationRpc;
  /** The microphone's view (null: no chat talks), why a chat ended, and every talking chat. */
  publish(mic: VoiceSessionView | null, error: string | undefined, chats: VoiceSessionEntry[]): void;
  /** Read `text` aloud, then call spokenDone(micId). */
  speak(micId: string, text: string): void;
  /** Stop reading now. */
  silence(): void;
  newId(): string;
  /** Runs `fn` once after `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** The transcription's language hint (the profile language). */
  language?(): string | undefined;
  replyTimeoutMs?: number;
}

export const MAX_VOICE_SESSIONS = 3;
export const SESSIONS_FULL = `At most ${MAX_VOICE_SESSIONS} voice conversations run at once. End one to start another.`;
export const REPEAT_HINT = 'I did not catch that. Please say it again.';
export const REPLY_TIMEOUT_MS = 120_000;
export const TRANSCRIBE_TIMEOUT_MS = 130_000;
const MAX_TEXT = 32_000;
/** What voice.transcribe accepts as `language`. */
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

/** A transcription language hint ("de", "en-US"), else undefined: the take goes without one. */
export function languageHint(language: string | undefined): string | undefined {
  return language && language.length <= 16 && LANGUAGE.test(language) ? language : undefined;
}

/** How a dictated (`live` false) or live-spoken line is marked when it is sent. */
export function spokenMeta(live: boolean): SpeechMeta {
  return live ? { source: 'endpoint', live: true } : { source: 'endpoint' };
}

/** Turns a Markdown answer into speakable text: no code/ui/app fences, no markup, bounded. */
export function speakable(markdown: string, max = 4000): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

interface Chat {
  id: string;
  conversationId: string;
  title: string;
  starting: boolean;
  sentSeq: number | null;
  awaiting: boolean;
  sending: boolean;
  pending: string;
  spoken: Set<string>;
  /** This device's call in the chat (calls.start), when the page may start calls. */
  callId?: string;
  release?: () => void;
  cancelTimer?: () => void;
}
interface Reading { chat: Chat; text: string }

export class VoiceSessions {
  private readonly deps: VoiceSessionsDeps;
  private chats: Chat[] = []; // the listening chat first
  private micId: string | null = null;
  private queue: Reading[] = [];
  private reading: Reading | null = null;
  private transcribing = false;
  private hint: string | undefined;

  constructor(deps: VoiceSessionsDeps) {
    this.deps = deps;
    deps.rpc.on('message.created', (message) => this.observe(message));
    deps.rpc.on('message.updated', (message) => this.observe(message));
  }

  get active(): boolean { return this.chats.length > 0; }

  /** The microphone's view; null when no chat talks. */
  view(): VoiceSessionView | null {
    const listening = this.chats[0];
    if (!listening || !this.micId) return null;
    const status = listening.starting ? 'starting' : this.reading ? 'speaking' : this.transcribing ? 'transcribing' : 'listening';
    return { id: this.micId, conversationId: listening.conversationId, status, ...(this.hint ? { hint: this.hint } : {}) };
  }

  /** Every talking chat, the listening one first. */
  sessions(): VoiceSessionEntry[] {
    return this.chats.map((chat, index) => {
      const status: VoiceSessionView['status'] = chat.starting ? 'starting'
        : this.reading?.chat === chat ? 'speaking'
          : index === 0 && this.transcribing ? 'transcribing'
            : chat.awaiting || chat.sending ? 'responding' : 'listening';
      const queued = this.queue.filter((reading) => reading.chat === chat).length;
      return { id: chat.id, conversationId: chat.conversationId, status, listening: index === 0, ...(queued ? { queued } : {}) };
    });
  }

  /** Talk in `conversationId`: a new chat that listens, or the one already talking there listens now. */
  async start(conversationId: string): Promise<VoiceSessionView> {
    const running = this.chats.find((chat) => chat.conversationId === conversationId);
    if (running) { this.focus(running); return this.current(); }
    if (this.chats.length >= MAX_VOICE_SESSIONS) throw new Error(SESSIONS_FULL);
    const chat: Chat = { id: this.deps.newId(), conversationId, title: '', starting: true, sentSeq: null, awaiting: false, sending: false, pending: '', spoken: new Set() };
    this.chats.unshift(chat);
    this.micId ??= this.deps.newId();
    this.hint = undefined;
    this.publish();
    try {
      const summary = await this.deps.rpc.call('chats.get', { id: conversationId }); // not_found for an unknown chat
      chat.title = summary.title ?? '';
      const release = await this.deps.rpc.subscribe(`chat:${conversationId}`);
      if (!this.chats.includes(chat)) { release(); throw new Error('Voice conversation was cancelled.'); }
      chat.release = release;
      const call = await this.deps.rpc.call('calls.start', { conversationId }).catch(() => undefined); // a person's page talks without a call row
      if (!this.chats.includes(chat)) { this.endCall(call?.callId); throw new Error('Voice conversation was cancelled.'); }
      chat.callId = call?.callId;
      chat.starting = false;
      this.publish();
      return this.current();
    } catch (error) {
      if (this.chats.includes(chat)) this.end(chat);
      throw error;
    }
  }

  /** Ends the chat's conversation – without one the listening chat's. */
  stop(conversationId?: string): void {
    const chat = conversationId === undefined ? this.chats[0] : this.chats.find((other) => other.conversationId === conversationId);
    if (chat) this.end(chat);
  }

  /** Ends every chat (the page hid, the microphone failed, a dictation takes the microphone). */
  stopAll(error?: string): void {
    if (!this.chats.length) return;
    for (const chat of [...this.chats]) this.end(chat, undefined, false);
    this.publish(error);
  }

  /** One utterance the page cut and uploaded: transcribed, then sent in the listening chat. */
  async utterance(micId: string, fileId: string): Promise<void> {
    const chat = this.chats[0];
    if (micId !== this.micId || !chat || this.reading || this.transcribing) return;
    this.transcribing = true;
    this.hint = undefined;
    this.publish();
    try {
      const language = languageHint(this.deps.language?.());
      const heard = await this.deps.rpc.call('voice.transcribe', language ? { fileId, language } : { fileId }, TRANSCRIBE_TIMEOUT_MS);
      if (micId !== this.micId) return;
      const text = typeof heard?.text === 'string' ? heard.text.trim() : '';
      this.transcribing = false;
      const target = this.chats.includes(chat) ? chat : this.chats[0];
      if (!text || !target) { this.hint = REPEAT_HINT; this.publish(); return; } // no words heard: say it again
      this.submit(target, text);
    } catch (error) {
      if (micId === this.micId) this.stopAll((error as Error).message);
    } finally {
      if (micId === this.micId && this.transcribing) { this.transcribing = false; this.publish(); }
    }
  }

  /** The page finished reading aloud: the next reply, or listen again. */
  spokenDone(micId: string): void {
    if (micId !== this.micId || !this.reading) return;
    this.reading = null;
    if (!this.readNext()) this.publish();
  }

  /** The person talks over the reading (the page's echo-cancelled microphone): it stops, the queued replies go. */
  bargeIn(micId: string): boolean {
    if (micId !== this.micId || !this.reading) return false;
    this.reading = null;
    this.queue = [];
    this.deps.silence();
    this.publish();
    return true;
  }

  // ------------------------------------------------------------------ internals

  private submit(chat: Chat, text: string): void {
    chat.pending = [chat.pending, text].filter(Boolean).join('\n');
    if (chat.pending.length > MAX_TEXT) { this.end(chat, 'The spoken message is too long. Start another conversation.'); return; }
    // New speech supersedes the reply still awaited and what of this chat waits to be read.
    chat.awaiting = false;
    this.clearTimer(chat);
    this.queue = this.queue.filter((reading) => reading.chat !== chat);
    void this.drain(chat);
  }

  private async drain(chat: Chat): Promise<void> {
    if (chat.sending || !chat.pending || chat.awaiting || !this.chats.includes(chat)) return;
    const body = chat.pending;
    chat.pending = '';
    chat.sending = true;
    this.publish();
    try {
      const speech = { ...spokenMeta(true), ...(chat.callId ? { call: chat.callId } : {}) };
      const message = await this.deps.rpc.call('messages.send', { conversationId: chat.conversationId, body, clientId: this.deps.newId(), speech });
      if (!this.chats.includes(chat)) return;
      const call = message.meta?.call?.id;
      if (call) chat.callId = call; // the runtime's call for this line – a new one when the device's connection had closed meanwhile or calls.start failed – so the end reaches it
      chat.sentSeq = message.seq;
      chat.awaiting = true;
      this.armTimer(chat);
    } catch (error) {
      if (this.chats.includes(chat)) this.end(chat, (error as Error).message);
    } finally {
      chat.sending = false;
      if (chat.pending) { chat.awaiting = false; this.clearTimer(chat); void this.drain(chat); } // said meanwhile: out at once
      else if (this.chats.includes(chat)) this.publish();
    }
  }

  private observe(message: Message): void {
    const chat = this.chats.find((entry) => entry.conversationId === message.conversationId);
    if (!chat || chat.sentSeq === null || message.authorKind !== 'agent' || message.seq <= chat.sentSeq || message.kind === 'status' || message.silent) return;
    if (message.state === 'streaming') { this.working(chat); return; }
    if (chat.spoken.has(message.id)) return;
    chat.spoken.add(message.id);
    if (chat.spoken.size > 200) chat.spoken = new Set([...chat.spoken].slice(-100));
    chat.awaiting = false;
    this.clearTimer(chat);
    if (message.state === 'failed') { this.end(chat, message.meta.error ?? 'The voice reply failed.'); return; }
    if (chat.pending) { void this.drain(chat); return; } // the person already spoke again
    const text = message.state === 'final' ? speakable(message.body) : '';
    if (text) this.enqueue({ chat, text }); else this.publish();
  }

  /** The listening chat's replies go before other chats' waiting ones (never before the one being read). */
  private enqueue(reading: Reading): void {
    const at = reading.chat === this.chats[0] ? this.queue.findIndex((other) => other.chat !== reading.chat) : -1;
    if (at < 0) this.queue.push(reading); else this.queue.splice(at, 0, reading);
    if (!this.readNext()) this.publish();
  }

  private readNext(): boolean {
    if (this.reading || !this.micId) return false;
    const next = this.queue.shift();
    if (!next) return false;
    this.reading = next;
    const other = this.chats.length > 1 && this.chats[0] !== next.chat;
    const name = other ? speakable(next.chat.title, 80) || 'Another chat' : '';
    this.publish();
    this.deps.speak(this.micId, name ? `${name}: ${next.text}` : next.text);
    return true;
  }

  private focus(chat: Chat): void {
    if (this.chats[0] === chat) return;
    this.chats = [chat, ...this.chats.filter((other) => other !== chat)];
    this.hint = undefined;
    this.publish();
  }

  /** An agent started its answer after the line: the chat waits for it (again). */
  private working(chat: Chat): void {
    if (chat.awaiting || chat.sending || chat.pending) return;
    chat.awaiting = true;
    this.armTimer(chat);
    this.publish();
  }

  /** The wait ends after the reply time – unless an agent of the chat still works (its row streams): then it goes on. */
  private armTimer(chat: Chat): void {
    this.clearTimer(chat);
    chat.cancelTimer = this.deps.after(this.deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS, () => {
      chat.cancelTimer = undefined;
      if (chat.awaiting) void this.waitOn(chat);
    });
  }

  private async waitOn(chat: Chat): Promise<void> {
    const working = await this.deps.rpc.call('chats.get', { id: chat.conversationId }).then((summary) => (summary.working?.length ?? 0) > 0, () => false);
    if (!chat.awaiting || chat.cancelTimer || !this.chats.includes(chat)) return;
    if (working) { this.armTimer(chat); return; }
    chat.awaiting = false; // no reply at all (nobody was addressed): listen again
    this.publish();
  }

  private endCall(callId: string | undefined): void {
    if (callId) void this.deps.rpc.call('calls.end', { callId }).catch(() => undefined);
  }

  private clearTimer(chat: Chat): void {
    const cancel = chat.cancelTimer;
    chat.cancelTimer = undefined;
    cancel?.();
  }

  private end(chat: Chat, error?: string, publish = true): void {
    this.chats = this.chats.filter((other) => other !== chat);
    this.queue = this.queue.filter((reading) => reading.chat !== chat);
    this.clearTimer(chat);
    this.endCall(chat.callId);
    try { chat.release?.(); } catch { /* already released */ }
    if (this.reading?.chat === chat) { this.reading = null; this.deps.silence(); }
    if (!this.chats.length) {
      this.micId = null;
      this.queue = [];
      this.transcribing = false;
      this.hint = undefined;
    } else if (!this.reading) this.readNext();
    if (publish) this.publish(error);
  }

  private current(): VoiceSessionView {
    const view = this.view();
    if (!view) throw new Error('Voice conversation was cancelled.');
    return view;
  }

  private publish(error?: string): void { this.deps.publish(this.view(), error, this.sessions()); }
}
