// Provider model: engines, accounts (many plans per provider), model catalog, routing, usage.
// Owns: shapes for "who can run which model with which effort on which account".
// Never: holds tokens or API keys (accounts reference encrypted secrets or CLI homes only).

import type { ModelUse } from './models-uses.ts';

// 'acp': any agent that speaks the Agent Client Protocol (runtime/engines/acp/).
export type EngineId = 'codex' | 'claude' | 'openai' | 'anthropic' | 'compatible' | 'fake' | 'acp';

export type ProviderId =
  | 'codex' // ChatGPT/Codex plan via official Codex CLI
  | 'claude' // Claude plan via official Claude Code CLI
  | 'openai' // OpenAI API key
  | 'anthropic' // Anthropic API key
  | 'openrouter'
  | 'google' // Gemini API (OpenAI-compatible endpoint)
  | 'xai'
  | 'deepseek'
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'compatible' // any other OpenAI-compatible endpoint
  | 'gemini-cli' // Gemini plan (Google sign-in) via the official Gemini CLI on the ACP engine (PR8)
  | 'copilot' // GitHub Copilot plan via the official Copilot CLI on the ACP engine (PR8)
  | 'kimi-cli' // Kimi Code membership via the official Kimi Code CLI on the ACP engine (B-044)
  | 'groq' // B-058: Groq API key (OpenAI-compatible: chat, /audio/transcriptions, /models) on the compatible engine
  | 'elevenlabs' // B-058: ElevenLabs API key – media only (speech, music, sound effects; runtime/media/providers), no chat engine
  | 'fal' // B-058: fal.ai API key – media only (video, music, sound effects; queue API), no chat engine
  | 'decision-api'; // a connection on the decision protocol (settings.json providers, runtime/decision/systemone.ts): no chat engine, Decisions only

/** The provider of a connection on the decision protocol. */
export const DECISION_PROVIDER = 'decision-api';

export type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 'env' (PR5): a provider key read from this PC's environment variable `Account.envVar`, never stored. */
export type AccountAuth = 'cli' | 'api_key' | 'env' | 'local' | 'none';

export type AccountState = 'ok' | 'needs_login' | 'cooling' | 'error' | 'disabled' | 'unknown';

export interface LimitWindow {
  name: string; // "5h", "weekly", "weekly-opus" …
  windowMinutes: number;
  usedPercent: number; // 0..100
  resetsAt?: number; // epoch ms
}

/** B-044: one banked reset (Codex RateLimitResetCredit, status 'available'); it restores the 5-hour and weekly windows. */
export interface ResetCredit {
  id: string; // opaque provider id (account/rateLimitResetCredit/consume creditId)
  title?: string;
  expiresAt?: number; // epoch ms; undefined = does not expire or unknown
}

/** B-044: the banked resets of a plan (Codex `rateLimitResetCredits`): the count, and details when the provider sent them. */
export interface LimitResets {
  available: number;
  /** Available credits, soonest expiry first; undefined when the provider sent only the count. */
  credits?: ResetCredit[];
}

export interface AccountLimits {
  windows: LimitWindow[];
  readAt: number;
  stale?: boolean;
  /** B-044: banked resets (Codex only; absent = never reported). */
  resets?: LimitResets;
}

export interface Account {
  id: string;
  provider: ProviderId;
  label: string; // "Codex · work", "Claude Max · personal"
  auth: AccountAuth;
  home?: string; // CODEX_HOME / CLAUDE_CONFIG_DIR (isolated per account), or base URL for HTTP
  baseUrl?: string;
  secretId?: string; // encrypted API key reference
  envVar?: string; // auth 'env' (PR5): the variable's name (ENV_KEY_PROVIDERS) – its value is never stored or sent
  state: AccountState;
  plan?: string; // "plus", "pro", "max" … (from official status output)
  email?: string; // shown only to the user
  limits?: AccountLimits;
  coolingUntil?: number;
  priority: number; // lower = preferred
  rotation: boolean; // may be used automatically when another account of the same provider is limited
  enabled: boolean;
  detected: boolean; // found from an existing login on this PC
  deviceId?: string; // which PC this account lives on (undefined = home)
  createdAt: number;
  checkedAt?: number;
}

