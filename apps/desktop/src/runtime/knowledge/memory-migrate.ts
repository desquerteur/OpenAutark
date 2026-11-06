// One-time move of the old knowledge rows into the memory tree: every current row except the runtime's chat observations
// becomes a file; its older versions stay rows linked to the file (retention removes them); the row goes once its file
// is written, so an interrupted move simply goes on at the next start, and an old `kn_…` id still finds its file (one meta row per
// id, written with the row's removal: a crash in the middle loses none).
// The rows are empty afterwards, so this costs one query at every start. The files are embedded by the store's start.
// Owns: this move and the old-id map. Never: touches observations or embeds.

import type { Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { noteBlobs } from './memory-blobs.ts';
import { ITEM_COLUMNS, toItem, type KnowledgeRow } from './rows.ts';
import { PINNED_DIR, entryOfItem, folderOfScope, memoryId, type MemoryTree } from './memory-tree.ts';

const ALIAS = 'memory.old-id.';

/** The memory file an old `kn_…` id moved to. */
export function movedTo(db: Db, id: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [`${ALIAS}${id}`])?.value;
}

/** Moves the rows; how many moved. */
export function migrateRows(db: Db, tree: MemoryTree, log?: Logger): number {
  const rows = db.all<KnowledgeRow>(`SELECT ${ITEM_COLUMNS} FROM knowledge WHERE expired_at IS NULL AND kind <> 'observation'`);
  if (!rows.length) return 0;
  let moved = 0;
  for (const row of rows) {
    try {
      const item = toItem(row);
      const place = folderOfScope(item.scope, item.scopeId);
      const rel = tree.slot(item.pinned ? `${place}/${PINNED_DIR}` : place, item.title, { text: item.body });
      tree.write(rel, entryOfItem(item, item.recordedAt));
      const file = memoryId(rel);
      db.tx(() => {
        for (let older = row.supersedes; older;) {
          const next: { supersedes: string | null } | undefined = db.get('SELECT supersedes FROM knowledge WHERE id = ?', [older]);
          db.run('UPDATE knowledge SET supersedes = ? WHERE id = ?', [file, older]);
          older = next?.supersedes ?? null;
        }
        db.run('DELETE FROM knowledge_fts WHERE knowledge_id = ?', [row.id]);
        db.run('DELETE FROM knowledge WHERE id = ?', [row.id]);
        db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [`${ALIAS}${row.id}`, rel]);
        noteBlobs(db, rel, `${row.source} ${row.body}`, row.recorded_at);
      });
      moved++;
    } catch (error) {
      log?.warn('memory: a knowledge row was not moved to a file', { id: row.id, error: String(error) });
    }
  }
  log?.info('memory: knowledge rows moved to files', { moved, of: rows.length });
  return moved;
}
