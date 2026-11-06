// Retention: how long derived data is kept, applied in bounded passes.
//  - traceDays: tool traces (run_items) of runs that ended longer ago are deleted; a run's summary, cost and
//    status stay, and so does every item whose external effect is still pending or unknown;
//  - historyDays: corrected or expired knowledge versions (not the person's references) expired longer ago are
//    deleted with their FTS rows (KnowledgeStore.purgeVersions); the current version stays.
// A pass runs after the settings change (B-044: lifecycle.retention is a key without UI) and at most
// once a day on a finished run (event-driven – no timer; an idle PC has nothing new to expire).
// Owns: the passes and the last-pass mark (kv 'privacy'/'purged'). Never: deletes chat messages,
// current knowledge, open effects or anything when both settings are 0.

import type { Db } from '../db/database.ts';
import type { Logger } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import type { RetentionResult, RetentionSettings } from '../../shared/model/lifecycle.ts';
import { DAY_MS } from '../knowledge/age.ts';

const NS = 'privacy';
const PURGED_KEY = 'purged';
/** Rows per pass (a long-kept database catches up over a few passes instead of one long stall). */
const RUN_BATCH = 2000;
const VERSION_BATCH = 2000;

export interface RetentionDeps {
  db: Db;
  log?: Logger;
  /** Deletes expired knowledge versions with their FTS rows (KnowledgeStore.purgeVersions); the removed ids. */
  purgeVersions?: (ids: readonly string[]) => string[];
}

export function lastPurge(db: Db): number | undefined {
  const at = new KvRepo(db).get<number>(NS, PURGED_KEY);
  return typeof at === 'number' ? at : undefined;
}

/** One retention pass; `now` from the caller's clock. */
export function applyRetention(deps: RetentionDeps, settings: RetentionSettings, now: number): RetentionResult {
  const { db } = deps;
  let traces = 0;
  let versions = 0;
  if (settings.traceDays > 0) {
    const cutoff = now - settings.traceDays * DAY_MS;
    const runs = db.all<{ id: string }>(
      `SELECT r.id FROM runs r WHERE r.ended_at IS NOT NULL AND r.ended_at < ? AND r.status NOT IN ('running', 'queued')
          AND EXISTS (SELECT 1 FROM run_items i WHERE i.run_id = r.id AND coalesce(i.effect_status, 'none') NOT IN ('pending', 'unknown'))
        ORDER BY r.ended_at LIMIT ?`, [cutoff, RUN_BATCH]).map((row) => row.id);
    for (let start = 0; start < runs.length; start += 200) {
      const chunk = runs.slice(start, start + 200);
      traces += db.run(`DELETE FROM run_items WHERE run_id IN (${chunk.map(() => '?').join(', ')}) AND coalesce(effect_status, 'none') NOT IN ('pending', 'unknown')`, chunk).changes;
    }
  }
  if (settings.historyDays > 0) {
    const cutoff = now - settings.historyDays * DAY_MS;
    const ids = db.all<{ id: string }>(
      `SELECT id FROM knowledge WHERE expired_at IS NOT NULL AND expired_at < ? AND scope != 'reference' ORDER BY expired_at LIMIT ?`, [cutoff, VERSION_BATCH]).map((row) => row.id);
    if (ids.length && deps.purgeVersions) versions = deps.purgeVersions(ids).length;
  }
  new KvRepo(db).set(NS, PURGED_KEY, now, now);
  if (traces || versions) deps.log?.info('retention pass', { traces, versions });
  return { traces, episodes: 0, versions, at: now };
}

/** True when a daily pass is due (something to apply and the last pass is a day old). */
export function passDue(db: Db, settings: RetentionSettings, now: number): boolean {
  if (!(settings.traceDays > 0 || settings.historyDays > 0)) return false;
  const last = lastPurge(db);
  return last === undefined || now - last >= DAY_MS || last > now;
}
