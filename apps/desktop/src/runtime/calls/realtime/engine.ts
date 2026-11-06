// The realtime speech-to-speech engine contract (22.10. 21:07: "ein Modell, das Audio-Input, Text und
// Output Audio kann"): one session takes the person's microphone audio and answers with audio directly,
// detecting turns and interruptions itself, and reports both transcripts so the chat keeps a written
// record. Two adapters (adapters.ts): openai.ts (OpenAI Realtime GA over WebSocket, also OpenAI-compatible servers) and
// gemini-live.ts. It is optional: the chat's voice conversation (shared/voice/conversation.ts) serves every call without it.
// Owns: the shapes only. Never: keys, chats or devices (calls/realtime/session.ts binds those).

/** What a session is opened with. */
export interface VoiceEngineConfig {
  /** Provider model id ("gpt-realtime", "gemini-3.8-live"). */
  model: string;
  /** System instructions: who speaks and how (calls/realtime/setup.ts). */
  instructions: string;
  /** Provider voice name, when the agent has one the provider knows. */
  voice?: string;
  /** Recent chat lines as context, oldest first. */
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Offer the hand-over function (work that needs the agent's tools). */
  handOver?: boolean;
  /** The person's word list as a hint for the input transcription (names, special spellings). */
  vocabulary?: string;
}

/** The answer to a hand-over (the function output the model reads). */
export interface HandOverResult {
  ok: boolean;
  /** Why nothing was handed over – for the model to tell the person. */
  notice?: string;
}

/** What a session reports. Every callback may come at any time until `closed`. */
export interface VoiceEngineEvents {
  /** Answer audio: PCM16 LE mono 24 kHz. */
  audio(pcm: Uint8Array): void;
  /** The person started talking (the engine's turn detection) – an answer playing must stop now. */
  speechStarted(): void;
  answerStarted(): void;
  answerDone(): void;
  /** What the person said (the engine's input transcription). */
  heard(text: string): void;
  /** What the model said, complete. */
  said(text: string): void;
  /**
   * The model asks the agent to do something that needs tools (`request` is the model's own words). The
   * answer goes back to the model as the function's output: `ok: false` with a `notice` means nothing was
   * handed over and the model says the notice instead.
   */
  handOver(request: string): HandOverResult | void;
  error(message: string): void;
  closed(reason?: string): void;
}

export interface VoiceEngineSession {
  /** Microphone audio: PCM16 LE mono 24 kHz. */
  sendAudio(pcm: Uint8Array): void;
  /** The person talked over the answer on the device: stop it; `playedMs` of it were heard. */
  interrupt(playedMs?: number): void;
  /** Something written in the chat during the call (the person's text; 'system': the agent's result to tell): context, and optionally say it. */
  addText(role: 'user' | 'assistant' | 'system', text: string, options?: { respond?: boolean }): void;
  close(): void;
}

export interface VoiceEngine {
  readonly id: string;
  open(config: VoiceEngineConfig, events: VoiceEngineEvents, signal?: AbortSignal): Promise<VoiceEngineSession>;
}

/** The socket surface an adapter needs (ws in the runtime, a fake in tests). */
export interface EngineSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => EngineSocket;
