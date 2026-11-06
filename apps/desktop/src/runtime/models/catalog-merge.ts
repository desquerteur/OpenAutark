// Pure merge rules of the model catalog: one engine-listed model + curated priors (models/priors.ts,
// resources/model-priors.json) -> one ModelInfo; plus the `models` table row mapping. The curated priors are the one
// score source: strengths per category, tier, relative cost, efforts and caps; B-078: smarts and the list price (curated,
// else the daily keyless list of models/price-feed.ts, which the caller passes in).
// Owns: tier/cost/effort/caps defaults, specialist detection (decision/embedding-only models and media function
// models - speech to text, text to speech, image, video, music, sound effects - get -1 = "never" for every other
// category, so the router never treats them as suitable for a chat category; B-058: the curated models of media-only
// providers, media/providers/models.ts, by their table, with its relative price), the listing fields kept (B-058:
// whether a model hears audio - audioIn; models the app cannot use at all are dropped, UNUSABLE_NAME), the catalog
// order and the account fingerprint that decides when a listing is re-fetched.
// Never: I/O, network or clock access (callers pass everything in).

import { DECISION_PROVIDER, MODEL_FUNCTIONS, type Account, type EngineId, type ModelCaps, type ModelFunction, type ModelInfo, type ModelPrice, type ProviderId } from '../../shared/model/providers.ts';
import type { ModelUse } from '../../shared/model/models-uses.ts';
import type { EngineModel } from '../engines/types.ts';
import { LOCAL_PROVIDERS } from '../engines/http/common.ts';
import { json, toJson } from '../db/database.ts';
import { CATEGORIES, relCostOfPrices, type PriorEntry, type Priors } from './priors.ts';
import { feedKey, type FeedPrices } from './price-feed.ts';
import { clampEffort, normalizeEffort, normalizeEfforts } from './efforts.ts';
import { staticMediaModel } from '../media/providers/models.ts';

// B-058 G7: a listing says whether the model hears audio input (Codex model/list inputModalities 'audio'); undefined = not reported.
// B-066: `uses` – what settings.json says the model is for (models/catalog-named.ts).
declare module '../engines/types.ts' { interface EngineModel { audioIn?: boolean; uses?: readonly ModelUse[] } }

export type Tier = ModelInfo['tier'];

/** Raw model list of one account as its engine reported it (persisted for offline rebuilds). */
export interface Listing {
  models: EngineModel[];
  at: number;
}

const SPECIALTIES: ReadonlySet<string> = new Set(['decision', 'embeddings', ...MODEL_FUNCTIONS]);
/** Decision ("System One") model families local servers may list; they answer typed questions, never chat (bare, lower case names). */
export const DECISION_NAME = /^(nimble|tev1|jev|pplx-decider|strands-decider|clef|clef-flash|laya|kev|d1|elephant|mammoth|julia|lev|openjev)([:\-_.]|$)/;
const EMBEDDING_NAME = /(embed|rerank|^bge-|^e5-|^gte-)/;
/** Media function model names (bare, lower case) as OpenAI-compatible /models listings report them.
 *  B-058: Nano Banana and Z-Image images, Gemini Omni / Grok Imagine and other video families, ElevenLabs
 *  (eleven_* speech, scribe_* transcription), Groq's Orpheus speech (never chat; listings drop it, UNUSABLE_NAME), Stable Audio
 *  (music and sound effects) and sound effect models. */
const FUNCTION_NAMES: ReadonlyArray<[ModelFunction, RegExp]> = [
  ['stt', /whisper|transcri|^scribe[-_]/],
  ['tts', /(^|[-_.])tts([-_.]|$)|speech|^orpheus[-_]|^eleven_(?!.*(text_to_sound|sts|ttv))/],
  ['image', /gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|nano-banana|z-image|(^|[-_.])image([-_.]|$)/],
  ['video', /sora|(^|[-_.])veo|kling|runway|gemini-omni|grok-imagine-video|seedance|hailuo|pixverse/],
  ['music', /lyria|music|stable-audio/],
  ['sound', /sound[-_]effect|sound-generation|text[-_]to[-_]sound|(^|[-_.])sfx([-_.]|$)|stable-audio|mmaudio/],
];
/** B-058 review: listed models the app can neither chat with nor serve a function through – dropped from listings: Groq's
 *  Orpheus voices (own voice ids, WAV only, ≤ 200 characters, English/Arabic; the compatible speech call sends none of that, so
 *  a Groq key for free transcription would take media.speak from the local voice and fail) and safety classifiers (labels, not turns).
 *  B-058 T6 review: the Gemini API's Lyria RealTime (a websocket stream, not a song – media/providers/gemini.ts refuses it) and
 *  Gemini Transcribe (its own API: Google's OpenAI layer has no /audio/transcriptions, so as the stt choice it took dictation and
 *  agent transcription from the local model's fallback and from Gemini's listening models, and failed with HTTP 404). */
