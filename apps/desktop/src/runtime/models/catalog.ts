// The model catalog: every model the person's accounts can run, merged with the curated priors (the one score
// source, models/priors.ts), kept in the `models` table.
// Owns: per-account engine listings (kv ns 'catalog', so rebuilds need no network), the refresh cycle (coalesced,
// unforced at most every 10 min, account events -> debounced partial refresh of just that account; CLI engines list
// one account at a time), the "recently used" list and the status (sizes, last refresh). B-058: media-only accounts
// (ElevenLabs, fal.ai) list their curated models (catalog-media.ts). B-066: a connection of settings.json's providers names
// its models "<id>:<model>" and what the file says joins its listing (catalog-named.ts); an older "<provider>:<model>" still finds them.
// B-078 (D16): a started catalog's full refresh also asks for the daily keyless price list (price-feed.ts) – it prices only
// models the curated priors leave unpriced.
// Never: proves entitlement (only a completed turn does), throws from refresh (per-account errors are logged) or polls.

import type { ModelCatalog, RuntimeServices } from '../contracts.ts';
import type { Account, EngineId, ModelInfo } from '../../shared/model/providers.ts';
import type { Settings } from '../../shared/model/system.ts';
import { KvRepo } from '../store/kv.ts';
import { engineFor } from '../accounts/candidates.ts';
import type { Priors } from './priors.ts';
import { mediaEngineOf, rebuildListings } from './catalog-media.ts'; // B-058: media-only accounts list their curated models
import { withNamedModels } from './catalog-named.ts'; // B-066: what settings.json names joins the listings
import { modelOwner } from '../../shared/model/provider-entries.ts';
import { refreshFeed, storedFeed, type FeedDeps, type FeedPrices } from './price-feed.ts'; // B-078: prices the priors do not have
import {
  buildModel, byProviderName, fingerprint, fromRow, isConnected, isListable, listingsFromRows, sanitizeListing, toRowParams,
  type Listing, type ModelRow,
} from './catalog-merge.ts';

export interface CatalogDeps {
  services: () => RuntimeServices;
  priors: Priors;
  /** Debounce for account events (default 1500 ms). */
  debounceMs?: number;
  /** B-078: the daily keyless price list (price-feed.ts) of a started catalog – false: never (tests); a function: its GET. */
  priceFeed?: false | FeedDeps['fetch'];
}

/** The `catalog.status` RPC result. */
export interface CatalogStatus {
  models: number;
  available: number;
  /** Last full catalog refresh (model lists of every account). */
  refreshedAt?: number;
}

const NS = 'catalog';
const REFRESH_INTERVAL_MS = 10 * 60_000;
const CLI_LIST_TIMEOUT_MS = 45_000; // CLI engines may have to start their server first
const HTTP_LIST_TIMEOUT_MS = 15_000;
const MAX_MODELS_PER_ACCOUNT = 500;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60_000;
const RECENT_LIMIT = 8;
/** Engines that run a local CLI or agent process: each listing may start one, so they list one account at a time. */
const CLI_ENGINES: ReadonlySet<EngineId> = new Set(['codex', 'claude', 'acp']);
const isCli = (account: Account): boolean => CLI_ENGINES.has(engineFor(account.provider) ?? 'fake');
const UPSERT = `INSERT INTO models (id, provider, model, name, engine, efforts, default_effort, caps, scores, tier, strengths, accounts, available, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model, name = excluded.name, engine = excluded.engine,
    efforts = excluded.efforts, default_effort = excluded.default_effort, caps = excluded.caps, scores = excluded.scores, tier = excluded.tier,
    strengths = excluded.strengths, accounts = excluded.accounts, available = excluded.available, updated_at = excluded.updated_at`;

