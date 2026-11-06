// Keyless list prices (B-078, D16): once a day, with a full catalog refresh of the running app (models/catalog.ts), one GET of
// OpenRouter's public model list (https://openrouter.ai/api/v1/models – no key needed, USD per token as strings) is turned
// into "$ per 1M tokens" per model and kept in kv ('prices', 'openrouter'). The catalog uses these prices only for models
// the curated priors (resources/model-priors.json) do not price; the priors always win. A model is matched by its bare id
// with '.', '_' and ':' read as '-' ("anthropic/claude-opus-5.5" = "claude-opus-5-5"). A failed or odd answer is logged and
// skipped – the stored list stays as it was.
// Owns: the fetch, the parse, the key rule and the stored list. Never: overrides a curated price, sends a key or polls
// (the catalog's refresh cycle asks, at most once a day).

import type { Db } from '../db/database.ts';
import type { Clock, Logger } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';

export const PRICE_FEED_URL = 'https://openrouter.ai/api/v1/models';
/** One fetch a day at most. */
export const PRICE_FEED_MS = 24 * 60 * 60_000;
/** After a failure, the next try waits this long (no retry storm on a flaky network). */
const RETRY_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 20_000;
const MAX_ENTRIES = 3000;
const MAX_PRICE_PER_M = 10_000;
const KV = { ns: 'prices', key: 'openrouter' } as const;

/** List prices by feedKey. */
export type FeedPrices = ReadonlyMap<string, { inputPerM: number; outputPerM: number }>;

interface Stored { at: number; tried?: number; prices: Record<string, [number, number]> }

/** A model id as both sides compare it: the bare id (no vendor prefix), lower case, '.', '_', ':' and spaces as '-'. */
export function feedKey(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1).trim().toLowerCase().replace(/[._:\s]+/g, '-');
}

/** USD per token (a string or number) → USD per 1M; undefined when missing, negative ("-1" = varies) or absurd. */
function perMillion(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return undefined;
  const perM = Math.round(number * 1_000_000 * 10_000) / 10_000;
  return perM <= MAX_PRICE_PER_M ? perM : undefined;
}

/** OpenRouter's /models answer → prices by feedKey (the first entry of a key wins; ':free' variants keep their own key). */
export function parseFeed(json: unknown): Map<string, { inputPerM: number; outputPerM: number }> {
  const out = new Map<string, { inputPerM: number; outputPerM: number }>();
  const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (out.size >= MAX_ENTRIES) break;
    if (!item || typeof item !== 'object') continue;
    const entry = item as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
    if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 200) continue;
    const inputPerM = perMillion(entry.pricing?.prompt);
    const outputPerM = perMillion(entry.pricing?.completion);
    if (inputPerM === undefined || outputPerM === undefined) continue;
    const key = feedKey(entry.id);
    if (!out.has(key)) out.set(key, { inputPerM, outputPerM });
  }
  return out;
}

function stored(db: Db): Stored | undefined {
  try {
    const value = new KvRepo(db).get<Stored>(KV.ns, KV.key);
    return value && typeof value.at === 'number' && value.prices && typeof value.prices === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The stored list (empty without one). */
export function storedFeed(db: Db): FeedPrices {
  const value = stored(db);
  const out = new Map<string, { inputPerM: number; outputPerM: number }>();
  for (const [key, pair] of Object.entries(value?.prices ?? {})) {
    if (Array.isArray(pair) && typeof pair[0] === 'number' && typeof pair[1] === 'number') out.set(key, { inputPerM: pair[0], outputPerM: pair[1] });
  }
  return out;
}

/** Is a fetch due now (the last good list is older than a day and the last failure lies 6 h back)? */
export function feedDue(db: Db, now: number): boolean {
  const value = stored(db);
  if (!value) return true;
  return now - value.at >= PRICE_FEED_MS && now - (value.tried ?? 0) >= RETRY_MS;
}

export interface FeedDeps {
  db: Db;
  clock: Pick<Clock, 'now'>;
  log: Pick<Logger, 'warn' | 'info'>;
  /** The GET; tests pass their own. */
  fetch?: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** Fetches and stores the list when it is due; true when the stored prices changed. Never throws. */
export async function refreshFeed(deps: FeedDeps): Promise<boolean> {
  const now = deps.clock.now();
  if (!feedDue(deps.db, now)) return false;
  const kv = new KvRepo(deps.db);
  const before = stored(deps.db);
  try {
    const get = deps.fetch ?? ((url, init) => fetch(url, init));
    const response = await get(PRICE_FEED_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = parseFeed(await response.json());
    if (!prices.size) throw new Error('no prices in the answer');
    const record: Stored = { at: now, prices: Object.fromEntries([...prices].map(([key, value]) => [key, [value.inputPerM, value.outputPerM]])) };
    kv.set(KV.ns, KV.key, record, now);
    deps.log.info('model list prices refreshed', { models: prices.size });
    return JSON.stringify(before?.prices ?? {}) !== JSON.stringify(record.prices);
  } catch (error) {
    deps.log.warn('model list prices skipped', { error: error instanceof Error ? error.message : String(error) });
    try { kv.set(KV.ns, KV.key, { at: before?.at ?? 0, tried: now, prices: before?.prices ?? {} }, now); } catch { /* the next refresh tries again */ }
    return false;
  }
}
