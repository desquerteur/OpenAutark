// Runtime service contract: speech to text (addition MM1) – one service for the person's
// dictation and for agents hearing recordings (chat attachments, media.transcribe).
// Re-exported by ../contracts.ts (import from there). Implemented by voice/transcribe.ts.
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { LocalSpeechModels, SpokenAudio } from '../../shared/model/local-speech-models.ts';

/** 'ready' = a speech-to-text model and account are connected; 'off' = turned off in Settings; 'missing' = none connected. */
export type SpeechToTextState = 'ready' | 'off' | 'missing';

export interface SpeechToText {
  /** Whether a transcription could run now (Settings and connected accounts only, no network). */
  state(): SpeechToTextState;
  /**
   * Dictation: one transcription of a stored recording, nothing cached; text '' when no words were
   * heard (the service's blank text). An answer without a text string rejects like any failure.
   */
  transcribe(input: { fileId: string; language?: string }): Promise<{ text: string; confidence?: number }>;
  /**
   * Agent hearing: the cached transcript of a stored recording, else one transcription (one at a
   * time across all callers), secret-redacted and cached in the file's text column. Rejects with a
   * user-safe WorkforceError (not set up, too large, provider failure, no words heard).
   */
  transcript(fileId: string): Promise<string>;
  /** B-047 D14 (voice/local/service.ts): this PC's local speech models and whether the engine runs here. */
  localModels(): LocalSpeechModels;
  /** B-047 D14: downloads a local speech model and chooses it (progress: bus 'voice.pull'). */
  pullLocal(id: string): Promise<{ ok: true }>;
  /** B-047 D14: one line spoken by the chosen local voice. B-058: `signal` – the caller gave up (stop, deadline); no further sentence is spoken. */
  speak(input: { text: string; voice?: string; language?: string; signal?: AbortSignal }): Promise<SpokenAudio>;
}