export interface ModelCaps {
  vision?: boolean;
  audioIn?: boolean;
  tools?: boolean;
  computerUse?: boolean;
  structuredOutput?: boolean;
  contextTokens?: number;
  outputTokens?: number;
  /** What settings.json says this model is for (a model entry's `uses`, or the use that names it) – its name need not tell. */
  uses?: readonly ModelUse[];
}

export interface ModelScores {
  intelligence?: number; // Artificial Analysis indexes (user's own key; attributed)
  coding?: number;
  agentic?: number;
  /** Addition (RT6): finance & accounting index – routes business workflows. */
  finance?: number;
  outputTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  priceInputPerM?: number;
  priceOutputPerM?: number;
  contextTokens?: number;
  /** Where older rows' numbers came from (no writer since B-061; kept so stored rows still read). */
  source: 'artificial-analysis' | 'provider' | 'priors' | 'feeds';
  fetchedAt?: number;
}

/** B-078 (D16): a model's API list price in USD per 1M tokens – curated (model-priors.json) or from the keyless OpenRouter list. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  source: 'priors' | 'feed';
}

export interface ModelInfo {
  id: string; // `${provider}:${model}` e.g. "codex:gpt-6.1-sol", "claude:claude-opus-5-5"; a connection of settings.json: `${its id}:${model}`
  provider: ProviderId;
  model: string; // provider model id
  name: string; // display name
  engine: EngineId;
  efforts: Effort[]; // supported, normalized
  defaultEffort?: Effort;
  caps: ModelCaps;
  scores?: ModelScores;
  tier: 'local' | 'small' | 'strong' | 'frontier';
  /** Addition (R3-R): relative marginal price 0..1 (curated priors, else AA list prices, else tier
   * default; 0 for local runtimes). Subscription discounts are applied by the router per account. */
  relCost?: number;
  /** B-078 (D16): overall capability 0..100 (curated priors); undefined when the priors do not rate the model. */
  smarts?: number;
  /** B-078 (D16): the API list price (curated, else the daily OpenRouter list); undefined when unknown. */
  price?: ModelPrice;
  /** Category → prior strength in [-1, 1] (curated priors + learned outcomes). */
  strengths: Record<string, number>;
  available: boolean; // at least one healthy account can run it
  accounts: string[]; // account ids that can run it
  /** Addition (FN1): media functions this specialist serves (it is never routed for chat). */
  functions?: ModelFunction[];
}

/** Agent/chat level preference. Router stays inside these bounds. */
export interface ModelPolicy {
  pin?: string; // fixed model id (hard pin) or undefined for auto
  effort?: Effort; // fixed effort
  floorTier?: ModelInfo['tier'];
  ceilingTier?: ModelInfo['tier'];
  costMode?: 'economy' | 'balanced' | 'best';
  prefer?: string[]; // model ids preferred
  avoid?: string[]; // model ids to avoid
}

export interface RouteDecision {
  modelId: string;
  engine: EngineId;
  accountId: string;
  effort: Effort;
  category: string;
  reason: string; // short human-readable explanation ("video animation · Opus strongest prior")
  by: 'pin' | 'rules' | 'decision-model' | 'fallback' | 'previous' | 'hint'; // 'hint' (SG): the chat's model suggestion, shared/model/model-guide.ts
  alternatives: string[]; // next candidates (failover order)
}

export interface UsageSummary {
  accountId: string;
  provider: ProviderId;
  label: string;
  /** B-078 (D17): the plan's short name for the rail (shared/model/plan-names.ts: a label of the person's own, else the e-mail's local part). */
  name?: string;
  active: boolean; // currently chosen by rotation
  weeklyRemainingPercent?: number;
  weeklyResetsAt?: number;
  limits?: AccountLimits;
}

