// Backup = a copy of the data folder: one snapshot folder with the database (`VACUUM INTO`, consistent while the
// app runs), every other entry of <data> as it is, with its file times – settings.json (all settings), theme.css (the look)
// and memory/ (the memory tree) among them –, the workspace's skills (workspace-skills/), its agents' own skills
// (<workspace>/agents/<slug>/skills → workspace-agent-skills/<slug>/) and manifest.json (written
// last: its presence marks a complete backup). Left out: CLI logins (accounts/ – sign in again on another PC), this PC's key (runtime.key), Electron's own
// profile entries (the desktop's data folder is its userData: caches, browser state), logs, temp and engine folders,
// the agents' wf shim (bin/, the app writes it again), another company's workspace (<data>/workspace – like the first
// company's, only its skills are carried), the chat mirror (written again from the database), the old overlay folder
// custom/, earlier backups and restore leftovers, and at any depth the temp files of atomic writes and uploads (*.tmp,
// *.part, blobs/tmp). A file renamed or deleted while the copy runs never fails the backup (copyEntry).
// Where: by default <data>/backups/<stamp>/; a folder the person chooses must lie outside the data folder.
// Owns: the snapshot folder, the copy, the manifest and the check of a backup folder. Never: keeps a half written
// snapshot (a failed backup removes what it wrote).

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkforceError } from '../../shared/errors.ts';
import type { Logger, Paths } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { SCHEMA_VERSION } from '../db/migrate.ts';

export const BACKUP_FORMAT = 'workforce-backup';
export const BACKUP_VERSION = 3;
export const DB_FILE = 'workforce.db';
export const MANIFEST_FILE = 'manifest.json';
export const BACKUPS_DIR = 'backups';
/** The workspace's skills inside a snapshot. */
export const WORKSPACE_SKILLS = 'workspace-skills';
/** The agents' own skills of the workspace inside a snapshot, one folder per agent folder (always there, maybe empty). */
export const AGENT_SKILLS = 'workspace-agent-skills';
/** The headless runtime's own encryption key (host-node.ts) – bound to this PC like the OS key, never copied or restored. */
export const MACHINE_KEY_FILE = 'runtime.key';
/** Entries of <data> a backup never carries (the database is copied with VACUUM INTO). */
const NOT_COPIED = new Set([DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, BACKUPS_DIR, 'pre-upgrade', 'accounts', 'logs', 'tmp', 'engine-cwd', 'engine-prompts', 'engine-transcripts', 'chats', 'custom', 'bin', 'workspace',
  'restore-from.json', 'restore-from.json.part', 'restore-failed.json', 'restore-result.json',
  MACHINE_KEY_FILE]); // this PC's own key (host-node.ts): another PC's key would make its carried-over identity unreadable
/**
 * Electron's own profile entries: on the desktop the data folder IS Electron's userData (main/app-paths.ts), and Chromium
 * keeps these open (a copy fails on a locked file). They are caches and this PC's browser state, never Workforce data.
 */
const ELECTRON_PROFILE = new Set(['blob_storage', 'Cache', 'Code Cache', 'Cookies', 'Cookies-journal', 'Crashpad', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'databases', 'DevToolsActivePort', 'Dictionaries', 'DIPS', 'DIPS-journal', 'DIPS-wal', 'GPUCache', 'GPUPersistentCache',
  'GrShaderCache', 'IndexedDB', 'keyring-name', 'Local State', 'Local Storage', 'lockfile', 'Network', 'Network Persistent State', 'Partitions', 'Preferences',
  'Service Worker', 'Session Storage', 'Shared Dictionary', 'shared_proto_db', 'ShaderCache', 'SingletonCookie', 'SingletonLock',
  'SingletonSocket', 'TransportSecurity', 'Trust Tokens', 'VideoDecodeStats', 'WebStorage']);
/**
 * The temp file of an atomic write, at any depth: <name>.tmp (next-due.json.tmp; device sync's <file>.<uuid>.tmp in
 * memory/, agents/, workspace/skills …) or <uuid>.part (a file upload in blobs/tmp) – renamed away while a backup runs.
 */
export const isTempFile = (name: string): boolean => name.endsWith('.tmp') || name.endsWith('.part');
/** An entry of <data> the backup leaves out: listed above, one of Chromium's own small databases (declarative_*.db), or a temp file. */
const leftOut = (entry: string): boolean => NOT_COPIED.has(entry) || ELECTRON_PROFILE.has(entry) || /^declarative_[\w-]*\.db(?:-journal|-wal|-shm)?$/.test(entry) || isTempFile(entry);

/**
 * Copies one entry (file or folder, recursively) into the snapshot without temp files or the folders in `skip`. A file
 * that vanishes during the copy (a rename or delete racing the backup) never fails the backup: the half-copied target
 * goes, and the entry is copied once more – or left out when it is gone itself.
 */
export async function copyEntry(source: string, target: string, options: { skip?: readonly string[]; timestamps?: boolean } = {}): Promise<void> {
  const skip = (options.skip ?? []).map((dir) => path.resolve(dir));
  const filter = (from: string): boolean => !isTempFile(path.basename(from)) && !skip.some((dir) => isInside(from, dir));
  for (let attempt = 0; ; attempt++) {
    try {
      await cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: options.timestamps === true, filter });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await rm(target, { recursive: true, force: true });
      if (!existsSync(source)) return; // gone since readdir: nothing to carry
      if (attempt >= 1) throw error;
    }
  }
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  schemaVersion: number;
}

