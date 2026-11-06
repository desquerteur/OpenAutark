// The vector system (owner 01.11.2026): "ein System, mit dem generell alle mit Vektoren suchen können, für alles". A model
// embeds files or folders on purpose (embed) and they stay stored; a search embeds ONLY the query and compares it with
// what is already embedded under the given places, like grep over meaning. Nothing is ever scanned or embedded by itself,
// with two exceptions by design: the memory tree when its files change (onFileChanged; writing memory makes it findable)
// and, after somebody chose another embedding model in settings, the files embedded with the old one (kv: the choice and whether
// that work is open). A model that only stands in for a failed one answers queries it can and starts no background work: what
// changed waits for the chosen model, nothing is paid for twice when the local model fails and comes back. One embedding job at
// a time; a query does not wait for it. B-078: virtual entries (embedTexts, vectors/virtual.ts – the knowledge catalog, no
// files) and multi-hop search (hops, vectors/hops.ts); a virtual row of an old model goes, its owner embeds it again.
// Owns: the two public calls, the job queue, the background re-embedding. Never: what a model should embed or search.

import { stat } from 'node:fs/promises';
import type { Db } from '../db/database.ts';
import type { VectorEmbedResult, VectorHit, VectorSearchInput, VectorSearchResult, VectorText } from '../../shared/model/vectors.ts';
import type { VectorService } from '../contracts/vectors.ts';
import type { Embedder } from './embedders.ts';
import { emptyResult, runEmbed, type ReadFile } from './embed-job.ts';
import { isGone, MEMORY_PLACE, Places } from './places.ts';
import { VectorStore } from './store.ts';
import { hopSearch, MAX_HOPS } from './hops.ts';
import { CATALOG_PLACE, isVirtual, runEmbedTexts, type VirtualResult } from './virtual.ts';

/** A tool call's default budget: what does not fit is reported and the model calls again. */
export const EMBED_BUDGET_MS = 45_000;
const BACKGROUND_BUDGET_MS = 60_000;
/** How long a query waits for its embedding (first use: the model may still be downloading). */
const QUERY_WAIT_MS = 20_000;
const MTIME_BUDGET_MS = 400;
const MTIME_AGAIN_MS = 5_000;
const MTIME_PARALLEL = 32;
/** After a query that waited in vain: no second wait for this long (tools.find searches memory too). */
const QUERY_PAUSE_MS = 60_000;
const CHANGE_DELAY_MS = 1_500;
const START_DELAY_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const STALE_BATCH = 50;
const CHOICE_NS = 'vectors';
const CHOICE_KEY = 'choice';
/** Until a first choice is seen (a new profile, a profile of 0.2.9). */
const NO_CHOICE = { value: 'auto', redo: false };
const DEFAULT_K = 8;
export const MAX_K = 50;

const NO_EMBEDDER = 'No embedding model is available (Settings: Embeddings) – search with files.search instead.';

export interface VectorDeps {
  db: Db;
  memoryRoot: string;
  /** The embedding model now (settings, connections, what this PC can run); undefined = off. */
  embedder: () => Embedder | undefined;
  /** What settings say for embeddings; a change is what re-embeds the existing files. Default (tests): the embedder's id. */
  choice?: () => string;
  /** The embedder only stands in for a failed one (auto, this PC's model gave up). */
  standIn?: () => boolean;
  /** Removes secrets from a text that leaves this PC and from stored snippets. */
  redact?: (text: string) => string;
  readFile?: ReadFile;
  log?: { warn(message: string, details?: Record<string, unknown>): void };
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Delays of the background work (tests: 0). */
  changeDelayMs?: number;
  /** Ends what the embedder holds (the local model's worker) when the system stops. */
  release?: () => void;
  /** How long a query waits for its embedding (tests). */
  queryWaitMs?: number;
}

export class VectorSystem implements VectorService {
  readonly store: VectorStore;
  private readonly deps: VectorDeps;
  private readonly places: Places;
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  private jobs = 0;
  private readonly changed = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private draining?: Promise<void>;
  private stopped = false;
  /** What a search last saw of a file on disk. */
  private readonly seen = new Map<number, { at: number; mtime: number; size: number }>();
  private queryPauseUntil = 0;

  constructor(deps: VectorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.store = new VectorStore(deps.db, this.now);
    this.places = new Places(deps.memoryRoot, deps.platform);
  }

  available(): boolean {
    return Boolean(this.embedder());
  }

