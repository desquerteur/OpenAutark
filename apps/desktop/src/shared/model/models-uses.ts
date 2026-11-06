// The model uses (owner 01.11.2026: "Provider, dann API-Key, dann KI-Modelle … wo man das jeweilige wählen kann, was
// man für das jeweilige braucht"): one short fixed list of purposes, each stored in settings.json's Models section
// (routing.<use>): "auto" while nothing is picked yet (the runtime takes what is there; Settings shows what that is,
// models.uses), or a model of any connection. Work = every agent turn (a model id, or a plan's
// provider id such as "codex" = that plan's best model for each turn); Decisions = small fast calls (choices,
// sorting, summaries, compaction); Voice = realtime conversations; stt … sound = the media functions ("off" turns
// one off; tts "local" = the local voice, image "codex" = the ChatGPT plan); Embeddings = what vector.embed and vector.search embed with ("off" turns them off, "local" = this PC's small model). What a use resolves to is the runtime's job (routing/pins.ts, models/functions.ts, calls/realtime, models/uses.ts says it).
// Also the one-time move of the older keys (functions.<fn>, decisionModel, helper, workPlan, voice.realtimeModel) into
// the uses – settings.json's read applies it once (settings/read.ts), and every reader of a use goes through it, so an
// older object reads the same.
// Owns: the list, its labels and texts, which models serve which use, and that move. Never: reads settings or the
// catalog itself, or decides a route.

import type { AbilityAction, AbilityState } from './abilities.ts';
import type { ModelInfo, ProviderId } from './providers.ts';

export const MODEL_USES = ['work', 'decision', 'voice', 'stt', 'tts', 'image', 'video', 'music', 'sound', 'embeddings'] as const;
export type ModelUse = (typeof MODEL_USES)[number];

/** Nothing picked yet: the runtime takes what is there. */
export const USE_AUTO = 'auto';
/** A media use (or embeddings) turned off. */
export const USE_OFF = 'off';
/** This PC's own model, as a stored value (embeddings; tts: the local voice). */
export const USE_LOCAL = 'local';
/** The stored value that names a kind's free route (media/generate-route.ts). */
export const FREE_ROUTE_CHOICE = { speech: USE_LOCAL, image: 'codex' } as const;

/**
 * What a use resolves to right now (models.uses, runtime/models/uses.ts) – what Settings' selects show.
 * 'model': a model on an account; 'plan': a plan account's best fit for each turn, or the ChatGPT plan's images;
 * 'this-pc': a model on this PC; 'off': turned off; 'none': nothing can serve it now.
 */
export interface UseNow {
  use: ModelUse;
  /** routing.<use> as stored ("auto": nothing picked yet). */
  stored: string;
  kind: 'model' | 'plan' | 'this-pc' | 'off' | 'none';
  accountId?: string;
  /** The catalog id, or a local speech model's id. */
  modelId?: string;
  /** The name to show. */
  name?: string;
  /** 'ready': works now; 'setup': one step away; 'off': off, or nothing can serve it. */
  state: AbilityState;
  /** Why it is not ready, or a limit. */
  note?: string;
  /** The one action that helps (a download of a local model, or the AI). */
  action?: AbilityAction;
  /** A stored choice that cannot serve now (something else stands in, or nothing). */
  gone?: string;
  /** This PC can run a model for this use. */
  thisPc?: boolean;
}

/** Uses that can be turned off (the media functions, embeddings). */
export const OFFABLE_USES: ReadonlySet<ModelUse> = new Set<ModelUse>(['stt', 'tts', 'image', 'video', 'music', 'sound', 'embeddings']);

export const USE_LABELS: Readonly<Record<ModelUse, string>> = {
  work: 'Work', decision: 'Decisions', voice: 'Voice conversation', stt: 'Speech to text', tts: 'Text to speech',
  image: 'Images', video: 'Video', music: 'Music', sound: 'Sound effects', embeddings: 'Embeddings',
};

/** What each use is for, one line (Settings rows and settings.json comments). */
export const USE_ABOUT: Readonly<Record<ModelUse, string>> = {
  work: 'Every agent turn – a chat\'s or an agent\'s own model choice comes first',
  decision: 'Small fast calls: choices, sorting, summaries, compaction',
  voice: 'Talking in a call: a real-time model (OpenAI or Google key), or this PC\'s speech (voice.realtime "off")',
  stt: 'Turns speech into text (this PC\'s speech model comes first)',
  tts: 'Reads text aloud',
  image: 'Makes images',
  video: 'Makes videos',
  music: 'Makes music and songs',
  sound: 'Makes sound effects',
  embeddings: 'Makes files and memory searchable by meaning (this PC\'s small model comes first)',
};

/** The uses as stored (settings.json routing.<use>). */
export type ModelUses = Record<ModelUse, string>;

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);
const filled = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
/** A stored choice that names a model (not "auto" or the older helper default "subscription"). */
const named = (value: unknown): string | undefined => {
  const text = filled(value);
  return text && text !== USE_AUTO && text !== 'subscription' ? text : undefined;
};

/** Keys of the Models section before the uses (moved once, then gone). */
const OLD_KEYS = ['functions', 'decisionModel', 'helper', 'workPlan'] as const;

