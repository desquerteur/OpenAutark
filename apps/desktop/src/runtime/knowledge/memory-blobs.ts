// Which stored files (blobs) the memory tree names, for the blob clean-up (files/references.ts): one kv row per memory file that
// holds a file id (a sha256), kept current by every write, removal and watcher report and by one pass over what changed while the
// app was closed. A question must not read the tree: at 100,000 files that would stop the app every time a file is cleaned up.
// Owns: that row, finding the ids in a text and the pass. Never: deletes a blob or changes a memory file.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/database.ts';

/** The kv namespace (files/references.ts reads it as a use of kind 'knowledge'). */
export const MEMORY_BLOBS_NS = 'memory.blobs';
const SCANNED_KEY = 'memory.blobs-scanned';
const BLOB_ID = /\b[a-f0-9]{64}\b/g;
const SMALL_FILE_BYTES = 4 * 1024 * 1024;

/** Records which blobs the file `rel` names now (`text` undefined: the file is gone). */
export function noteBlobs(db: Db, rel: string, text: string | undefined, now: number): void {
  const ids = text ? [...new Set(text.match(BLOB_ID) ?? [])] : [];
  if (!ids.length) { db.run('DELETE FROM kv WHERE ns = ? AND key = ?', [MEMORY_BLOBS_NS, rel]); return; }
  db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [MEMORY_BLOBS_NS, rel, ids.join(' '), now]);
}

/** A memory folder's rows go with it (a removed topic folder). */
export function forgetBlobsBelow(db: Db, rel: string): void {
  db.run('DELETE FROM kv WHERE ns = ? AND (key = ? OR (key >= ? AND key < ?))', [MEMORY_BLOBS_NS, rel, `${rel}/`, `${rel}0`]);
}

/** Every file below `root`, relative with forward slashes; hidden entries left out. The event loop stays free. */
export async function* treeFiles(root: string, folder = ''): AsyncGenerator<string> {
  const entries = await readdir(path.join(root, ...folder.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* treeFiles(root, rel);
    else if (entry.isFile()) yield rel;
  }
}

/** The files changed since the last pass (the first pass: all of them) get their row. Never throws. */
export async function scanChanged(db: Db, root: string, now: number): Promise<void> {
  try {
    const since = Number(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [SCANNED_KEY])?.value ?? 0);
    for (const { key } of db.all<{ key: string }>('SELECT key FROM kv WHERE ns = ?', [MEMORY_BLOBS_NS])) {
      if (!(await stat(path.join(root, ...key.split('/'))).catch(() => undefined))) noteBlobs(db, key, undefined, now); // deleted while the app was closed
    }
    for await (const rel of treeFiles(root)) {
      if (!/\.md$/i.test(rel)) continue;
      const file = path.join(root, ...rel.split('/'));
      const info = await stat(file).catch(() => undefined);
      if (!info || info.mtimeMs < since || info.size > SMALL_FILE_BYTES) continue;
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text !== undefined) noteBlobs(db, rel, text, now);
    }
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [SCANNED_KEY, String(now)]);
  } catch { /* the next start looks again */ }
}
