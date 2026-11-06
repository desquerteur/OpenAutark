// Blob clean-up (MM6): gives disk space back once nothing uses a stored file any more.
// Deleting a chat or a message (or replacing a chat picture) queues the files it held, and a
// transcribed dictation take queues itself, due after a hold (voice/transcribe.ts, `notBefore`);
// the queue lives in kv 'files.reclaim' (a quit or crash loses nothing). A batch starts with
// setImmediate and checks a few files per tick. A draft change queues nothing (the composer
// clears its draft right before messages.send – chat/service.ts). A queued file
//   - is skipped for now while it is young (stored less than 60 s ago – an upload that is about
//     to be sent, or the same bytes stored again) and retried when it turns 60 s old,
//   - waits (backing off from 1 to 30 min) while an agent works with it (files/references.ts
//     isBusy) or the store is writing it,
//   - stays when something uses it (references.ts) – a row linked to a deleted chat moves to
//     the chat that still uses it – or when it is a described/tagged library item of no chat,
//   - is removed otherwise (blob, files row, media row – Blobs.remove).
// One timer at most, armed only for the earliest due entry and cleared when the queue is
// empty; no polling. The bounded start-up reconcile re-queues entries that waited for a run of
// the previous process, queues media rows still linked to a deleted chat (chats deleted before
// MM6 or while the queue was lost) and removes temp parts crashed writes left behind.
// Owns: the queue, the batch, the timer and the reconcile. Never: decides what counts as a use
// (references.ts), deletes a file the person or an agent still uses, or touches workspace files.

