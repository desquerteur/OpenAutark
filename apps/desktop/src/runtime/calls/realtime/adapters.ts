// Which accounts can serve a realtime voice session and with which adapter of the VoiceEngine contract (engine.ts):
//   openai, compatible – OpenAI Realtime (openai.ts); an OpenAI key defaults to gpt-realtime, a compatible server needs
//                        a listed or chosen model
//   google             – Gemini Live (gemini-live.ts); defaults to VOICE_DEFAULTS.google
// Each adapter ranks an account's listed real-time models (shared/model/models-uses.ts talksLive says which those
// are) and maps the agent's voice to one the provider knows. setup.ts picks account and model.
// Owns: that list and those rules. Never: reads keys (session.ts passes the key it read), or opens a socket by itself.

import type { Account } from '../../../shared/model/providers.ts';
import type { SocketFactory, VoiceEngine } from './engine.ts';
import { GEMINI_LIVE_MODEL, GEMINI_VOICE, GEMINI_VOICES, GeminiLive } from './gemini-live.ts';
import { DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE, OPENAI_VOICES, OpenAiRealtime } from './openai.ts';

export interface RealtimeAdapter {
  /** Higher first among the account's listed models (equal ones keep the listing's order). */
  rank(model: string): number;
  /** The model a session uses when the account lists none; undefined = a listed or chosen model is needed. */
  defaultModel?: string;
  /** The provider voice for the agent's voice name. */
  voice(name: string | undefined): string;
  create(options: { key: string; baseUrl: string | undefined; connect: SocketFactory }): VoiceEngine;
}

const OPENAI_GA_FAMILY = /^gpt-realtime(-\d+(\.\d+)?)?(-mini)?(-\d{4}-\d{2}-\d{2})?$/i;

const OPENAI_SHAPED: RealtimeAdapter = {
  rank: (model) => (OPENAI_GA_FAMILY.test(model) ? 1 : 0),
  voice: (name) => { const known = name?.trim().toLowerCase(); return known && OPENAI_VOICES.has(known) ? known : DEFAULT_REALTIME_VOICE; },
  create: ({ key, baseUrl, connect }) => new OpenAiRealtime({ key, baseUrl, connect }),
};

const GEMINI: RealtimeAdapter = {
  defaultModel: GEMINI_LIVE_MODEL,
  rank: (model) => Number(/gemini-(?:live-)?(\d+(?:\.\d+)?)/i.exec(model)?.[1] ?? 0) - (/thinking/i.test(model) ? 0.5 : 0), // the newest generation first, its plain model before its thinking one
  voice: (name) => [...GEMINI_VOICES].find((entry) => entry.toLowerCase() === name?.trim().toLowerCase()) ?? GEMINI_VOICE,
  create: ({ key, baseUrl, connect }) => new GeminiLive({ key, baseUrl, connect }),
};

/** The adapter that serves an account of this provider, if any. */
export function adapterFor(account: Pick<Account, 'provider'>): RealtimeAdapter | undefined {
  if (account.provider === 'openai') return { ...OPENAI_SHAPED, defaultModel: DEFAULT_REALTIME_MODEL };
  if (account.provider === 'compatible') return OPENAI_SHAPED;
  return account.provider === 'google' ? GEMINI : undefined;
}
