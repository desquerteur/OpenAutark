// Restore = put a backup back, in two steps: system.restore stages it (a marker file in the data folder) and
// applyPendingRestore applies it at the next start, BEFORE the database is opened (compose/lifecycle.ts
// restoreAtStart). Every entry the backup carries replaces the live one, which moves aside into
// <data>/before-restore-<time>/ (nothing is deleted); settings.json, theme.css, agents/ and memory/ always move aside, so the
// backup's own (or, without one, the defaults – an older backup's settings rows move into the file at the start) apply; the
// chat mirror moves aside too (it is written again from the restored database), workspace-skills/ goes back to
// <workspace>/skills and workspace-agent-skills/<slug>/ to <workspace>/agents/<slug>/skills (the agents' skills folders
// there move aside first). This PC's own identity and keys
// are carried over from the database that was live (machine-bound.ts), so a restore on another PC keeps that
// PC's identity. The outcome lands in restore-result.json (system.restoreStatus); a failure rolls back.
// Owns: the marker, the swap and the result file. Never: runs while the database is open, or retries a failed
// restore at every start (a failed marker is renamed to restore-failed.json).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkforceError } from '../../shared/errors.ts';
import type { RestoreStatus } from '../../shared/model/restore.ts';
import type { Logger } from '../contracts.ts';
import { AGENT_SKILLS, DB_FILE, MACHINE_KEY_FILE, MANIFEST_FILE, WORKSPACE_SKILLS, checkBackup, stamp } from './backup.ts';
import { carryOver } from './machine-bound.ts';

export const RESTORE_MARKER = 'restore-from.json';
const RESTORE_FAILED = 'restore-failed.json';
const RESULT_FILE = 'restore-result.json';
const MARKER_FORMAT = 'workforce-restore';
/**
 * Always moved aside: the database files, the settings, the look, the agent folders and the memory tree (the backup's copies
 * come back; a backup from before the folders gets them written from its database at the start) and the chat mirror.
 */
const ALWAYS = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, 'settings.json', 'theme.css', 'agents', 'memory', 'chats'];
/** Backup entries that are not data-folder entries (the manifest, the workspace's and its agents' skills, a v2 backup's own skills
 *  layout) or never put back (another PC's runtime.key, in a backup made before it was left out). */
const NOT_DATA = new Set([MANIFEST_FILE, WORKSPACE_SKILLS, AGENT_SKILLS, 'skills', MACHINE_KEY_FILE]);

interface Marker { format: typeof MARKER_FORMAT; version: 1; path: string; stagedAt: number }
interface Result { ok: boolean; at: number; from: string; backupAt?: number; error?: string }

/** Writes the marker (atomically) after the caller checked the backup folder. */
export function stageRestore(dataDir: string, folder: string, now: number): void {
  const marker: Marker = { format: MARKER_FORMAT, version: 1, path: path.resolve(folder), stagedAt: now };
  const file = path.join(dataDir, RESTORE_MARKER);
  writeFileSync(`${file}.part`, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.part`, file);
}

/** True when a restore waits for this start. */
export function restorePending(dataDir: string): boolean {
  return existsSync(path.join(dataDir, RESTORE_MARKER));
}

/** The staged restore, or undefined when none waits or the marker is unreadable. */
export function stagedRestore(dataDir: string): { path: string; stagedAt: number } | undefined {
  try {
    const marker = JSON.parse(readFileSync(path.join(dataDir, RESTORE_MARKER), 'utf8')) as Partial<Marker>;
    if (marker?.format !== MARKER_FORMAT || typeof marker.path !== 'string') return undefined;
    return { path: marker.path, stagedAt: typeof marker.stagedAt === 'number' ? marker.stagedAt : 0 };
  } catch {
    return undefined;
  }
}

/** system.restoreStatus: a staged restore, the last one a start applied or refused, and whether the app can restart itself. */
export function restoreStatusOf(dataDir: string, canRestart: boolean): RestoreStatus {
  const staged = stagedRestore(dataDir);
  let last: Result | undefined;
  try { last = JSON.parse(readFileSync(path.join(dataDir, RESULT_FILE), 'utf8')) as Result; } catch { last = undefined; }
  return {
    ...(staged ? { staged } : {}),
    ...(last && typeof last.at === 'number' ? { last: { ok: last.ok === true, at: last.at, from: String(last.from ?? ''), ...(last.backupAt ? { backupAt: last.backupAt } : {}), ...(last.error ? { error: last.error } : {}) } } : {}),
    canRestart,
  };
}

function writeResult(dataDir: string, result: Result): void {
  try { writeFileSync(path.join(dataDir, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`); } catch { /* best effort */ }
}

function fail(dataDir: string, log: Logger, error: unknown, at: number, from = ''): false {
  const message = error instanceof Error ? error.message : String(error);
  log.error('staged restore not applied', { error: message });
  writeResult(dataDir, { ok: false, at, from, error: message });
  try { renameSync(path.join(dataDir, RESTORE_MARKER), path.join(dataDir, RESTORE_FAILED)); } catch { /* best effort */ }
  try { rmSync(path.join(dataDir, RESTORE_MARKER), { force: true }); } catch { /* best effort */ }
  return false;
}

