// Cleanup of superseded native sessions (B-048 E2): a session the app created and no row binds any more
// (agents/sessions.ts records it) is deleted at the provider once the agent finished a turn in that chat after
// it was superseded AND 24 h passed – Codex through thread/delete, Claude Code its transcripts (the one the app
// wrote, and the CLI's own transcript of that session id). Engines without deleteSession keep theirs (the record goes).
// Runs on start and whenever a new session binds (no polling); one sweep at a time; a ref bound again, a running
// turn of the agent, an account that is off or signed out, or a linked PC's account waits; after 3 failed
// attempts the record is dropped (the provider's own retention applies).
// Orphans (B-048 review, privacy): a rebuilt transcript the app wrote into its own data folder that no row binds and no
// record waits for (a Forget, a 'Delete histories' purge or a deleted chat drops rows by SQL, past the record) is
// deleted in the same sweep once it is an hour old (a rebuild binds its file at once; a probe deletes its own).
// Owns: the sweep and its order. Never: deletes a session the app did not record, or one still bound, or a file
// outside the app's transcripts folder.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Clock, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Engine } from '../engines/types.ts';
import type { Account, EngineId } from '../../shared/model/providers.ts';
import { KvRepo } from '../store/kv.ts';
import { SUPERSEDED_NS, onSessionBound, type SupersededSession } from './sessions.ts';
import { isSplitThread } from '../../shared/model/splits.ts'; // B-057

/** A superseded session is kept this long after it was superseded (the native restore path). */
export const KEEP_SUPERSEDED_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
/** Records looked at per sweep (oldest first). */
const BATCH = 200;
/** An unreferenced transcript of the app is deleted once its last write is this old. */
export const ORPHAN_AGE_MS = 60 * 60 * 1000;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** The transcripts the app wrote (engines/claude/rebuild.ts): absolute paths with their last write. */
export interface TranscriptFiles {
  list(): Promise<Array<{ file: string; at: number }>>;
  remove(file: string): Promise<void>;
}

/** The app's transcripts folder on disk: only `<session id>.jsonl` files directly inside it. */
export function transcriptFiles(dir: string): TranscriptFiles {
  return {
    list: async () => {
      const names = await fsp.readdir(dir).catch(() => [] as string[]);
      const out: Array<{ file: string; at: number }> = [];
      for (const name of names.filter((entry) => SESSION_FILE.test(entry)).slice(0, 2000)) {
        const file = path.join(dir, name);
        const stat = await fsp.stat(file).catch(() => undefined);
        if (stat?.isFile()) out.push({ file, at: stat.mtimeMs });
      }
      return out;
    },
    remove: (file) => fsp.rm(file, { force: true }),
  };
}

export interface SessionSweepDeps {
  db: Db;
  clock: Clock;
  log?: Logger;
  engine: (id: EngineId) => Engine | undefined;
  accounts: () => Account[];
  /** B-048 review: the app's own rebuilt transcripts, for orphans whose rows went by SQL. */
  transcripts?: TranscriptFiles;
}

export class SessionSweep {
  private readonly d: SessionSweepDeps;
  private running: Promise<void> | undefined;
  private again = false;
  private off: (() => void) | undefined;

  constructor(deps: SessionSweepDeps) {
    this.d = deps;
  }