  /**
   * Files or folders, whole, stored from now on. What the budget does not reach is reported; the next call goes on.
   * `notYet` (the memory tree's own pass): a file embedded with another model stays as it is, and a stand-in does nothing.
   */
  embed(paths: string[], opts: { budgetMs?: number; notYet?: boolean } = {}): Promise<VectorEmbedResult & { failed?: boolean }> {
    const embedder = this.embedder();
    if (!embedder) {
      return Promise.resolve({ ...emptyResult(), skipped: paths.map((path) => ({ path, reason: NO_EMBEDDER })) });
    }
    if (opts.notYet && this.standingIn()) return Promise.resolve({ ...emptyResult(), failed: true });
    const budget = opts.budgetMs ?? EMBED_BUDGET_MS;
    return this.enqueue(() => runEmbed(paths, this.now() + budget, { store: this.store, places: this.places, embedder, now: this.now, keepOtherModel: opts.notYet, ...this.jobDeps() }));
  }

  /** B-078: virtual entries ("catalog/…" keys, no file), in the same one-at-a-time queue; a stand-in does nothing. */
  embedTexts(items: readonly VectorText[], opts: { budgetMs?: number } = {}): Promise<VirtualResult> {
    const embedder = this.embedder();
    if (!embedder || this.standingIn()) return Promise.resolve({ embedded: 0, unchanged: 0, remaining: items.length, failed: true });
    const budget = opts.budgetMs ?? EMBED_BUDGET_MS;
    return this.enqueue(() => runEmbedTexts(items, this.now() + budget, { store: this.store, embedder, now: this.now, keyOf: (stored) => this.places.keyOf(stored), ...(this.deps.redact ? { redact: this.deps.redact } : {}) }));
  }

  /** B-078: the virtual entries at or below `key` go. */
  forget(key: string): void {
    if (isVirtual(key)) this.store.removeUnder(this.places.keyOf(key));
  }

  /** B-078: the stored keys of the virtual entries below `key`. */
  virtualKeys(key: string = CATALOG_PLACE): string[] {
    return isVirtual(key) ? this.store.filesUnder(this.places.keyOf(key)).map((row) => row.path) : [];
  }

  /** Grep over meaning: only `query` is embedded; `in` filters what is already there. */
  async search(input: VectorSearchInput): Promise<VectorSearchResult> {
    const given = input.in.map((place) => place.trim()).filter(Boolean);
    const places = given.map((place) => ({ given: place, place: this.places.resolve(place) }));
    const searched = { places: given, embeddedFiles: 0 };
    const embedder = this.embedder();
    if (!embedder) return { hits: [], searched, note: NO_EMBEDDER };
    this.kick(embedder);
    const notes: string[] = [];
    const bad = places.filter((entry) => !entry.place).map((entry) => entry.given);
    if (bad.length) notes.push(`Not a place: ${bad.join(', ')} – use absolute paths or "memory/…".`);

    let rows = places.flatMap((entry) => (entry.place ? this.store.filesUnder(entry.place.key) : []));
    const changed = this.standingIn() ? 0 : await this.lookAt(rows.filter((row) => row.model === embedder.id && !isVirtual(row.path)));
    // Rule (a): no count of what is embedded reaches a context – the notes say what holds, not how many.
    if (changed) notes.push('Some of these files changed since they were embedded, so hits in them may be out of date.');
    const usable = new Map<number, string>();
    const empty: string[] = [];
    let elsewhere = 0; // files of another embedding model: no reason to think nothing is embedded there
    for (const entry of places) {
      if (!entry.place) continue;
      const under = this.store.filesUnder(entry.place.key);
      rows = under.filter((row) => row.model === embedder.id && row.done > 0);
      const others = under.filter((row) => row.model !== embedder.id).length;
      elsewhere += others;
      if (!rows.length && !others && !this.places.isMemory(entry.place)) empty.push(entry.given); // memory embeds itself: nothing there is nothing written yet
      for (const row of rows) usable.set(row.id, row.path);
    }
    if (empty.length) notes.push(`Nothing embedded under ${empty.join(', ')}.`);
    if (elsewhere) {
      notes.push(this.redoDue()
        ? 'Files here are being re-embedded for a new embedding model and cannot be found until then.'
        : 'Files here were embedded with another embedding model and cannot be compared with this one.');
    }
    searched.embeddedFiles = usable.size;
    if (!usable.size) return { hits: [], searched, ...(notes.length ? { note: notes.join(' ') } : {}) };

    let vector: Float32Array | undefined;
    try {
      const query = embedder.remote && this.deps.redact ? this.deps.redact(input.query) : input.query;
      if (this.now() >= this.queryPauseUntil) {
        vector = (await this.limited(embedder.embed([query], 'query'), this.deps.queryWaitMs ?? QUERY_WAIT_MS))?.[0];
        if (!vector) this.queryPauseUntil = this.now() + QUERY_PAUSE_MS;
      }
    } catch (error) {
      return { hits: [], searched, note: [...notes, `The query could not be embedded: ${(error as Error).message} Use files.search instead.`].join(' ') };
    }
    if (!vector) return { hits: [], searched, note: [...notes, 'The embedding model is still loading or downloading – try again in a minute, or use files.search now.'].join(' ') };
    const ids = new Set(usable.keys());
    const k = Math.max(1, Math.min(Math.trunc(input.k ?? DEFAULT_K), MAX_K));
    const hops = Math.max(0, Math.min(Math.trunc(input.hops ?? 0), MAX_HOPS));
    const top = hops
      ? await hopSearch(vector, k, hops, { top: (queries, count) => this.store.topMany(queries, ids, count), vectorOf: (fileId, chunk) => this.store.vectorOf(fileId, chunk) })
      : await this.store.top(vector, ids, k);
    const hits: VectorHit[] = top.flatMap((hit) => {
      const chunk = this.store.chunk(hit.fileId, hit.chunk);
      const from = (hit as { via?: { fileId: number } }).via;
      const via = from ? usable.get(from.fileId) : undefined;
      return chunk ? [{ path: usable.get(hit.fileId) as string, chunk: hit.chunk, ...chunk, score: Math.round(hit.score * 1000) / 1000, ...(via ? { via } : {}) }] : [];
    });
    return { hits, searched, ...(notes.length ? { note: notes.join(' ') } : {}) };
  }