const UNUSABLE_NAME = /^orpheus[-_]|prompt-guard|llama-guard|safeguard|^lyria-realtime|^gemini-[\w.-]*transcribe/;
const SMALL_NAME = /(mini|nano|flash-lite|lite$|haiku|luna|small|tiny)/;
const TIER_COST: Record<Tier, number> = { local: 0, small: 0.05, strong: 0.3, frontier: 0.6 };
const TIERS: ReadonlySet<string> = new Set(['local', 'small', 'strong', 'frontier']);

function bare(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1).toLowerCase();
}

/** A decision model's name as a provider lists it ('tev1:0.8b', 'library/nimble'). */
export function isDecisionModelName(model: string): boolean {
  return DECISION_NAME.test(bare(model));
}

/** What about an account changes its model list (state/limits churn does not). */
export function fingerprint(account: Account): string {
  return JSON.stringify([account.provider, account.home ?? '', account.baseUrl ?? '', account.secretId ?? '', account.plan ?? '', account.deviceId ?? '']);
}

/** Catalog order: provider, then name, then id. */
export function byProviderName(a: ModelInfo, b: ModelInfo): number {
  return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

/** Accounts whose models count as connected (transient cooling is checked live by the router). */
export function isConnected(account: Account): boolean {
  return account.enabled && (account.state === 'ok' || account.state === 'unknown' || account.state === 'cooling');
}

/** Accounts whose model list may be (re)fetched now. */
export function isListable(account: Account): boolean {
  return account.enabled && (account.state === 'ok' || account.state === 'unknown');
}

/** Prior for a provider model id; OpenRouter ids ("anthropic/claude-opus-5-5") also try the bare id. */
export function priorFor(priors: Priors, model: string, id: string): PriorEntry | undefined {
  return priors.forModel(model, id) ?? (model.includes('/') ? priors.forModel(model.slice(model.lastIndexOf('/') + 1)) : undefined);
}

/**
 * Specialist categories (decision, embeddings, media functions) a model is limited to; empty for
 * general models. A prior with positive strengths only in specialties sets them (e.g. { stt: 0.8 }
 * for a transcription model with an unusual name) and then alone decides the media functions.
 * Otherwise a media name match counts unless the prior names that function itself: { tts: -1 }
 * marks a false match, { chat: 0.5, stt: 0.6 } a model that also chats. General strengths alone
 * never hide a match, so a family glob ("gpt-6-luna*", "gemini-3.8-flash*") does not turn its
 * media variants (gpt-6-luna-tts, gemini-3.8-flash-image) into chat models.
 * B-058: a curated model of a media-only provider (`provider` given) serves exactly its table's function.
 */
export function specialties(model: string, prior?: PriorEntry, provider?: ProviderId): string[] {
  const curatedMedia = provider ? staticMediaModel(provider, model) : undefined;
  if (curatedMedia) return [curatedMedia.fn];
  const out = new Set<string>();
  const strengths = prior?.strengths ?? {};
  const positive = Object.keys(strengths).filter((category) => strengths[category] > 0);
  const curated = positive.length > 0 && positive.every((category) => SPECIALTIES.has(category));
  if (curated) for (const category of positive) out.add(category);
  const name = bare(model);
  if (DECISION_NAME.test(name)) out.add('decision');
  if (EMBEDDING_NAME.test(name)) out.add('embeddings');
  const curatedFunctions = curated && positive.some((category) => isFunction(category));
  if (!curatedFunctions) for (const [fn, pattern] of FUNCTION_NAMES) if (pattern.test(name) && strengths[fn] === undefined) out.add(fn);
  return [...out];
}

function isFunction(category: string): category is ModelFunction {
  return (MODEL_FUNCTIONS as readonly string[]).includes(category);
}

/**
 * The specialties of a model settings.json says something about (caps.uses): a chat use means a general model, whatever its
 * name looks like; other uses add to what the name tells. A decision connection's model does nothing else.
 */
function specialtiesOf(model: string, prior: PriorEntry | undefined, provider: ProviderId, uses: readonly ModelUse[] | undefined): string[] {
  if (provider === DECISION_PROVIDER) return ['decision'];
  if (!uses?.length) return specialties(model, prior, provider);
  if (uses.includes('work') || uses.includes('decision')) return [];
  return [...new Set([...uses, ...specialties(model, prior, provider)])];
}

/** The media functions among a model's specialties (ModelInfo.functions). */
export function functionsOf(special: readonly string[]): ModelFunction[] {
  return MODEL_FUNCTIONS.filter((fn) => special.includes(fn));
}

/** Specialists: −1 ("never") for every category outside their specialty that has no value yet. */
function fillNever(strengths: Record<string, number>, special: readonly string[]): Record<string, number> {
  if (special.length) for (const category of CATEGORIES) if (!special.includes(category) && strengths[category] === undefined) strengths[category] = -1;
  return strengths;
}

/** Media function models: -1 for every known and every stored category outside their specialty, whatever a (family) prior or an old stored row says. */
function neverOutside(strengths: Record<string, number>, special: readonly string[]): Record<string, number> {
  if (!special.some(isFunction)) return strengths;
  for (const category of new Set<string>([...CATEGORIES, ...Object.keys(strengths)])) if (!special.includes(category)) strengths[category] = -1;
  return strengths;
}

/** Prior strengths; specialists get -1 for every category outside their specialty. */
export function strengthsFor(prior: PriorEntry | undefined, special: readonly string[]): Record<string, number> {
  return neverOutside(fillNever({ ...(prior?.strengths ?? {}) }, special), special);
}

/** Relative marginal price: local 0; the curated relCost (or the one its list prices give); the feed's list price; the tier default. */
export function relCostFor(input: { local: boolean; prior?: PriorEntry; tier: Tier; price?: ModelPrice }): number {
  if (input.local) return 0;
  if (input.prior?.relCost !== undefined) return input.prior.relCost;
  return input.price ? relCostOfPrices(input.price.inputPerM, input.price.outputPerM) : TIER_COST[input.tier];
}

/** B-078: the list price – the curated one, else the daily OpenRouter list's (price-feed.ts); none for local models. */
export function priceFor(input: { local: boolean; prior?: PriorEntry; model: string; feed?: FeedPrices }): ModelPrice | undefined {
  if (input.local) return undefined;
  const { prior } = input;
  if (prior?.priceInputPerM !== undefined && prior.priceOutputPerM !== undefined) return { inputPerM: prior.priceInputPerM, outputPerM: prior.priceOutputPerM, source: 'priors' };
  const fed = input.feed?.get(feedKey(input.model));
  return fed ? { inputPerM: fed.inputPerM, outputPerM: fed.outputPerM, source: 'feed' } : undefined;
}

/** smarts, price and relCost of a model (buildModel and fromRow agree, so a rebuild compares equal). */
function valueFields(input: { provider: ProviderId; model: string; prior?: PriorEntry; tier: Tier; feed?: FeedPrices }): Pick<ModelInfo, 'relCost' | 'smarts' | 'price'> {
  const local = LOCAL_PROVIDERS.has(input.provider);
  const media = staticMediaModel(input.provider, input.model);
  const price = media ? undefined : priceFor({ local, prior: input.prior, model: input.model, feed: input.feed });
  return {
    relCost: media?.relCost ?? relCostFor({ local, prior: input.prior, tier: input.tier, price }),
    ...(input.prior?.smarts !== undefined ? { smarts: input.prior.smarts } : {}),
    ...(price ? { price } : {}),
  };
}

export interface BuildInput {
  provider: ProviderId;
  engine: EngineId;
  listed: EngineModel;
  priors: Priors;
  /** The id's prefix when the connection names itself in settings.json (default: the provider). */
  owner?: string;
  /** B-078: list prices of the daily OpenRouter list, for models the priors do not price. */
  feed?: FeedPrices;
}

/** One catalog entry (accounts/available are filled by the caller). */
export function buildModel(input: BuildInput): ModelInfo {
  const { provider, engine, listed } = input;
  const id = `${input.owner ?? provider}:${listed.model}`;
  const prior = priorFor(input.priors, listed.model, `${provider}:${listed.model}`);
  const local = LOCAL_PROVIDERS.has(provider);
  // The engine knows which efforts its harness accepts; priors only fill in when it reports none.
  const efforts = listed.efforts?.length ? normalizeEfforts(listed.efforts) : (prior?.efforts ?? []);
  const wantedDefault = prior?.defaultEffort ?? normalizeEffort(listed.defaultEffort);
  const defaultEffort = wantedDefault ? clampEffort(wantedDefault, efforts) : undefined;
  const caps: ModelCaps = { ...(prior?.caps ?? {}) };
  if (typeof listed.vision === 'boolean') caps.vision = listed.vision;
  if (typeof listed.audioIn === 'boolean') caps.audioIn = listed.audioIn;
  if (typeof listed.contextTokens === 'number' && listed.contextTokens > 0) caps.contextTokens = listed.contextTokens;
  if (listed.uses?.length) caps.uses = listed.uses;
  const tier: Tier = prior?.tier ?? (local ? 'local' : SMALL_NAME.test(bare(listed.model)) ? 'small' : 'strong');
  const special = specialtiesOf(listed.model, prior, provider, listed.uses);
  // A family prior ("gpt-6-luna*") does not name its media variants (gpt-6-luna-tts stays itself).
  const familyOnly = special.some(isFunction) && !MODEL_FUNCTIONS.some((fn) => prior?.strengths[fn] !== undefined);
  const name = listed.name && listed.name !== listed.model ? listed.name : (familyOnly ? undefined : prior?.name) ?? listed.model;
  const info: ModelInfo = {
    id, provider, model: listed.model, name: name.slice(0, 200), engine, efforts, defaultEffort, caps, tier,
    ...valueFields({ provider, model: listed.model, prior, tier, feed: input.feed }),
    strengths: strengthsFor(prior, special),
    available: false, accounts: [], functions: functionsOf(special),
  };
  if (!info.defaultEffort) delete info.defaultEffort;
  if (!info.functions?.length) delete info.functions;
  return info;
}

// ------------------------------------------------------------------ models table

export interface ModelRow {
  id: string; provider: string; model: string; name: string; engine: string; efforts: string; default_effort: string | null;
  caps: string; scores: string | null; tier: string; strengths: string; accounts: string; available: number; updated_at: number;
}

/**
 * Row -> ModelInfo; relCost and functions are derived (not stored) from the priors, tier and name. Rows stored before a
 * model counted as a specialist get its "never" strengths right away (the next rebuild stores them). Stored scores of
 * older versions (rating feeds) are not read.
 */
export function fromRow(row: ModelRow, priors: Priors, feed?: FeedPrices): ModelInfo {
  const provider = row.provider as ProviderId;
  const tier = (TIERS.has(row.tier) ? row.tier : 'strong') as Tier;
  const prior = priorFor(priors, row.model, `${provider}:${row.model}`);
  const caps = json<ModelCaps>(row.caps, {});
  const special = specialtiesOf(row.model, prior, provider, caps.uses);
  const info: ModelInfo = {
    id: row.id, provider, model: row.model, name: row.name, engine: row.engine as EngineId,
    efforts: normalizeEfforts(json<unknown[]>(row.efforts, [])), defaultEffort: normalizeEffort(row.default_effort ?? undefined),
    caps, tier,
    ...valueFields({ provider, model: row.model, prior, tier, feed }),
    strengths: neverOutside(fillNever(json<Record<string, number>>(row.strengths, {}), special), special),
    available: row.available === 1, accounts: json<string[]>(row.accounts, []), functions: functionsOf(special),
  };
  if (!info.defaultEffort) delete info.defaultEffort;
  if (!info.functions?.length) delete info.functions;
  return info;
}

export function toRowParams(info: ModelInfo, now: number): Array<string | number | null> {
  return [
    info.id, info.provider, info.model, info.name, info.engine, toJson(info.efforts), info.defaultEffort ?? null, toJson(info.caps),
    null, info.tier, toJson(info.strengths), toJson(info.accounts), info.available ? 1 : 0, now,
  ];
}

/** Rebuilds per-account listings from stored rows (first start after an update, before any refresh). */
export function listingsFromRows(rows: readonly ModelInfo[], at: number): Map<string, Listing> {
  const out = new Map<string, Listing>();
  for (const info of rows) {
    for (const accountId of info.accounts) {
      let listing = out.get(accountId);
      if (!listing) out.set(accountId, (listing = { models: [], at }));
      listing.models.push({ model: info.model, name: info.name, efforts: info.efforts, defaultEffort: info.defaultEffort, vision: info.caps.vision, audioIn: info.caps.audioIn, contextTokens: info.caps.contextTokens });
    }
  }
  return out;
}

/** Keeps only plausible, bounded fields of an engine listing (without models the app cannot use, UNUSABLE_NAME). */
export function sanitizeListing(models: readonly EngineModel[], max: number): EngineModel[] {
  const seen = new Set<string>();
  const out: EngineModel[] = [];
  for (const model of models) {
    if (!model || typeof model.model !== 'string' || !model.model.trim() || model.model.length > 200 || model.hidden || seen.has(model.model)) continue;
    if (UNUSABLE_NAME.test(bare(model.model))) continue;
    seen.add(model.model);
    out.push({
      model: model.model, name: typeof model.name === 'string' ? model.name.slice(0, 200) : model.model,
      efforts: normalizeEfforts(Array.isArray(model.efforts) ? model.efforts : []),
      defaultEffort: normalizeEffort(model.defaultEffort),
      vision: typeof model.vision === 'boolean' ? model.vision : undefined,
      audioIn: typeof model.audioIn === 'boolean' ? model.audioIn : undefined,
      contextTokens: typeof model.contextTokens === 'number' && Number.isFinite(model.contextTokens) ? model.contextTokens : undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}
