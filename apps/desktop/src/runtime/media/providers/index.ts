// B-058: the one register of media generation adapters – which adapter serves an account's provider.
// Every OpenAI-compatible HTTP provider (OpenAI, xAI, OpenRouter, DeepSeek, Groq, local servers, custom
// endpoints) → openai.ts; the Gemini API ('google') → gemini.ts (its native endpoints carry images,
// speech, music and video); ElevenLabs and fal.ai → their own. Plan CLIs, Anthropic and data/decision
// accounts have no media endpoint.
// Owns: this provider → adapter table. Never: behaviour of an adapter (each module owns its own).

import type { ProviderId } from '../../../shared/model/providers.ts';
import { elevenlabsAdapter } from './elevenlabs.ts';
import { falAdapter } from './fal.ts';
import { geminiAdapter } from './gemini.ts';
import { openaiAdapter } from './openai.ts';
import type { MediaAdapter } from './types.ts';

/** Providers without a media generation endpoint. */
const NO_MEDIA: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex', 'claude', 'anthropic', 'gemini-cli', 'copilot', 'kimi-cli']);

const OWN: Partial<Record<ProviderId, MediaAdapter>> = { google: geminiAdapter, elevenlabs: elevenlabsAdapter, fal: falAdapter };

/** The adapter that generates media for `provider`'s accounts; undefined = none. */
export function adapterFor(provider: ProviderId): MediaAdapter | undefined {
  if (NO_MEDIA.has(provider)) return undefined;
  return OWN[provider] ?? openaiAdapter;
}

/** Every adapter once (listings, the abilities overview). */
export const MEDIA_ADAPTERS: readonly MediaAdapter[] = [openaiAdapter, geminiAdapter, elevenlabsAdapter, falAdapter];