export interface BackupInput {
  db: Db;
  /** `blobs`: where uploads land (default <data>/blobs); its tmp/ stays out. */
  paths: Pick<Paths, 'data' | 'workspace' | 'temp'> & Partial<Pick<Paths, 'blobs'>>;
  now: number;
  log: Logger;
  /** Absolute snapshot folder (must be new or empty). Default: <data>/backups/<yyyy-mm-dd-hhmm>. */
  dir?: string;
}

/** Local time as `2026-10-19-1430` (folder names sort by time). */
export function stamp(now: number, seconds = false): string {
  const d = new Date(now);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${seconds ? two(d.getSeconds()) : ''}`;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Inside <data>/backups (where the app's own backups live). */
export function inBackupArea(folder: string, dataDir: string): boolean {
  return isInside(folder, path.join(dataDir, BACKUPS_DIR));
}

/** A complete backup folder whose database this app can open (else bad_request); its manifest. */
export function checkBackup(folder: string): BackupManifest {
  let manifest: Partial<BackupManifest>;
  try { manifest = JSON.parse(readFileSync(path.join(folder, MANIFEST_FILE), 'utf8')) as Partial<BackupManifest>; } catch {
    throw new WorkforceError('bad_request', 'This is not a complete Autark backup (manifest.json is missing or unreadable).');
  }
  if (manifest?.format !== BACKUP_FORMAT || typeof manifest.createdAt !== 'number') throw new WorkforceError('bad_request', 'This is not an Autark backup.');
  if (!statSync(path.join(folder, DB_FILE), { throwIfNoEntry: false })?.isFile()) throw new WorkforceError('bad_request', 'The backup has no database.');
  if (typeof manifest.schemaVersion === 'number' && manifest.schemaVersion > SCHEMA_VERSION) {
    throw new WorkforceError('bad_request', 'This backup comes from a newer version of Autark. Update first, then restore it.');
  }
  return manifest as BackupManifest;
}

async function size(target: string): Promise<number> {
  const info = await stat(target);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target)) total += await size(path.join(target, entry));
  return total;
}

async function targetFolder(input: BackupInput): Promise<{ folder: string; created: boolean }> {
  if (input.dir !== undefined) {
    const folder = path.resolve(input.dir);
    if (isInside(folder, input.paths.data) && !inBackupArea(folder, input.paths.data)) throw new WorkforceError('bad_request', 'Choose a backup folder outside the data folder.');
    if (existsSync(folder)) {
      if (!(await stat(folder)).isDirectory() || (await readdir(folder)).length) throw new WorkforceError('conflict', 'Choose an empty folder for the backup.');
      return { folder, created: false };
    }
    return { folder, created: true };
  }
  const base = path.join(input.paths.data, BACKUPS_DIR, stamp(input.now));
  for (let index = 1; index < 100; index++) {
    const folder = index === 1 ? base : `${base}-${index}`;
    if (!existsSync(folder)) return { folder, created: true };
  }
  throw new WorkforceError('conflict', 'Too many backups in this minute. Try again shortly.');
}

/** Creates the snapshot folder; its path and size. */
export async function createBackup(input: BackupInput): Promise<{ path: string; bytes: number; manifest: BackupManifest }> {
  const { folder, created } = await targetFolder(input);
  await mkdir(folder, { recursive: true });
  try {
    const dbFile = path.join(folder, DB_FILE);
    input.db.run('VACUUM INTO ?', [dbFile]);
    const copy = new DatabaseSync(dbFile);
    let schemaVersion = 0;
    try {
      copy.exec('PRAGMA journal_mode = DELETE'); // one self-contained file
      schemaVersion = Number((copy.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined)?.value ?? 0);
    } finally {
      copy.close();
    }
    const temp = path.resolve(input.paths.temp);
    // Uploads in progress (blobs/tmp/<uuid>.part) are never data.
    const skip = [path.join(input.paths.blobs ?? path.join(input.paths.data, 'blobs'), 'tmp')];
    for (const entry of await readdir(input.paths.data)) {
      const source = path.join(input.paths.data, entry);
      if (leftOut(entry) || entry.startsWith('before-restore-') || path.resolve(source) === temp || isInside(folder, source)) continue;
      await copyEntry(source, path.join(folder, entry), { skip, timestamps: true });
    }
    const skills = path.join(input.paths.workspace, 'skills');
    if (existsSync(skills)) await copyEntry(skills, path.join(folder, WORKSPACE_SKILLS));
    const agents = path.join(input.paths.workspace, 'agents');
    await mkdir(path.join(folder, AGENT_SKILLS));
    for (const slug of await readdir(agents).catch(() => [] as string[])) {
      const own = path.join(agents, slug, 'skills');
      if (existsSync(own)) await copyEntry(own, path.join(folder, AGENT_SKILLS, slug));
    }
    const manifest: BackupManifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: input.now, schemaVersion };
    await writeFile(path.join(folder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    const bytes = await size(folder);
    input.log.info('backup created', { folder, bytes });
    return { path: folder, bytes, manifest };
  } catch (error) {
    if (created) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    else for (const entry of await readdir(folder).catch(() => [] as string[])) await rm(path.join(folder, entry), { recursive: true, force: true }).catch(() => undefined);
    input.log.warn('backup failed', { folder, error: String(error) });
    if (error instanceof WorkforceError) throw error;
    throw new WorkforceError('internal', 'The backup could not be written. Check free disk space and try again.', { cause: error });
  }
}