  /** A memory file was written or changed ("memory/…", relative to the memory folder, or absolute). */
  onFileChanged(path: string): void {
    this.changed.add(this.memoryPath(path));
    this.schedule(this.deps.changeDelayMs ?? CHANGE_DELAY_MS);
  }

  onFileRemoved(path: string): void {
    const given = this.memoryPath(path);
    this.changed.delete(given);
    const place = this.places.resolve(given);
    if (place) this.store.removeUnder(place.key);
  }

  /** At the start: a model change while the app was off (the memory store reports what changed in its tree itself). */
  start(): void {
    this.schedule(this.deps.changeDelayMs ?? START_DELAY_MS);
  }

  /** A settings change may have changed the embedding model. */
  settingsChanged(): void {
    const embedder = this.embedder();
    if (embedder) this.kick(embedder);
  }

  stop(): void {
    this.stopped = true;
    try { this.deps.release?.(); } catch { /* it ends with the process anyway */ }
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = undefined;
    this.retry = undefined;
  }

  /** The background work is done or waits for a failed model (tests). */
  async settled(): Promise<void> {
    while (this.timer || this.draining) {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; void this.drain(); }
      await this.draining;
    }
  }

  private embedder(): Embedder | undefined {
    try { return this.deps.embedder(); } catch { return undefined; }
  }

  private standingIn(): boolean {
    try { return this.deps.standIn?.() === true; } catch { return false; }
  }

  /** Files of another model are to be re-embedded: somebody chose another model in settings, and that work is not finished (and no stand-in serves). */
  private redoDue(): boolean {
    let value: string | undefined;
    try { value = this.deps.choice ? this.deps.choice() : this.embedder()?.id; } catch { return false; }
    if (value === undefined) return false;
    const held = this.deps.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [CHOICE_NS, CHOICE_KEY]);
    const seen = held ? JSON.parse(held.value) as typeof NO_CHOICE : NO_CHOICE;
    if (seen.value === value) return seen.redo && !this.standingIn();
    this.noteChoice(value, true);
    return !this.standingIn();
  }

  private noteChoice(value: string, redo: boolean): void {
    this.deps.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [CHOICE_NS, CHOICE_KEY, JSON.stringify({ value, redo }), this.now()]);
  }

  /** The re-embedding found nothing more to do. */
  private redoDone(): void {
    const value = this.deps.choice ? this.deps.choice() : this.embedder()?.id;
    if (value !== undefined) this.noteChoice(value, false);
  }

  private jobDeps() {
    return { ...(this.deps.redact ? { redact: this.deps.redact } : {}), ...(this.deps.readFile ? { readFile: this.deps.readFile } : {}) };
  }

  private memoryPath(given: string): string {
    if (given === MEMORY_PLACE || /^memory[\\/]/.test(given) || /^([a-zA-Z]:[\\/]|[\\/])/.test(given)) return given;
    return `${MEMORY_PLACE}/${given.replaceAll('\\', '/')}`;
  }

  /** One job at a time: the model's call and the background take turns. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.jobs++;
    const run = this.tail.then(job, job).finally(() => { this.jobs--; });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private limited<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); (timer as { unref?: () => void }).unref?.(); });
    work.catch(() => undefined); // a late failure is nobody's error any more
    return Promise.race([work, late]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * The cheap check before a search, no model in it: files that are gone leave, a changed memory file goes to the background (the
   * one thing that embeds itself), any other changed file is only counted – it waits for a vector.embed. Bounded by time; a file is
   * looked at again after MTIME_AGAIN_MS. Returns how many changed files are not embedded again by themselves.
   */
  private async lookAt(rows: Array<{ id: number; key: string; path: string; mtime: number; size: number }>): Promise<number> {
    const now = this.now();
    const deadline = now + MTIME_BUDGET_MS;
    const due = rows.filter((row) => now - (this.seen.get(row.id)?.at ?? 0) >= MTIME_AGAIN_MS);
    for (let at = 0; at < due.length && this.now() <= deadline; at += MTIME_PARALLEL) {
      await Promise.all(due.slice(at, at + MTIME_PARALLEL).map(async (row) => {
        this.seen.set(row.id, { at: now, mtime: row.mtime, size: row.size });
        const file = this.places.absoluteOf(row.path);
        const info = await stat(file).catch(() => undefined);
        if (!info) { if (await isGone(file)) this.store.remove(row.key); return; }
        if (!info.isFile()) { this.store.remove(row.key); return; } // it became a folder: a search never walks one
        this.seen.set(row.id, { at: now, mtime: Math.trunc(info.mtimeMs), size: info.size });
      }));
    }
    const changed = rows.filter((row) => { const seen = this.seen.get(row.id); return seen && (seen.mtime !== row.mtime || seen.size !== row.size); });
    const memory = changed.filter((row) => row.path.startsWith(`${MEMORY_PLACE}/`));
    if (memory.length) {
      for (const row of memory) this.changed.add(row.path);
      this.schedule(0);
    }
    return changed.length - memory.length;
  }

  /** Another model was chosen and vectors of an old one exist: they are redone in the background, file by file. */
  private kick(embedder: Embedder): void {
    if (this.redoDue() && this.store.staleFiles(embedder.id, 1).length) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Works off the changed memory files and, after a choice in settings, the stale files until nothing is left or the model fails. A stand-in waits. */
  private drain(): Promise<void> {
    this.draining ??= this.drainNow().catch((error: unknown) => {
      this.deps.log?.warn('background embedding failed', { error: String(error) });
    }).finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private async drainNow(): Promise<void> {
    while (!this.stopped) {
      const embedder = this.embedder();
      if (!embedder) return; // a model comes back with a change, a search or the next start
      if (this.standingIn()) { this.later(); return; }
      const changed = [...this.changed];
      this.changed.clear(); // what changes while this job runs comes back in here
      const redo = this.redoDue();
      const staleRows = redo ? this.store.staleFiles(embedder.id, STALE_BATCH) : [];
      for (const row of staleRows) if (isVirtual(row.path)) this.store.remove(row.key); // a catalog entry: its owner embeds it again (knowledge/catalog.ts)
      const stale = staleRows.filter((row) => !isVirtual(row.path)).map((row) => row.path);
      if (redo && !staleRows.length) this.redoDone(); // a batch of only catalog rows is not the end: memory files of the old model can follow
      const work = [...changed, ...stale];
      if (!work.length) { if (staleRows.length) continue; return; }
      const result = await this.embed(work, { budgetMs: BACKGROUND_BUDGET_MS });
      if (result.remaining) for (const item of changed) this.changed.add(item);
      const stuck = stale.length > 0 && this.store.staleFiles(embedder.id, STALE_BATCH).map((row) => row.path).join('\n') === stale.join('\n'); // locked files, a drive that is away
      if (result.failed || stuck) { this.later(); return; } // the model is not reachable or still downloading
    }
  }

  private later(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = undefined; void this.drain(); }, RETRY_MS);
    (this.retry as { unref?: () => void }).unref?.();
  }
}