/** Result of scanning the PC for engines, logins and local model servers. */
export interface DetectionReport {
  // `dismissed` (PR5): the person removed this login or server – detection no longer adds it ("Add again").
  clis: Array<{ provider: 'codex' | 'claude' | 'gemini-cli' | 'copilot' | 'kimi-cli'; path?: string; version?: string; loggedIn?: boolean; method?: string; dismissed?: boolean }>;
  localServers: Array<{ provider: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm'; baseUrl: string; models: string[]; dismissed?: boolean }>;
  envKeys: string[]; // names of provider env vars that are set (never values; ENV_KEY_PROVIDERS)
  tailscale?: { running: boolean; dnsName?: string };
  checkedAt: number;
}

// ------------------------------------------------------------------ provider keys in the environment (PR5)

/**
 * The one env → provider table: the key variables detection reports (names only), what
 * accounts.add {envVar} accepts and what Settings offers to use. OLLAMA_API_KEY is only reported (a local Ollama server needs no key).
 */
export const ENV_KEY_PROVIDERS: Readonly<Record<string, ProviderId>> = {
  OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic', OPENROUTER_API_KEY: 'openrouter', GEMINI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google', XAI_API_KEY: 'xai', DEEPSEEK_API_KEY: 'deepseek', OLLAMA_API_KEY: 'ollama',
  GROQ_API_KEY: 'groq', ELEVENLABS_API_KEY: 'elevenlabs', FAL_KEY: 'fal', // B-058
};

/** B-058: providers with media models only (runtime/media/providers adapters) – no chat engine, never an agent turn. */
export const MEDIA_ONLY_PROVIDERS: readonly ProviderId[] = ['elevenlabs', 'fal'];

/** The provider a key variable keys; undefined for any other name (prototype names included). */
export function envKeyProvider(name: string): ProviderId | undefined {
  return Object.hasOwn(ENV_KEY_PROVIDERS, name) ? ENV_KEY_PROVIDERS[name] : undefined;
}

// ------------------------------------------------------------------ function models (FN1)

/** Media functions served by specialist models: speech to text, text to speech, image, video, music, sound effects (B-058). */
export const MODEL_FUNCTIONS = ['stt', 'tts', 'image', 'video', 'music', 'sound'] as const;
export type ModelFunction = (typeof MODEL_FUNCTIONS)[number];

/** Settings value of a media use (routing.<fn>, shared/model/models-uses.ts) that turns it off. */
export const FUNCTION_OFF = 'off';

/**
 * Models for a media function, best first: the Settings choice (the use routing.<fn>) while it is
 * available and serves fn, then every other available specialist for fn, cheapest (local) first.
 * 'off' → none; 'auto' or unset → no choice. A choice that does not serve fn is ignored.
 * Pure: the runtime resolver (models/functions.ts) and the dictation's download note share it.
 */
export function functionCandidates(fn: ModelFunction, setting: string | undefined, models: readonly ModelInfo[]): Array<{ model: ModelInfo; source: 'settings' | 'auto' }> {
  if (setting === FUNCTION_OFF) return [];
  if (setting === 'auto') setting = undefined;
  const serving = models.filter((model) => model.available && Boolean(model.functions?.includes(fn)));
  // the id, the older "<provider>:<model>" of a connection that now names itself, or a bare model name
  const chosen = setting ? serving.find((model) => model.id === setting) ?? serving.find((model) => `${model.provider}:${model.model}` === setting) ?? serving.find((model) => model.model === setting) : undefined;
  const rest = serving.filter((model) => model !== chosen).sort((a, b) => (a.relCost ?? 1) - (b.relCost ?? 1));
  return [...(chosen ? [{ model: chosen, source: 'settings' as const }] : []), ...rest.map((model) => ({ model, source: 'auto' as const }))];
}

// ------------------------------------------------------------------ plan CLIs on the ACP engine (PR8)

/** Gemini CLI, GitHub Copilot CLI and Kimi Code: plan accounts that run on the generic ACP engine (runtime/engines/acp/providers.ts). */
export const ACP_PLAN_PROVIDERS: readonly ProviderId[] = ['gemini-cli', 'copilot', 'kimi-cli'];

/**
 * An ACP plan: one sign-in per PC in the CLI's default home (Kimi Code: also isolated homes per
 * account, KIMI_CODE_HOME – B-044). Account selection applies the plan rule of plan-roles.ts to it
 * (primary, others only in opt-in rotation), but it has no limit readings, so the account monitor
 * does not keep re-checking it (isPlanProvider stays Codex/Claude Code).
 */
export function isAcpPlan(provider: ProviderId): boolean {
  return ACP_PLAN_PROVIDERS.includes(provider);
}