import { opendir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Clock, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { json } from '../db/database.ts';
import { MediaRepo } from '../media/repo.ts';
import { FileRepo } from '../store/files.ts';
import { FILE_ID, RECLAIM_NS, firstUse, isBusy } from './references.ts';

/** A file younger than this is never reclaimed by the batch. */
export const GRACE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const PER_TICK = 8;
const PER_DRAIN = 400;
const MAX_ENQUEUE = 5000;
const ORPHANS_PER_START = 200;
const TEMP_PER_START = 200;
const TEMP_AGE_MS = 60 * 60_000;

/** What chats, the media library and dictation call on the blob store (Blobs implements it). */
export interface Reclaimer {
  /** Queues files a deletion or a transcribed dictation take may have freed, due now or at `notBefore`; the batch decides (see the header). */
  reclaim(fileIds: Iterable<string>, options?: { notBefore?: number }): void;
  /** Start-up: the bounded orphan reconcile, then a batch. */
  reconcileOrphans(): void;
  /** Removes one file now (blob + rows); false while it is being stored or the blob cannot go. */
  remove(fileId: string): Promise<boolean>;
}

/** The store's clean-up side, when it has one (test fakes of FileStore do not). */
export function reclaimerOf(files: unknown): Reclaimer | undefined {
  const value = files as Partial<Reclaimer> | null | undefined;
  return value && typeof value.reclaim === 'function' && typeof value.reconcileOrphans === 'function' && typeof value.remove === 'function'
    ? value as Reclaimer : undefined;
}

export interface CleanupTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: CleanupTimers = {
  setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CleanupDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  remove(fileId: string): Promise<boolean>;
  /** When put/putPath last stored these bytes in this process (same content stored again). */
  storedAt?(fileId: string): number | undefined;
  /** <data>/settings.json: a setting naming a file keeps it (absent: no settings file). */
  settingsFile?: string;
  /** Where interrupted writes leave `*.part` files (<blobs>/tmp). */
  tempDir?: string;
  graceMs?: number;
  timers?: CleanupTimers;
}

/** Test seam (end-to-end test): WORKFORCE_TEST_FILE_GRACE_MS shortens the grace, never extends it. */
export function graceFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKFORCE_TEST_FILE_GRACE_MS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 && value < GRACE_MS ? value : GRACE_MS;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export class BlobCleanup {
  private readonly deps: CleanupDeps;
  private readonly grace: number;
  private readonly timers: CleanupTimers;
  private running: Promise<void> | undefined;
  private sweeping: Promise<void> | undefined;
  private again = false;
  private timer: unknown;
  private timerDue: number | undefined;
  private disposed = false;

  constructor(deps: CleanupDeps) {
    this.deps = deps;
    this.grace = Math.max(0, deps.graceMs ?? GRACE_MS);
    this.timers = deps.timers ?? realTimers;
  }

  /** Queues files (deduplicated, at most 5000 per call), due now or at `notBefore`, and starts a batch. Returns how many. */
  enqueue(fileIds: Iterable<string>, notBefore?: number): number {
    const ids = [...new Set([...fileIds].filter((id) => FILE_ID.test(id)))].slice(0, MAX_ENQUEUE);
    if (!ids.length || this.disposed) return 0;
    const due = Math.max(this.deps.clock.now(), notBefore ?? 0);
    this.deps.db.tx(() => {
      for (const id of ids) {
        this.deps.db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, '{}', ?)
          ON CONFLICT(ns, key) DO UPDATE SET value = '{}', updated_at = excluded.updated_at`, [RECLAIM_NS, id, due]);
      }
    });
    this.schedule();
    return ids.length;
  }

  /** Start-up reconcile (bounded, see the header); never throws. */
  reconcile(): void {
    if (this.disposed) return;
    const { db, clock, log } = this.deps;
    try {
      const now = clock.now();
      db.run(`UPDATE kv SET updated_at = ? WHERE ns = ? AND updated_at > ? AND json_extract(value, '$.tries') > 0`, [now, RECLAIM_NS, now]);
      const orphans = new MediaRepo(db).orphanedLinks(ORPHANS_PER_START);
      db.tx(() => {
        for (const id of orphans) {
          db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, '{}', ?) ON CONFLICT(ns, key) DO NOTHING`, [RECLAIM_NS, id, now]);
        }
      });
      if (orphans.length) log.info('files of deleted chats queued for clean-up', { files: orphans.length });
    } catch (error) {
      log.warn('file clean-up reconcile failed', { error: String(error) });
    }
    if (!this.sweeping) this.sweeping = this.sweepTemp().finally(() => { this.sweeping = undefined; });
    this.schedule();
  }

  /** Number of queued files (tests, diagnostics). */
  queued(): number {
    return Number(this.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM kv WHERE ns = ?', [RECLAIM_NS])?.n ?? 0);
  }

  /** True while a retry timer is armed (tests: no timer may stay armed for an empty queue). */
  armed(): boolean {
    return this.timer !== undefined;
  }

  /** Resolves once the running batch and the temp sweep have finished. */
  async idle(): Promise<void> {
    while (this.running || this.sweeping) {
      await this.running;
      await this.sweeping;
    }
  }

  /** Stops: clears the timer; a running batch ends after its current file. */
  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  // ------------------------------------------------------------------ the batch

  private schedule(): void {
    if (this.disposed) return;
    if (this.running) { this.again = true; return; }
    this.running = this.drain()
      .catch((error) => this.deps.log.warn('file clean-up failed', { error: String(error) }))
      .finally(() => {
        this.running = undefined;
        if (this.again && !this.disposed) { this.again = false; this.schedule(); }
      });
  }

  private async drain(): Promise<void> {
    await tick(); // after the deleting call returned and its transaction committed
    this.again = false;
    const seen = new Set<string>();
    while (!this.disposed && seen.size < PER_DRAIN) {
      const due = this.deps.db.all<{ key: string }>(
        'SELECT key FROM kv WHERE ns = ? AND updated_at <= ? ORDER BY updated_at, key LIMIT ?', [RECLAIM_NS, this.deps.clock.now(), PER_TICK]);
      if (!due.length || due.some((row) => seen.has(row.key))) break; // an entry that could not be moved on: stop
      for (const { key } of due) {
        if (this.disposed) return;
        seen.add(key);
        try {
          await this.process(key);
        } catch (error) {
          this.deps.log.warn('file clean-up step failed', { id: key, error: String(error) });
          this.backoff(key);
        }
      }
      await tick();
    }
    if (seen.size >= PER_DRAIN) this.again = true;
    this.arm();
  }

  /** Decides one queued file (see the header); always forgets, postpones or backs it off. */
  private async process(id: string): Promise<void> {
    const { db, clock, log } = this.deps;
    const now = clock.now();
    const file = new FileRepo(db).get(id);
    if (!file) { // already removed (media.delete): only a blob a crash left behind may remain
      await this.deps.remove(id); // refused while the same bytes are stored again – that new file is not ours to judge
      this.forget(id);
      return;
    }
    const stored = Math.max(file.createdAt, this.deps.storedAt?.(id) ?? 0);
    if (stored + this.grace > now) { this.postpone(id, stored + this.grace); return; }
    const media = new MediaRepo(db);
    const row = media.get(id);
    if (row && !row.conversationId && (row.description || row.tags?.length)) { this.forget(id); return; } // kept in the library
    if (isBusy(db, id)) { this.backoff(id); return; }
    const use = firstUse(db, id, this.deps.settingsFile);
    if (use) {
      if (row?.conversationId && !db.get('SELECT 1 AS ok FROM conversations WHERE id = ?', [row.conversationId])) {
        media.relink(id, use.conversationId, now);
      }
      this.forget(id);
      return;
    }
    if (await this.deps.remove(id)) {
      log.debug('file reclaimed', { id, bytes: file.size });
      this.forget(id);
    } else {
      this.backoff(id);
    }
  }

  private forget(id: string): void {
    this.deps.db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [RECLAIM_NS, id]);
  }

  private postpone(id: string, due: number): void {
    this.deps.db.run('UPDATE kv SET updated_at = ? WHERE ns = ? AND key = ?', [due, RECLAIM_NS, id]);
  }

  /** Waits 1, 2, 4 … 30 min (base: the grace, at least 1 s) before the next try. */
  private backoff(id: string): void {
    const row = this.deps.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [RECLAIM_NS, id]);
    if (!row) return;
    const tries = Math.min(20, Math.max(0, Number(json<{ tries?: number }>(row.value, {}).tries) || 0) + 1);
    const delay = Math.min(BACKOFF_MAX_MS, Math.max(this.grace, 1000) * 2 ** (tries - 1));
    this.deps.db.run('UPDATE kv SET value = ?, updated_at = ? WHERE ns = ? AND key = ?',
      [JSON.stringify({ tries }), this.deps.clock.now() + delay, RECLAIM_NS, id]);
  }

  // ------------------------------------------------------------------ the timer

  /** One timer for the earliest due entry; none for an empty queue. */
  private arm(): void {
    if (this.disposed) return;
    const due = this.deps.db.get<{ due: number | null }>('SELECT MIN(updated_at) AS due FROM kv WHERE ns = ?', [RECLAIM_NS])?.due;
    if (due === null || due === undefined) { this.disarm(); return; }
    if (this.timer !== undefined && this.timerDue === due) return;
    this.disarm();
    const wait = due - this.deps.clock.now();
    // Due already but not handled (another drain follows, or an entry could not be moved on): retry later, not in a loop.
    const delay = Math.min(BACKOFF_MAX_MS, wait > 0 ? wait : Math.max(this.grace, 1000));
    this.timerDue = due;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.timerDue = undefined;
      this.schedule();
    }, delay);
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDue = undefined;
  }

  // ------------------------------------------------------------------ temp parts

  /** Removes `*.part` files older than an hour (interrupted writes), at most 200 entries per start. */
  private async sweepTemp(): Promise<void> {
    const dir = this.deps.tempDir;
    if (!dir) return;
    let removed = 0;
    try {
      const entries = await opendir(dir);
      let seen = 0;
      for await (const entry of entries) {
        if (this.disposed || ++seen > TEMP_PER_START) break;
        if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
        const file = path.join(dir, entry.name);
        const info = await stat(file).catch(() => undefined);
        if (info && this.deps.clock.now() - info.mtimeMs > TEMP_AGE_MS) { await rm(file, { force: true }); removed++; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log.debug('temp parts not swept', { error: String(error) });
    }
    if (removed) this.deps.log.info('removed parts of interrupted file writes', { files: removed });
  }
}
