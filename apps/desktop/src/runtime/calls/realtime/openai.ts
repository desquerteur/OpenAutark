// OpenAI Realtime adapter of the VoiceEngine contract (engine.ts), GA shape: one WebSocket per session to
// `<base>/realtime?model=…` with the account's API key in the Authorization header (the key stays in the
// runtime) – OpenAI itself or an OpenAI-compatible server. The session asks for PCM16 24 kHz in and out,
// server-side turn detection that cuts an answer when the person talks (interrupt_response), input
// transcription (the chat keeps what the person said) and – with handOver – one function `hand_over` for
// work that needs the agent's tools (its output is { ok } or, when nothing was handed over, { ok: false, notice }).
// Client events: session.update, conversation.item.create (history, chat text, function output),
// input_audio_buffer.append, response.create, response.cancel, conversation.item.truncate.
// Server events read: session.created, input_audio_buffer.speech_started,
// conversation.item.input_audio_transcription.completed, response.created, response.output_audio.delta
// (beta name response.audio.delta), response.output_audio_transcript.done (response.audio_transcript.done),
// response.function_call_arguments.done, response.done, error.
// Turn order (the provider's): response.created → audio deltas / function_call_arguments.done → response.done.
// A new response.create is sent only once no response is active (after response.done): a hand-over's
// follow-up answer and a chat line to tell wait for it. The last answer item stays known until the next
// answer starts, so the device's "heard up to n ms" truncates it even after server VAD already cut it.
// Owns: this protocol mapping, the open timeout and safe error texts. Never: logs or returns the key or a
// provider error body (only its code/type), keeps audio, or retries a failed session by itself.

import { VOICE_DEFAULTS } from '../../../shared/model/models-uses.ts';
import type { EngineSocket, SocketFactory, VoiceEngine, VoiceEngineConfig, VoiceEngineEvents, VoiceEngineSession } from './engine.ts';

export const DEFAULT_REALTIME_MODEL = VOICE_DEFAULTS.openai;
export const DEFAULT_REALTIME_VOICE = 'marin';
export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const OPEN_TIMEOUT_MS = 15_000;

/** Voices the OpenAI Realtime API speaks with. */
export const OPENAI_VOICES: ReadonlySet<string> = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);

export const HAND_OVER_TOOL = {
  type: 'function',
  name: 'hand_over',
  description: 'I hand a request that needs real work (files, web, tasks, apps, the computer, anything beyond talking) to my full turn, which does it and reports in the chat. When it answers ok, I tell the person I handed it over; when it answers ok false with a notice, nothing was handed over and I tell them the notice instead.',
  parameters: {
    type: 'object',
    properties: { request: { type: 'string', description: 'What the person asked for, in a short sentence.' } },
    required: ['request'],
  },
} as const;

/** `https://api.openai.com/v1` → `wss://api.openai.com/v1/realtime?model=…`. */
export function realtimeUrl(baseUrl: string | undefined, model: string): string {
  const base = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '').replace(/^http/i, 'ws');
  return `${base}/realtime?model=${encodeURIComponent(model)}`;
}

export interface OpenAiRealtimeOptions {
  key: string;
  baseUrl?: string;
  connect: SocketFactory;
  timeoutMs?: number;
}

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));
const text = (data: unknown) => (typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data));

export class OpenAiRealtime implements VoiceEngine {
  readonly id = 'openai-realtime';
  private readonly options: OpenAiRealtimeOptions;

  constructor(options: OpenAiRealtimeOptions) {
    this.options = options;
  }

  open(config: VoiceEngineConfig, events: VoiceEngineEvents, signal?: AbortSignal): Promise<VoiceEngineSession> {
    if (signal?.aborted) return Promise.reject(new Error('The realtime session was cancelled.'));
    const socket = this.options.connect(realtimeUrl(this.options.baseUrl, config.model), { Authorization: `Bearer ${this.options.key}` });
    return new Promise((resolve, reject) => {
      let ready = false;
      let ended = false;
      const aborted = () => fail('The realtime session was cancelled.');
      const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
      const fail = (message: string) => {
        if (ready || ended) return;
        ended = true;
        settle();
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('The realtime model did not answer.'), this.options.timeoutMs ?? OPEN_TIMEOUT_MS);
      timer.unref?.();
      signal?.addEventListener('abort', aborted, { once: true });
      const session = new OpenAiSession(socket, events);
      socket.on('message', (data) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(text(data)) as Record<string, unknown>; } catch { return; }
        if (!ready && event.type === 'session.created') {
          if (ended) return;
          ready = true;
          settle();
          session.configure(config);
          resolve(session);
          return;
        }
        if (!ready && event.type === 'error') { fail(errorText(event)); return; }
        if (ready) session.handle(event);
      });
      socket.on('error', (error) => { if (!ready) fail(connectError(error)); else events.error('The realtime connection failed.'); });
      socket.on('close', (code) => {
        if (!ready) { if (!ended) fail(code === 1008 || code === 4001 ? 'The realtime model refused the API key.' : 'The realtime connection closed.'); return; }
        session.closedBy(code === 1000 ? undefined : 'The realtime connection closed.');
      });
    });
  }
}

class OpenAiSession implements VoiceEngineSession {
  private readonly socket: EngineSocket;
  private readonly events: VoiceEngineEvents;
  private open = true;
  private answering = false; // a response is active (response.created … response.done)
  private requested = false; // response.create sent, response.created not yet seen
  private respondAfter = false; // a response.create waits for the active response's end
  private vadCut = false; // server VAD cancelled the active response (speech_started while answering)
  private item: { id: string; bytes: number } | undefined; // the last answer item with audio (truncated on interrupt)

