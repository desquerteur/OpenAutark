// RPC contract part: feedback reports, the app's look (<data>/theme.css, runtime/root/theme.ts), the legacy
// import, voice transcription. Handlers: runtime/rpc/handlers/app.ts.
// Merged into Methods by module augmentation (split from methods.ts by area, 23.10.).
// Owns: these method shapes. Never: behaviour.

import type { LocalSpeechModels, LocalSpeechPull, SpokenAudio } from '../model/local-speech-models.ts';
import type { FeedbackKind, FeedbackReport, FeedbackVisibility } from '../model/system.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- feedback, the app's look
    'feedback.create': { params: { kind: FeedbackKind; text: string; screenshotFileId?: string; annotationFileId?: string; view?: string; conversationId?: string }; result: FeedbackReport };
    'feedback.list': { params: void; result: FeedbackReport[] };
    'feedback.send': { params: { id: string; visibility?: FeedbackVisibility }; result: FeedbackReport };
    'feedback.dismiss': { params: { id: string }; result: FeedbackReport };
    /** The CSS of <data>/theme.css ('' = none); open to every device – phones look the same. */
    'theme.get': { params: void; result: ThemeCss };

    // ----------------------------------------------------------------- the one-time legacy import (onboarding: shared/model/onboarding.ts)
    'import.legacy': { params: { path?: string } | void; result: { imported: { agents: number; chats: number; messages: number } } };

    // ----------------------------------------------------------------- voice
    /** Transcribes an uploaded recording (keys stay in the runtime); a local model also gives segment and word times. */
    'voice.transcribe': { params: { fileId: string; language?: string }; result: { text: string; segments?: HeardSegment[]; words?: HeardWord[] } };
    /** B-047 D14: this PC's local speech models (fitted to its memory and cores) and whether the local engine runs here. */
    'voice.localModels': { params: void; result: LocalSpeechModels };
    /** B-047 D14, owner: downloads a local speech model (sha256-checked) and chooses it; progress arrives as `voice.pull`. */
    'voice.pullLocal': { params: { id: string }; result: { ok: true } };
    /** B-047 D14: one line spoken by the chosen local voice (`voice`: the speaker number) – base64 PCM16 mono. */
    'voice.speak': { params: { text: string; voice?: string; language?: string }; result: SpokenAudio };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** theme.css changed on disk (topic 'system'; every device applies it). */
    'theme.updated': ThemeCss;
    /** B-047 D14: a voice.pullLocal download moved on (topic 'system', owner only). */
    'voice.pull': LocalSpeechPull;
  }
}

/** The app's look: the text of <data>/theme.css. */
export interface ThemeCss { css: string }
/** A recognized stretch of a take (seconds from its start). */
export interface HeardSegment { text: string; start: number; end: number }
/** A recognized word with its time and – when the model gives token probabilities – the probability of its weakest token. */
export interface HeardWord { text: string; start: number; end: number; confidence?: number }
