// B-058 G11–G13: the shapes every media generation provider adapter shares – what is asked for (image,
// speech, music, sound effect, video), what comes back, and the adapter interface the generation flow
// (runtime/media/generate*.ts) calls. Adapters live next to this file, one per provider family
// (openai.ts: every OpenAI-compatible endpoint; gemini.ts, elevenlabs.ts, fal.ts), registered in index.ts.
// Owns: these types. Never: behaviour, keys (the target's `key()` reads it in-process when the call runs).

import type { Account, ProviderId } from '../../../shared/model/providers.ts';

export type GenerationKind = 'image' | 'speech' | 'music' | 'sound' | 'video';

export const GENERATION_KINDS: readonly GenerationKind[] = ['image', 'speech', 'music', 'sound', 'video'];

/** One generation request. `prompt` describes the result; `text` is what speech says (speech only). */
export interface GenerationRequest {
  prompt: string;
  /** speech: the words spoken (the prompt then only steers the delivery, where the provider supports it). */
  text?: string;
  // image
  /** 'WIDTHxHEIGHT' or 'auto'. */
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  // speech
  voice?: string;
  /** Output format asked for ('mp3', 'wav', 'opus' …); the adapter maps it to the provider's own names. */
  format?: string;
  /** ISO-639-1 code. */
  language?: string;
  // music, sound, video
  durationS?: number;
  // music
  lyrics?: string;
  instrumental?: boolean;
  // sound
  loop?: boolean;
  // video
  /** '16:9', '9:16', '1:1' … */
  aspect?: string;
  /** '720p', '1080p' … */
  resolution?: string;
  /** A stored image (blob id) the video starts from (image to video). */
  imageFileId?: string;
  /** The bytes of imageFileId, read by the flow (adapters never touch the blob store). */
  image?: { bytes: Uint8Array; mime: string };
}

/** What one generation returns. */
export interface Generated {
  bytes: Uint8Array;
  mime: string;
  /** File extension without the dot ('png', 'mp3', 'mp4'). */
  extension: string;
  durationMs?: number;
  /** The price the provider reported for this call (USD), when it reports one. */
  usd?: number;
  /** Small, safe extras for the agent (revised prompt, seed, provider job id) – never keys or raw error bodies. */
  meta?: Record<string, string | number | boolean>;
}

/** Who runs the call: the account, the provider model id, and the in-process key reader (AccountService.apiKey). */
export interface GenerationTarget {
  account: Account;
  /** Provider model id sent to the provider (e.g. 'gpt-image-1', 'eleven_multilingual_v2', 'fal-ai/kling-video/…'). */
  model: string;
  /** Reads the key when the call runs; undefined = none saved. Never logged or returned. */
  key?: () => Promise<string | undefined>;
}

export type MediaFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The call's environment: the fetch to use (tests pass fakes), the run's stop, and the deadline (epoch ms) for the whole exchange. */
export interface GenerationContext {
  fetch: MediaFetch;
  signal?: AbortSignal;
  deadlineMs: number;
}

/** One provider family's media generation. */
export interface MediaAdapter {
  provider: ProviderId;
  /** The kinds this provider model can generate ([] = none, e.g. a chat model). */
  kinds(model: string): GenerationKind[];
  /** Rough USD price of one call for the permission/budget gate (over-, never under-estimate); undefined = unknown. */
  estimateUsd(kind: GenerationKind, request: GenerationRequest, model: string): number | undefined;
  /** Runs one generation; rejects with a user-safe WorkforceError (no key, no raw provider body). */
  generate(kind: GenerationKind, request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated>;
}