  /** Sweeps now and after every new binding; returns the stop. */
  start(): () => void {
    this.off ??= onSessionBound(this.d.db, () => { void this.sweep(); });
    void this.sweep();
    return () => this.stop();
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  /** One sweep (a call during a sweep runs one more after it). */
  sweep(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.work().catch((error) => this.d.log?.warn('superseded session cleanup failed', { error: String(error) })).finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; void this.sweep(); }
    });
    return this.running;
  }

  private async work(): Promise<void> {
    await this.superseded();
    await this.orphans();
  }

  /** Transcripts of the app that no row binds and no superseded record names, an hour after their last write. */
  private async orphans(): Promise<void> {
    const files = this.d.transcripts;
    if (!files) return;
    const now = this.d.clock.now();
    const old = (await files.list().catch(() => [])).filter((entry) => now - entry.at >= ORPHAN_AGE_MS);
    if (!old.length) return;
    const kept = new Set([
      ...this.d.db.all<{ session_ref: string }>(`SELECT session_ref FROM engine_sessions WHERE session_ref LIKE '%.jsonl'`).map((row) => row.session_ref),
      ...new KvRepo(this.d.db).list<SupersededSession>(SUPERSEDED_NS).map((entry) => entry.value?.ref).filter((ref): ref is string => typeof ref === 'string'),
    ].map((ref) => path.resolve(ref)));
    for (const entry of old.slice(0, BATCH)) {
      if (kept.has(path.resolve(entry.file))) continue;
      try {
        await files.remove(entry.file);
        this.d.log?.info('orphaned engine transcript deleted');
      } catch (error) {
        this.d.log?.warn('deleting an orphaned engine transcript failed', { error: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
      }
    }
  }

  private async superseded(): Promise<void> {
    const kv = new KvRepo(this.d.db);
    const now = this.d.clock.now();
    const due = kv.list<SupersededSession>(SUPERSEDED_NS)
      .filter((entry) => entry.value && typeof entry.value.ref === 'string' && now - Number(entry.value.at) >= KEEP_SUPERSEDED_MS)
      .sort((a, b) => Number(a.value.at) - Number(b.value.at)).slice(0, BATCH);
    if (!due.length) return;
    let accounts: Account[] = [];
    try { accounts = this.d.accounts(); } catch { return; }
    for (const { key, value } of due) {
      if (this.bound(value.ref)) { kv.delete(SUPERSEDED_NS, key); continue; } // in use again: not superseded
      if (!this.successorFinished(value)) continue;
      if (this.d.db.get(`SELECT 1 AS ok FROM runs WHERE agent_id = ? AND status = 'running' LIMIT 1`, [value.agentId])) continue;
      const engine = this.d.engine(value.engine);
      if (!engine?.deleteSession) { kv.delete(SUPERSEDED_NS, key); continue; }
      const account = value.accountId ? accounts.find((candidate) => candidate.id === value.accountId) : undefined;
      if (!account) { if (accounts.length) kv.delete(SUPERSEDED_NS, key); continue; } // gone with its home (no accounts listed yet: wait)
      if (account.deviceId || !account.enabled || account.state === 'needs_login') continue; // waits for the account
      try {
        const outcome = await engine.deleteSession(account, value.ref);
        kv.delete(SUPERSEDED_NS, key);
        this.d.log?.info('superseded session deleted', { engine: value.engine, outcome });
      } catch (error) {
        const attempts = (value.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) kv.delete(SUPERSEDED_NS, key);
        else kv.set(SUPERSEDED_NS, key, { ...value, attempts }, now);
        this.d.log?.warn('deleting a superseded session failed', { engine: value.engine, attempts, error: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
      }
    }
  }

  private bound(ref: string): boolean {
    return this.d.db.get('SELECT 1 AS ok FROM engine_sessions WHERE session_ref = ? LIMIT 1', [ref]) !== undefined;
  }

  /** The agent finished a turn in that chat after the session was superseded (its successor holds the work now). */
  private successorFinished(value: SupersededSession): boolean {
    if (isSplitThread(value.conversationId ?? '')) return true; // B-057: a split's thread – its short-lived split is over long before KEEP_SUPERSEDED_MS
    const chat = value.conversationId || null;
    return this.d.db.get(
      `SELECT 1 AS ok FROM runs WHERE agent_id = ? AND conversation_id IS ? AND status = 'done' AND ended_at >= ? LIMIT 1`,
      [value.agentId, chat, Number(value.at)],
    ) !== undefined;
  }
}
