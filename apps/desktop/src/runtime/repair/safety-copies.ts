// Local safety copies of the whole database (23.10.2026) for the data contract (LIFECYCLE): the
// copies db/upgrade.ts takes before an update (<data>/backups/pre-upgrade/<id>.db) and the database
// files a restore on the repair screen set aside (<data>/before-repair-<time>/). Both are raw
// copies of the database: unlike a backup they hold the secrets (encrypted with this PC's key), and
// a later Forget or retention pass does not reach them. The Data & privacy inventory and the Forget
// receipt name them (privacy/inventory.ts, privacy/forget.ts) with how long they stay.
// Retention: pre-update copies – the newest KEEP_BACKUPS plus the newest clean one (db/upgrade.ts
// prunes at each new copy); set-aside folders – the newest KEEP_REPLACED (pruned at each restore).
// They are kept beyond a stable start on purpose: a problem with an update often shows days later.
// Owns: listing both kinds, the wording, pruning the set-aside folders. Never: reads their
// contents, deletes a pre-update copy (db/upgrade.ts does) or the folder a restore just made.

import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RemainingCopy } from '../../shared/model/lifecycle.ts';
import { backupDir, KEEP_BACKUPS, listUpgradeBackups } from '../db/upgrade.ts';

/** Folder name prefix of the database files a restore set aside. */
export const REPLACED_PREFIX = 'before-repair-';
/** Set-aside folders kept (each holds a full database). */
export const KEEP_REPLACED = 2;

export interface ReplacedFolder { path: string; at: number }

function mtime(file: string): number | undefined {
  try { return statSync(file).mtimeMs; } catch { return undefined; }
}

/** The set-aside folders, newest first; `at` is when their data was last written. */
export function replacedFolders(dataDir: string): ReplacedFolder[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = readdirSync(dataDir, { withFileTypes: true }); } catch { return []; }
  const out: ReplacedFolder[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(REPLACED_PREFIX)) continue;
    const folder = path.join(dataDir, entry.name);
    const at = mtime(path.join(folder, 'workforce.db')) ?? mtime(folder);
    if (at !== undefined) out.push({ path: folder, at: Math.round(at) });
  }
  return out.sort((a, b) => b.at - a.at || b.path.localeCompare(a.path));
}

/** Keeps the newest `keep` set-aside folders and always `current`; returns how many were removed. */
export function pruneReplaced(dataDir: string, current: string, keep = KEEP_REPLACED): number {
  let kept = 0;
  let removed = 0;
  for (const folder of replacedFolders(dataDir)) {
    if (path.resolve(folder.path) === path.resolve(current)) continue;
    if (kept < keep - 1) { kept++; continue; }
    try { rmSync(folder.path, { recursive: true, force: true }); removed++; } catch { /* in use: the next restore tries again */ }
  }
  return removed;
}

/** Both kinds as copies outside the app's reach (newest first within each kind). */
export function safetyCopies(dataDir: string): RemainingCopy[] {
  const upgrade = listUpgradeBackups(dataDir).map((copy): RemainingCopy => ({
    kind: 'backup', label: 'Safety copy before an update', path: backupDir(dataDir), at: copy.createdAt,
    detail: `${copy.id}.db: the whole database as it was before the update to ${copy.appVersion}, including secrets (encrypted with this PC's key) and anything forgotten since. The newest ${KEEP_BACKUPS} are kept; delete the file to remove it sooner.`,
  }));
  const replaced = replacedFolders(dataDir).map((folder): RemainingCopy => ({
    kind: 'backup', label: 'Data set aside by a restore', path: folder.path, at: folder.at,
    detail: `The database a restore on the repair screen replaced, including secrets (encrypted with this PC's key) and anything forgotten since. The newest ${KEEP_REPLACED} are kept; delete the folder to remove it sooner.`,
  }));
  return [...upgrade, ...replaced];
}