/** Lookup by id; a connection that names itself is also found by the older "<provider>:<model>" (settings and chats may hold it). */
function indexOf(list: readonly ModelInfo[]): Map<string, ModelInfo> {
  const byId = new Map(list.map((info) => [info.id, info]));
  for (const info of list) {
    const older = `${info.provider}:${info.model}`;
    if (!byId.has(older)) byId.set(older, info);
  }
  return byId;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Catalog implements ModelCatalog {
  private readonly deps: CatalogDeps;
  private cache: { list: ModelInfo[]; byId: Map<string, ModelInfo> } | undefined;
  private listings: Map<string, Listing> | undefined;
  private inflight: Promise<void> | undefined;
  private inflightFull = false;
  private pendingFull = false;
  private readonly pendingAccounts = new Set<string>();
  private pendingRebuild = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private debounced: { accounts: Set<string>; rebuild: boolean } = { accounts: new Set(), rebuild: false };
  private readonly seen = new Map<string, { print: string; connected: boolean; listable: boolean; enabled: boolean }>();
  /** Last failed listing per account: usage/limits churn must not re-run a failing CLI listing every turn. */
  private readonly failedAt = new Map<string, number>();
  private fakeMode: boolean | undefined;
  private unsubscribe: Array<() => void> = [];
  private feed: FeedPrices | undefined;
  private feeding = false;

  constructor(deps: CatalogDeps) {
    this.deps = deps;
  }

  private get s(): RuntimeServices { return this.deps.services(); }
  private kv(): KvRepo { return new KvRepo(this.s.db); }

  // ---------------------------------------------------------------- reads (fast, no network)

  list(): ModelInfo[] {
    return [...this.load().list];
  }

  get(id: string): ModelInfo | undefined {
    return this.load().byId.get(id);
  }

  private load(): { list: ModelInfo[]; byId: Map<string, ModelInfo> } {
    if (!this.cache) {
      const feed = this.prices();
      const list = this.s.db.all<ModelRow>('SELECT * FROM models').map((row) => fromRow(row, this.deps.priors, feed)).sort(byProviderName);
      this.cache = { list, byId: indexOf(list) };
    }
    return this.cache;
  }

  /** settings.json as far as the catalog reads it (a fake without settings: nothing named). */
  private named(): Pick<Settings, 'providers' | 'routing'> | Record<string, never> {
    try { return this.s.settings.get(); } catch { return {}; }
  }

  /** Most used model ids of finished runs in the last 30 days (top 8), only models still in the catalog. */
  recent(agentId?: string): string[] {
    const since = this.s.clock.now() - RECENT_WINDOW_MS;
    const rows = this.s.db.all<{ model: string }>(
      `SELECT model, COUNT(*) AS uses, MAX(started_at) AS last FROM runs
       WHERE status = 'done' AND model IS NOT NULL AND started_at >= ? ${agentId ? 'AND agent_id = ?' : ''}
       GROUP BY model ORDER BY uses DESC, last DESC LIMIT 50`,
      agentId ? [since, agentId] : [since],
    );
    const known = this.load().byId;
    return rows.map((row) => row.model).filter((id) => known.has(id)).slice(0, RECENT_LIMIT);
  }

  /** Sizes and the last full refresh. */
  status(): CatalogStatus {
    const { list } = this.load();
    return { models: list.length, available: list.filter((model) => model.available).length, refreshedAt: this.kv().get<number>(NS, 'refreshed_at') };
  }

  // ---------------------------------------------------------------- refresh

  /** Re-lists every listable account (unforced: at most every 10 min) and rebuilds. */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.inflight && this.inflightFull) return this.inflight; // coalesce with the running full refresh
    if (!options.force) {
      const last = this.kv().get<number>(NS, 'refreshed_at') ?? 0;
      if (this.s.clock.now() - last < REFRESH_INTERVAL_MS) return this.inflight ?? Promise.resolve();
    }
    this.pendingFull = true;
    return this.drain();
  }

  /** Runs debounced event work now and resolves when nothing is pending or running (tests, shutdown). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.takeDebounced();
    }
    return this.drain();
  }

  private drain(): Promise<void> {
    if (!this.inflight && !this.pendingFull && !this.pendingAccounts.size && !this.pendingRebuild) return Promise.resolve();
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          while (this.pendingFull || this.pendingAccounts.size || this.pendingRebuild) {
            const full = this.pendingFull;
            const ids = [...this.pendingAccounts];
            this.pendingFull = false;
            this.pendingAccounts.clear();
            this.pendingRebuild = false;
            // A full run reads the account list now, so account events debounced so far are covered
            // (first start: detection adds accounts and the initial refresh follows – list them once).
            if (full) this.debounced = { accounts: new Set(), rebuild: false };
            this.inflightFull = full;
            try { await this.run(full, ids); } catch (error) { this.s.log.warn('catalog refresh failed', { error: String(error) }); }
          }
        } finally {
          this.inflight = undefined;
          this.inflightFull = false;
        }
      })();
    }
    return this.inflight;
  }

  private async run(full: boolean, ids: string[]): Promise<void> {
    const s = this.s;
    const accounts = s.accounts.list();
    const listings = this.loadListings();
    const byId = new Map(accounts.map((account) => [account.id, account]));
    for (const id of [...listings.keys()]) if (!byId.has(id)) this.dropListing(id);
    const targets = (full ? accounts : ids.map((id) => byId.get(id)).filter((account): account is Account => Boolean(account))).filter(isListable);

    // HTTP/local lists in parallel; CLI engines one at a time (each may start a process).
    const cli = targets.filter(isCli);
    const http = targets.filter((account) => !isCli(account));
    await Promise.all(http.map((account) => this.listAccount(account)));
    for (const account of cli) await this.listAccount(account);

    this.rebuild();
    if (full) this.kv().set(NS, 'refreshed_at', s.clock.now(), s.clock.now());
    if (full) this.refreshPrices();
  }

  /** The stored keyless list prices (read once; refreshPrices replaces them). */
  private prices(): FeedPrices {
    if (!this.feed) {
      try { this.feed = storedFeed(this.s.db); } catch { this.feed = new Map(); }
    }
    return this.feed;
  }

  /** B-078: a started catalog asks for the daily price list in the background; new prices rebuild the catalog. */
  private refreshPrices(): void {
    if (this.deps.priceFeed === false || !this.unsubscribe.length || this.feeding) return;
    this.feeding = true;
    const s = this.s;
    void refreshFeed({ db: s.db, clock: s.clock, log: s.log, ...(this.deps.priceFeed ? { fetch: this.deps.priceFeed } : {}) })
      .then((changed) => {
        if (!changed || !this.unsubscribe.length) return;
        this.feed = storedFeed(s.db);
        this.rebuild();
      })
      .catch((error: unknown) => s.log.warn('model list prices skipped', { error: String(error) }))
      .finally(() => { this.feeding = false; });
  }

  private async listAccount(account: Account): Promise<void> {
    const engineId = this.engineOf(account);
    if (!engineId) return;
    try {
      const engine = this.s.engines.get(engineId);
      const timeout = isCli(account) ? CLI_LIST_TIMEOUT_MS : HTTP_LIST_TIMEOUT_MS;
      const models = sanitizeListing(await withTimeout(engine.listModels(account), timeout, 'model list'), MAX_MODELS_PER_ACCOUNT);
      const listing: Listing = { models, at: this.s.clock.now() };
      this.loadListings().set(account.id, listing);
      this.kv().set(NS, `listing:${account.id}`, listing, listing.at);
      this.failedAt.delete(account.id);
    } catch (error) {
      // Keep the previous listing: a flaky engine must not make models vanish.
      this.failedAt.set(account.id, this.s.clock.now());
      this.s.log.warn('model list failed', { accountId: account.id, provider: account.provider, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private loadListings(): Map<string, Listing> {
    if (!this.listings) {
      const map = new Map<string, Listing>();
      for (const entry of this.kv().list<Listing>(NS)) {
        if (!entry.key.startsWith('listing:') || !entry.value || !Array.isArray(entry.value.models)) continue;
        map.set(entry.key.slice('listing:'.length), entry.value);
      }
      // Rows written before listings were persisted: recover them so a rebuild never drops models.
      for (const [accountId, listing] of listingsFromRows(this.load().list, this.s.clock.now())) if (!map.has(accountId)) map.set(accountId, listing);
      this.listings = map;
    }
    return this.listings;
  }

  /** Engine of an account; in demo/test mode (a 'fake' engine is registered) it serves the 'compatible' accounts. */
  private engineOf(account: Account): EngineId | undefined {
    const engine = engineFor(account.provider);
    if (engine !== 'compatible' || account.provider !== 'compatible') return engine;
    if (this.fakeMode === undefined) {
      try { this.fakeMode = this.s.engines.get('fake').id === 'fake'; } catch { this.fakeMode = false; }
    }
    return this.fakeMode ? 'fake' : engine;
  }

  private dropListing(accountId: string): void {
    this.loadListings().delete(accountId);
    this.kv().delete(NS, `listing:${accountId}`);
  }

  /** Listings + accounts + priors -> `models` table (no network). Emits models.updated on change. */
  rebuild(): void {
    const s = this.s;
    const accounts = new Map(s.accounts.list().map((account) => [account.id, account]));
    const now = s.clock.now();
    const next = new Map<string, ModelInfo>();
    const named = this.named();
    for (const [accountId, listing] of withNamedModels(rebuildListings(this.loadListings(), accounts.values(), now), accounts.values(), named, now)) {
      const account = accounts.get(accountId);
      const engine = account ? this.engineOf(account) ?? mediaEngineOf(account.provider) : undefined;
      if (!account || !engine) continue;
      const owner = modelOwner(account, named.providers);
      for (const listed of listing.models) {
        const id = `${owner}:${listed.model}`;
        let info = next.get(id);
        if (!info) {
          info = buildModel({ provider: account.provider, engine, listed, priors: this.deps.priors, owner, feed: this.prices() });
          next.set(id, info);
        }
        if (!info.accounts.includes(account.id)) info.accounts.push(account.id);
        if (isConnected(account)) info.available = true;
      }
    }
    const before = this.load().list;
    const list = [...next.values()].sort(byProviderName);
    if (JSON.stringify(before) === JSON.stringify(list)) return;
    s.db.tx(() => {
      const keep = new Set(list.map((info) => info.id));
      for (const old of before) if (!keep.has(old.id)) s.db.run('DELETE FROM models WHERE id = ?', [old.id]);
      for (const info of list) s.db.run(UPSERT, toRowParams(info, now));
    });
    this.cache = { list, byId: indexOf(list) };
    s.bus.emit('models.updated', this.list());
  }

  // ---------------------------------------------------------------- events

  /** Subscribes to account changes (debounced); no timers run while nothing changes. */
  start(): void {
    if (this.unsubscribe.length) return;
    const s = this.s;
    for (const account of s.accounts.list()) this.seen.set(account.id, this.snapshot(account));
    let said = JSON.stringify([this.named().providers, this.named().routing]);
    this.unsubscribe.push(
      s.bus.on('account.upserted', (account) => this.onAccount(account)),
      s.bus.on('account.removed', ({ id }) => { this.seen.delete(id); this.failedAt.delete(id); this.dropListing(id); this.schedule({ rebuild: true }); }),
      s.bus.on('settings.updated', () => { // a model settings.json names is in the catalog at once
        const now = JSON.stringify([this.named().providers, this.named().routing]);
        if (now !== said) { said = now; this.schedule({ rebuild: true }); }
      }),
    );
    // A connection the file added while the app was closed: listed and in the catalog without waiting for the next refresh.
    const fresh = s.accounts.list().filter((account) => this.named().providers?.[account.id]);
    if (fresh.length) this.schedule({ accounts: fresh.filter((account) => isListable(account) && !this.loadListings().has(account.id)).map((account) => account.id), rebuild: true });
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.debounced = { accounts: new Set(), rebuild: false };
  }

  private snapshot(account: Account) {
    return { print: fingerprint(account), connected: isConnected(account), listable: isListable(account), enabled: account.enabled };
  }

  private onAccount(account: Account): void {
    const now = this.snapshot(account);
    const was = this.seen.get(account.id);
    this.seen.set(account.id, now);
    // An account without a listing is retried on its events, but not again within 10 min of a failure.
    const retryMissing = !this.loadListings().has(account.id)
      && this.s.clock.now() - (this.failedAt.get(account.id) ?? Number.NEGATIVE_INFINITY) >= REFRESH_INTERVAL_MS;
    if (now.listable && (!was || retryMissing || was.print !== now.print || (!was.listable && !was.connected))) {
      this.schedule({ accounts: [account.id] }); // new, re-logged-in or re-pointed account → list it
    } else if (!was || was.connected !== now.connected || was.enabled !== now.enabled || was.print !== now.print) {
      this.schedule({ rebuild: true }); // availability changed
    } // limits/usage churn: nothing to do
  }

  private schedule(work: { accounts?: string[]; rebuild?: boolean }): void {
    if (!this.unsubscribe.length) return; // stopped: no timer
    for (const id of work.accounts ?? []) this.debounced.accounts.add(id);
    if (work.rebuild) this.debounced.rebuild = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.takeDebounced();
      void this.drain();
    }, this.deps.debounceMs ?? 1500);
    this.timer.unref?.();
  }

  private takeDebounced(): void {
    const { accounts, rebuild } = this.debounced;
    this.debounced = { accounts: new Set(), rebuild: false };
    for (const id of accounts) this.pendingAccounts.add(id);
    if (rebuild) this.pendingRebuild = true;
  }
}
