// Gemini Live adapter of the VoiceEngine contract (engine.ts): one WebSocket per session to the Gemini API's
// BidiGenerateContent endpoint (<origin>/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent,
// origin from the Google account's base URL, else generativelanguage.googleapis.com) with the account's API key in the
// x-goog-api-key header, never in the URL. It is not OpenAI-compatible:
//   client  setup once the socket is open (model, AUDIO answers, a prebuilt voice, the system instruction with the
//           person's word list, the hand_over function, input and output transcription, historyConfig); realtimeInput.audio (PCM16
//           16 kHz, the device's 24 kHz resampled, pcm.ts); clientContent (the history at the start without a turn end;
//           chat text to tell, with a turn end, held while an answer runs, since client content cuts a running answer);
//           toolResponse (the hand-over's { ok } or { ok: false, notice }).
//   server  setupComplete (ready); serverContent: modelTurn audio parts (PCM16 24 kHz), inputTranscription and
//           outputTranscription chunks (joined: what the person said is reported once the model answers or the turn
//           ends, what the model said at turnComplete or interrupted), interrupted (the person talked over it:
//           speechStarted), turnComplete; toolCall (hand_over → events.handOver).
// Gemini has no client cancel or truncate: interrupt() drops the rest of the current answer's audio (the server's own
// voice detection cuts an answer when the person talks). The provider ends a session after about 15 minutes of audio;
// the call then goes on in the chat's voice conversation (ui/chat/call/CallHeader.tsx). Checked against a fake socket only.
// Owns: this protocol mapping, the open timeout and safe error texts. Never: logs or returns the key, a close reason or
// a provider body, keeps audio, or retries a failed session by itself.

import { VOICE_DEFAULTS } from '../../../shared/model/models-uses.ts';
import type { EngineSocket, SocketFactory, VoiceEngine, VoiceEngineConfig, VoiceEngineEvents, VoiceEngineSession } from './engine.ts';
import { HAND_OVER_TOOL } from './openai.ts';
import { Pcm24To16 } from './pcm.ts';

export const GEMINI_LIVE_MODEL = VOICE_DEFAULTS.google;
export const GEMINI_VOICE = 'Kore';
export const GEMINI_VOICES: ReadonlySet<string> = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']);
const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const OPEN_TIMEOUT_MS = 15_000;

/** A Google account's base URL (its OpenAI-compatible endpoint) → the Live socket of the same origin. */
export function geminiLiveUrl(baseUrl: string | undefined): string {
  let origin = 'https://generativelanguage.googleapis.com';
  try { if (baseUrl?.trim()) origin = new URL(baseUrl).origin; } catch { /* the default host */ }
  return `${origin.replace(/^http/i, 'ws')}${LIVE_PATH}`;
}

/** hand_over as a Gemini function declaration (OpenAPI schema types). */
export const GEMINI_HAND_OVER = {
  name: HAND_OVER_TOOL.name,
  description: HAND_OVER_TOOL.description,
  parameters: {
    type: 'OBJECT',
    properties: { request: { type: 'STRING', description: HAND_OVER_TOOL.parameters.properties.request.description } },
    required: ['request'],
  },
} as const;

export interface GeminiLiveOptions {
  key: string;
  baseUrl?: string;
  connect: SocketFactory;
  timeoutMs?: number;
}

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));
const text = (data: unknown) => (typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data));
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

export class GeminiLive implements VoiceEngine {
  readonly id = 'gemini-live';
  private readonly options: GeminiLiveOptions;

  constructor(options: GeminiLiveOptions) {
    this.options = options;
  }

  open(config: VoiceEngineConfig, events: VoiceEngineEvents, signal?: AbortSignal): Promise<VoiceEngineSession> {
    if (signal?.aborted) return Promise.reject(new Error('The realtime session was cancelled.'));
    const socket = this.options.connect(geminiLiveUrl(this.options.baseUrl), { 'x-goog-api-key': this.options.key });
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
      const session = new GeminiSession(socket, events);
      socket.on('open', () => { if (!ended) session.setup(config); });
      socket.on('message', (data) => {
        let message: Record<string, unknown>;
        try { message = record(JSON.parse(text(data))); } catch { return; }
        if (!ready) {
          if (message.setupComplete === undefined || ended) return; // a refused setup arrives as a close
          ready = true;
          settle();
          session.started(config);
          resolve(session);
          return;
        }
        session.handle(message);
      });
      socket.on('error', (error) => { if (!ready) fail(connectError(error)); else events.error('The realtime connection failed.'); });
      socket.on('close', (code) => {
        if (!ready) { if (!ended) fail(closeText(code)); return; }
        session.closedBy(code === 1000 ? undefined : 'The realtime connection closed.');
      });
    });
  }
}

class GeminiSession implements VoiceEngineSession {
  private readonly socket: EngineSocket;
  private readonly events: VoiceEngineEvents;
  private readonly down = new Pcm24To16();
  private open = true;
  private answering = false;
  private cut = false; // interrupt(): the rest of this answer's audio is dropped
  private heardText = '';
  private saidText = '';
  private held: Array<{ role: 'user' | 'model'; text: string; respond: boolean }> = []; // chat text while an answer runs