/**
 * The Models section with the older keys moved into the uses: functions.chat → work, workPlan (a plan's provider id)
 * → work, decisionModel / helper (a model id) / functions.compaction → decision, functions.<media> → that use,
 * `realtimeModel` (voice.realtimeModel, "<accountId>:<model>") → voice. A use already set wins; the older keys go.
 * Anything else stays as it is (the settings reader drops what it does not know). Pure; the same object again when
 * there was nothing to move.
 */
export function migrateRouting(routing: unknown, realtimeModel?: unknown): Plain {
  const section: Plain = isPlain(routing) ? routing : {};
  const voice = filled(realtimeModel);
  if (!OLD_KEYS.some((key) => key in section) && !voice) return section;
  const out: Plain = { ...section };
  for (const key of OLD_KEYS) delete out[key];
  const functions = isPlain(section.functions) ? section.functions : {};
  const plan = filled(section.workPlan);
  const moved: Partial<Record<ModelUse, string | undefined>> = {
    work: named(functions.chat) ?? (plan && plan !== 'none' ? plan : undefined),
    decision: named(section.decisionModel) ?? named(section.helper) ?? named(functions.compaction),
    voice,
    stt: filled(functions.stt), tts: filled(functions.tts), image: filled(functions.image),
    video: filled(functions.video), music: filled(functions.music), sound: filled(functions.sound),
  };
  for (const use of MODEL_USES) {
    const value = moved[use];
    if (value && !named(out[use]) && !(OFFABLE_USES.has(use) && filled(out[use]) === USE_OFF)) out[use] = value;
  }
  return out;
}

/** The stored value of a use: "auto", "off" or a model (or plan) id; an older object reads through migrateRouting. */
export function useValue(routing: unknown, use: ModelUse): string {
  const value = filled(migrateRouting(routing)[use]);
  if (!value || (value === USE_OFF && !OFFABLE_USES.has(use))) return USE_AUTO;
  return value;
}

/** The chosen model (or plan) id of a use; undefined for "auto" and "off". */
export function chosenFor(routing: unknown, use: ModelUse): string | undefined {
  const value = useValue(routing, use);
  return value === USE_AUTO || value === USE_OFF ? undefined : value;
}

/** The plans Work can name by provider alone ("codex" = that plan's best model for each turn). */
export const WORK_PLAN_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini-cli', 'copilot', 'kimi-cli'];

/** A use's value is a plan's provider id alone (Work: that plan's best model for each turn), not a model id. */
export function isProviderChoice(value: string): boolean {
  return (WORK_PLAN_PROVIDERS as readonly string[]).includes(value);
}

/** Strength at or below this means "never" for a category (runtime routing/score.ts NEVER). */
const NEVER = -0.95;
const REALTIME_NAME = /(^|[-_.:/])realtime([-_.]|$)|^(models\/)?gemini[\w.-]*([-_.]live([-_.]|$)|native-audio)/i;
const EMBEDDING_NAME = /embed|(^|\/)(bge-|e5-|gte-)/i;
const RERANK_NAME = /rerank/i;

/** The real-time model a key of these providers talks with when its server lists none (runtime/calls/realtime/adapters.ts). */
export const VOICE_DEFAULTS = { openai: 'gpt-realtime', google: 'gemini-3.8-live' } as const;

export function voiceDefault(provider: string): string | undefined {
  return Object.hasOwn(VOICE_DEFAULTS, provider) ? VOICE_DEFAULTS[provider as keyof typeof VOICE_DEFAULTS] : undefined;
}

/** A realtime voice model by its name (OpenAI's gpt-realtime family, compatible servers' *-realtime-*, Gemini's Live models). */
export function isRealtimeModel(model: Pick<ModelInfo, 'model'>): boolean {
  return REALTIME_NAME.test(model.model);
}

/** A realtime model a person can talk with (a live transcriber or translator streams too, but gives no conversation). */
export function talksLive(model: Pick<ModelInfo, 'model'>): boolean {
  return isRealtimeModel(model) && !/transcribe|translate/i.test(model.model);
}

/** A general model the agents can talk with (no media specialist, not "never" for chat, no realtime stream). */
export function isChatModel(model: Pick<ModelInfo, 'functions' | 'strengths' | 'model'>): boolean {
  return !model.functions?.length && (model.strengths?.chat ?? 0) > NEVER && !isRealtimeModel(model);
}

/** Whether `model` can serve `use`: settings.json says so (caps.uses), else its name and kind tell. */
export function servesUse(model: Pick<ModelInfo, 'functions' | 'strengths' | 'model'> & { caps?: ModelInfo['caps'] }, use: ModelUse): boolean {
  if (model.caps?.uses?.includes(use)) return true;
  if (use === 'work' || use === 'decision') return isChatModel(model);
  if (use === 'voice') return talksLive(model);
  if (use === 'embeddings') return EMBEDDING_NAME.test(model.model) && !RERANK_NAME.test(model.model);
  return Boolean(model.functions?.includes(use));
}

/** The connected models that can serve `use`, by provider and name. */
export function modelsFor(use: ModelUse, models: readonly ModelInfo[]): ModelInfo[] {
  return models.filter((model) => model.available && servesUse(model, use))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name, 'en', { numeric: true }) || a.id.localeCompare(b.id));
}