export interface ApplyOptions {
  /** Names the fallback folder (default: wall clock – no Clock exists this early). */
  now?: number;
  /** The workspace the backup's workspace-skills/ go back to. */
  workspace?: string;
}

/** True when a staged restore was applied (the caller then opens the restored database). */
export function applyPendingRestore(dataDir: string, log: Logger, options: ApplyOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const markerFile = path.join(dataDir, RESTORE_MARKER);
  if (!existsSync(markerFile)) return false;
  let folder = '';
  let backupAt = 0;
  try {
    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Partial<Marker>;
    if (marker?.format !== MARKER_FORMAT || typeof marker.path !== 'string' || !path.isAbsolute(marker.path)) throw new WorkforceError('bad_request', 'The restore marker is invalid.');
    folder = marker.path;
    backupAt = checkBackup(folder).createdAt; // again: the folder may have changed since it was staged
  } catch (error) {
    return fail(dataDir, log, error, now, folder);
  }

  const fallback = path.join(dataDir, `before-restore-${stamp(now, true)}`);
  const entries = readdirSync(folder).filter((name) => !NOT_DATA.has(name));
  const replaced = [...new Set([...ALWAYS, ...entries])];
  const moved: string[] = [];
  const copied: string[] = [];
  let skillsMoved = false;
  const skills = options.workspace ? path.join(options.workspace, 'skills') : undefined;
  const agents = options.workspace ? path.join(options.workspace, 'agents') : undefined;
  const carried = path.join(folder, AGENT_SKILLS);
  const ownMoved: string[] = [];
  const ownCopied: string[] = [];
  try {
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    for (const name of replaced) {
      if (!existsSync(path.join(dataDir, name))) continue;
      renameSync(path.join(dataDir, name), path.join(fallback, name));
      moved.push(name);
    }
    for (const name of entries) {
      copied.push(name);
      cpSync(path.join(folder, name), path.join(dataDir, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    }
    if (skills && existsSync(path.join(folder, WORKSPACE_SKILLS))) {
      if (existsSync(skills)) { renameSync(skills, path.join(fallback, WORKSPACE_SKILLS)); skillsMoved = true; }
      cpSync(path.join(folder, WORKSPACE_SKILLS), skills, { recursive: true, verbatimSymlinks: true });
    }
    if (agents && existsSync(carried)) {
      for (const slug of existsSync(agents) ? readdirSync(agents) : []) {
        if (!existsSync(path.join(agents, slug, 'skills'))) continue;
        mkdirSync(path.join(fallback, AGENT_SKILLS), { recursive: true });
        renameSync(path.join(agents, slug, 'skills'), path.join(fallback, AGENT_SKILLS, slug));
        ownMoved.push(slug);
      }
      for (const slug of readdirSync(carried)) {
        ownCopied.push(slug);
        cpSync(path.join(carried, slug), path.join(agents, slug, 'skills'), { recursive: true, verbatimSymlinks: true });
      }
    }
  } catch (error) {
    for (const name of copied) { try { rmSync(path.join(dataDir, name), { recursive: true, force: true }); } catch { /* keep going */ } }
    for (const name of moved) { try { renameSync(path.join(fallback, name), path.join(dataDir, name)); } catch (moveError) { log.error('restore rollback failed', { name, fallback, error: String(moveError) }); } }
    if (skills && skillsMoved) { try { rmSync(skills, { recursive: true, force: true }); renameSync(path.join(fallback, WORKSPACE_SKILLS), skills); } catch { /* the fallback keeps them */ } }
    for (const slug of ownCopied) { try { rmSync(path.join(agents!, slug, 'skills'), { recursive: true, force: true }); } catch { /* keep going */ } }
    for (const slug of ownMoved) { try { renameSync(path.join(fallback, AGENT_SKILLS, slug), path.join(agents!, slug, 'skills')); } catch { /* the fallback keeps them */ } }
    try { if (!readdirSync(fallback).length) rmdirSync(fallback); } catch { /* keep the folder */ }
    return fail(dataDir, log, error, now, folder);
  }

  // This PC's identity and keys come from the database that was live until now (failure only costs re-entry).
  if (moved.includes(DB_FILE)) {
    let restored: DatabaseSync | undefined;
    try {
      restored = new DatabaseSync(path.join(dataDir, DB_FILE));
      carryOver(restored, path.join(fallback, DB_FILE));
    } catch (error) {
      log.warn('restore: keys of this PC not carried over', { error: String(error) });
    } finally {
      try { restored?.close(); } catch { /* ignore */ }
    }
  }
  writeResult(dataDir, { ok: true, at: now, from: folder, backupAt });
  try { rmSync(markerFile, { force: true }); } catch { /* a leftover marker is checked again next start */ }
  log.info('staged restore applied', { from: folder, previous: fallback });
  return true;
}
