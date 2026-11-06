// Releasing the native sessions of splits (B-057 S2): a split's session is bound under its own thread `split:<id>`
// (agents/sessions.ts engine_sessions rows of the parent agent). Once the split ended for good (runner.ts – done, failed
// after its last attempt, stopped) or its group is gathered or stopped, nothing resumes it (its result is read from the
// run journal): its rows are removed through SessionStore.remove, which records each ref as superseded, and the session sweep
// (agents/session-sweep.ts – a split's thread needs no successor turn) deletes the Codex thread or Claude transcript at
// the provider later, like any session the app replaced. Each removed binding is also handed to `released`, so its
// engine can unload it from a shared process right away (a Codex app-server keeps every forked thread in memory until
// thread/unsubscribe – SplitCore.release). A lane that ends after that saves its binding again, so the runner releases
// a split once more when its late end arrives; the boot recovery releases what a crash left behind.
// Owns: which split bindings go. Never: deletes a provider session itself, or touches a binding of another thread.

import type { Db } from '../db/database.ts';
import type { EngineId } from '../../shared/model/providers.ts';
import { splitThread, type Split } from '../../shared/model/splits.ts';
import { SessionStore } from '../agents/sessions.ts';

interface Row { agent_id: string; conversation_id: string; engine: string; account_id: string | null; session_ref: string }

/** A removed binding: the engine and account whose process may still hold it. */
export interface ReleasedSession { engine: EngineId; accountId?: string; ref: string }

const COLUMNS = 'e.agent_id, e.conversation_id, e.engine, e.account_id, e.session_ref';

function remove(db: Db, rows: readonly Row[], released?: (session: ReleasedSession) => void): number {
  const store = new SessionStore(db);
  for (const row of rows) {
    store.remove(row.agent_id, row.conversation_id, row.engine as EngineId);
    released?.({ engine: row.engine as EngineId, ...(row.account_id ? { accountId: row.account_id } : {}), ref: row.session_ref });
  }
  return rows.length;
}

/** Releases the session bindings of these splits (each split's own thread, every engine); how many went. */
export function releaseSessions(db: Db, splits: ReadonlyArray<Pick<Split, 'id' | 'agentId'>>, released?: (session: ReleasedSession) => void): number {
  let count = 0;
  for (const split of splits) {
    count += remove(db, db.all<Row>(`SELECT ${COLUMNS} FROM engine_sessions e WHERE e.agent_id = ? AND e.conversation_id = ?`,
      [split.agentId, splitThread(split.id)]), released);
  }
  return count;
}

/** Boot recovery: the bindings of splits that ended for good, whose group was gathered or stopped, or whose split is gone. */
export function releaseEnded(db: Db): number {
  return remove(db, db.all<Row>(
    `SELECT ${COLUMNS} FROM engine_sessions e
       LEFT JOIN splits s ON s.id = substr(e.conversation_id, 7) LEFT JOIN split_groups g ON g.id = s.group_id
      WHERE substr(e.conversation_id, 1, 6) = 'split:'
        AND (s.id IS NULL OR g.status IN ('gathered', 'stopped') OR s.status IN ('done', 'failed', 'stopped', 'skipped'))`));
}