  constructor(socket: EngineSocket, events: VoiceEngineEvents) {
    this.socket = socket;
    this.events = events;
  }

  configure(config: VoiceEngineConfig): void {
    const transcription = { model: TRANSCRIBE_MODEL, ...(config.vocabulary ? { prompt: config.vocabulary } : {}) };
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: config.model,
        instructions: config.instructions,
        output_modalities: ['audio'],
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24_000 }, transcription, turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } },
          output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: config.voice || DEFAULT_REALTIME_VOICE },
        },
        ...(config.handOver ? { tools: [HAND_OVER_TOOL], tool_choice: 'auto' } : {}),
      },
    });
    for (const line of config.history) this.item_(line.role, line.text);
  }

  sendAudio(pcm: Uint8Array): void {
    if (pcm.byteLength) this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') });
  }

  interrupt(playedMs?: number): void {
    if (this.answering && !this.vadCut) { this.send({ type: 'response.cancel' }); this.vadCut = true; }
    const item = this.item;
    if (!item || playedMs === undefined) return;
    this.item = undefined; // truncated once
    const audioMs = Math.floor(item.bytes / 48); // PCM16 mono 24 kHz: 48 bytes per millisecond
    this.send({ type: 'conversation.item.truncate', item_id: item.id, content_index: 0, audio_end_ms: Math.max(0, Math.min(Math.round(playedMs), audioMs)) });
  }

  addText(role: 'user' | 'assistant' | 'system', value: string, options: { respond?: boolean } = {}): void {
    if (!value.trim()) return;
    this.item_(role, value);
    if (options.respond) this.respond();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    try { this.socket.close(1000); } catch { /* already closed */ }
    this.events.closed();
  }

  closedBy(reason?: string): void {
    if (!this.open) return;
    this.open = false;
    this.events.closed(reason);
  }

  handle(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        if (this.answering) this.vadCut = true; // interrupt_response: the server cancels it itself
        this.events.speechStarted();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.transcript === 'string' && event.transcript.trim()) this.events.heard(event.transcript.trim());
        break;
      case 'response.created':
        this.answering = true;
        this.requested = false;
        this.vadCut = false;
        this.item = undefined; // a new answer: the earlier one is no longer truncated
        this.events.answerStarted();
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (typeof event.delta === 'string' && event.delta) {
          const pcm = bytes(event.delta);
          if (typeof event.item_id === 'string') this.item = this.item?.id === event.item_id ? { id: event.item_id, bytes: this.item.bytes + pcm.byteLength } : { id: event.item_id, bytes: pcm.byteLength };
          this.events.audio(pcm);
        }
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (typeof event.transcript === 'string' && event.transcript.trim()) this.events.said(event.transcript.trim());
        break;
      case 'response.function_call_arguments.done':
        this.handOver(event);
        break;
      case 'response.done':
        this.answering = false;
        this.vadCut = false;
        this.events.answerDone();
        if (this.respondAfter) { this.respondAfter = false; this.respond(); }
        break;
      case 'error':
        this.requested = false; // a refused response.create must not block later ones
        this.events.error(errorText(event));
        break;
      default:
        break;
    }
  }

  private handOver(event: Record<string, unknown>): void {
    if (event.name !== HAND_OVER_TOOL.name || typeof event.call_id !== 'string') return;
    let request = '';
    try { request = String((JSON.parse(String(event.arguments ?? '{}')) as { request?: unknown }).request ?? '').trim(); } catch { request = ''; }
    const result = request ? this.events.handOver(request.slice(0, 1000)) : undefined;
    const output = typeof result === 'object' && result?.ok === false ? { ok: false, ...(result.notice ? { notice: result.notice } : {}) } : { ok: Boolean(request) };
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } });
    this.respond(); // the spoken "on it" (or the notice) – after this response's response.done
  }

  /** Asks for an answer now, or once the active one is done (one active response at a time). */
  private respond(): void {
    if (this.answering || this.requested) { this.respondAfter = true; return; }
    this.requested = true;
    this.send({ type: 'response.create' });
  }

  private item_(role: 'user' | 'assistant' | 'system', value: string): void {
    const type = role === 'assistant' ? 'output_text' : 'input_text';
    this.send({ type: 'conversation.item.create', item: { type: 'message', role, content: [{ type, text: value.slice(0, 4000) }] } });
  }

  private send(event: Record<string, unknown>): void {
    if (!this.open) return;
    try { this.socket.send(JSON.stringify(event)); } catch { this.closedBy('The realtime connection closed.'); }
  }
}

/** The provider's error as a safe sentence: its code or type only, never its body. */
function errorText(event: Record<string, unknown>): string {
  const error = (event.error ?? {}) as { code?: unknown; type?: unknown };
  const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : '';
  if (/invalid_api_key|authentication/i.test(code)) return 'The realtime model refused the API key.';
  if (/model_not_found|not_found/i.test(code)) return 'This realtime model is not available for the account.';
  if (/rate_limit|quota/i.test(code)) return 'The realtime model is rate limited right now.';
  return code ? `The realtime model reported an error (${code.replace(/[^a-z0-9_.-]/gi, '').slice(0, 60)}).` : 'The realtime model reported an error.';
}

function connectError(error: Error): string {
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
  if (status === '401' || status === '403') return 'The realtime model refused the API key.';
  if (status === '404') return 'This realtime model is not available for the account.';
  if (status === '429') return 'The realtime model is rate limited right now.';
  return 'The realtime model could not be reached.';
}