  constructor(socket: EngineSocket, events: VoiceEngineEvents) {
    this.socket = socket;
    this.events = events;
  }

  setup(config: VoiceEngineConfig): void {
    const words = config.vocabulary ? `\n\nNames and terms the person uses (I spell them like this): ${config.vocabulary.slice(0, 1000)}` : '';
    this.send({
      setup: {
        model: config.model.startsWith('models/') ? config.model : `models/${config.model}`,
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice || GEMINI_VOICE } } } },
        systemInstruction: { parts: [{ text: `${config.instructions}${words}` }] },
        ...(config.history.length ? { historyConfig: { initialHistoryInClientContent: true } } : {}), // started() seeds it before the microphone
        ...(config.handOver ? { tools: [{ functionDeclarations: [GEMINI_HAND_OVER] }] } : {}),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  }

  /** setupComplete: the history as context (no turn end: nothing is answered). */
  started(config: VoiceEngineConfig): void {
    const turns = config.history.map((line) => ({ role: line.role === 'assistant' ? 'model' : 'user', parts: [{ text: line.text.slice(0, 4000) }] }));
    if (turns.length) this.send({ clientContent: { turns, turnComplete: false } });
  }

  sendAudio(pcm: Uint8Array): void {
    const audio = this.down.push(pcm);
    if (audio.byteLength) this.send({ realtimeInput: { audio: { data: Buffer.from(audio).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
  }

  interrupt(): void {
    if (this.answering) this.cut = true;
  }

  addText(role: 'user' | 'assistant' | 'system', value: string, options: { respond?: boolean } = {}): void {
    if (!value.trim()) return;
    const entry = { role: role === 'assistant' ? 'model' as const : 'user' as const, text: value.slice(0, 4000), respond: Boolean(options.respond) };
    if (this.answering) { this.held.push(entry); return; } // client content would cut the running answer
    this.content([entry]);
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

  handle(message: Record<string, unknown>): void {
    const content = record(message.serverContent);
    const heard = record(content.inputTranscription).text;
    if (typeof heard === 'string') this.heardText += heard;
    const parts = record(content.modelTurn).parts;
    if (Array.isArray(parts)) {
      this.flushHeard();
      if (!this.answering) { this.answering = true; this.cut = false; this.events.answerStarted(); }
      for (const part of parts) {
        const data = record(record(part).inlineData).data;
        if (typeof data === 'string' && data && !this.cut) this.events.audio(bytes(data));
      }
    }
    const said = record(content.outputTranscription).text;
    if (typeof said === 'string') { this.flushHeard(); this.saidText += said; }
    if (content.interrupted === true) { this.events.speechStarted(); this.endAnswer(); }
    if (content.turnComplete === true) { this.flushHeard(); this.endAnswer(); }
    if (message.toolCall) this.toolCall(record(message.toolCall));
  }

  private flushHeard(): void {
    const heard = this.heardText.replace(/\s+/g, ' ').trim();
    this.heardText = '';
    if (heard) this.events.heard(heard);
  }

  private endAnswer(): void {
    const said = this.saidText.replace(/\s+/g, ' ').trim();
    this.saidText = '';
    if (said) this.events.said(said);
    const was = this.answering;
    this.answering = false;
    this.cut = false;
    if (was) this.events.answerDone();
    if (this.held.length) this.content(this.held.splice(0));
  }

  private content(entries: Array<{ role: 'user' | 'model'; text: string; respond: boolean }>): void {
    this.send({ clientContent: { turns: entries.map((entry) => ({ role: entry.role, parts: [{ text: entry.text }] })), turnComplete: entries.some((entry) => entry.respond) } });
  }

  private toolCall(call: Record<string, unknown>): void {
    const calls = Array.isArray(call.functionCalls) ? call.functionCalls.map(record) : [];
    const responses: Array<Record<string, unknown>> = [];
    for (const fn of calls) {
      if (typeof fn.id !== 'string') continue;
      if (fn.name !== HAND_OVER_TOOL.name) { responses.push({ id: fn.id, name: fn.name, response: { ok: false } }); continue; }
      const request = String(record(fn.args).request ?? '').trim();
      const result = request ? this.events.handOver(request.slice(0, 1000)) : undefined;
      const output = typeof result === 'object' && result?.ok === false ? { ok: false, ...(result.notice ? { notice: result.notice } : {}) } : { ok: Boolean(request) };
      responses.push({ id: fn.id, name: fn.name, response: output });
    }
    if (responses.length) this.send({ toolResponse: { functionResponses: responses } });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.open) return;
    try { this.socket.send(JSON.stringify(message)); } catch { this.closedBy('The realtime connection closed.'); }
  }
}

/** Why a session closed before setupComplete, as a safe sentence (never the provider's reason text). */
function closeText(code: number): string {
  if (code === 1008) return 'Gemini Live refused the session: check the API key and the model.';
  if (code === 1007) return 'Gemini Live refused the session setup.';
  return 'The realtime connection closed.';
}

function connectError(error: Error): string {
  const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
  if (status === '401' || status === '403') return 'The realtime model refused the API key.';
  if (status === '404') return 'This realtime model is not available for the account.';
  if (status === '429') return 'The realtime model is rate limited right now.';
  return 'The realtime model could not be reached.';
}
