// Opening the database for this app version (upgrade safety, 23.10.2026). Reads the stored schema
// before anything migrates and refuses data written by a newer app; before the first migration of
// an older schema it takes ONE consistent copy of the data as it was – one per app version: a retry
// of the same version after a failed migration takes none (`VACUUM INTO`
// <data>/backups/pre-upgrade/<version>-s<schema>.db plus a .json manifest; written to .part and
// renamed, only with enough free disk space) and then migrates; a finished migration stamps the
// copy's `migratedAt`. A copy made from data an incomplete update left behind is `partial`.
// Pruning keeps the newest KEEP_BACKUPS copies and always the newest clean (not partial) one – the
// real rollback point a released version can open. Every failure closes the database and throws
// an UpgradeError whose stage the start guard (repair/journal.ts) turns into the repair screen.
// Owns: the pre-migration copies, their manifests and pruning, the failure stages.
// Never: migrates without the copy, overwrites an existing copy, deletes the newest clean copy or
// live data, or puts SQL text or paths of the person's files into an error message beyond the data
// folder's own names.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UpgradeBackupInfo } from '../../shared/model/repair.ts';
import type { Logger } from '../contracts.ts';
import { Db } from './database.ts';
import { migrate, SCHEMA_VERSION } from './migrate.ts';

export type UpgradeStage = 'schema_newer' | 'migration_failed' | 'backup_failed' | 'data_unreadable';

/** A start that must not go on with this data (the repair screen explains it). */
export class UpgradeError extends Error {
  readonly stage: UpgradeStage;
  readonly dataSchema?: number;
  readonly appSchema: number;

  constructor(stage: UpgradeStage, message: string, extra: { dataSchema?: number; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'UpgradeError';
    this.stage = stage;
    this.dataSchema = extra.dataSchema;
    this.appSchema = SCHEMA_VERSION;
  }
}

export function isUpgradeError(error: unknown): error is UpgradeError {
  return error instanceof UpgradeError || (error instanceof Error && error.name === 'UpgradeError' && typeof (error as { stage?: unknown }).stage === 'string');
}

/** How many pre-update copies stay (each is a full copy of the database). */
export const KEEP_BACKUPS = 2;
/** Room left on the disk after the copy, on top of its own size. */
const SPARE_BYTES = 64 * 1024 * 1024;
const UNREADABLE = /malformed|not a database|file is encrypted|SQLITE_(?:CORRUPT|NOTADB)/i;

export interface OpenOptions {
  /** The database file (<data>/workforce.db). */
  file: string;
  dataDir: string;
  /** This app's version (names the copy). */
  version: string;
  now?: () => number;
  /** Free bytes on the disk of `dir`; undefined = unknown (the copy is tried anyway). */
  freeBytes?: (dir: string) => number | undefined;
  keep?: number;
  log?: Logger;
  /** Tests: a migration step in place of migrate() (e.g. one that fails). */
  migrateFn?: (db: Db) => void;
}

export function backupDir(dataDir: string): string {
  return path.join(dataDir, 'backups', 'pre-upgrade');
}

/** The schema stored in the database (0 = new or empty file). */
export function storedSchema(db: Db): number {
  const table = db.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`);
  if (!table) return 0;
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`);
  const value = row ? Number(row.value) : 0;
  return Number.isFinite(value) ? value : 0;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
}

function closeQuietly(db: Db | undefined): void {
  try { db?.close(); } catch { /* already closed */ }
}

function defaultFree(dir: string): number | undefined {
  try { const stats = statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
}

/**
 * Opens `file`, takes the pre-update copy when this version migrates older data, and migrates.
 * Throws UpgradeError (database closed) when the start must not go on.
 */
export function openDatabase(options: OpenOptions): Db {
  probe(options.file);
  let db: Db | undefined;
  let from: number;
  try {
    db = new Db(options.file);
    from = storedSchema(db);
  } catch (error) {
    closeQuietly(db);
    if (UNREADABLE.test(message(error))) throw new UpgradeError('data_unreadable', `The data file cannot be read: ${message(error)}`, { cause: error });
    throw error;
  }
  if (from > SCHEMA_VERSION) {
    closeQuietly(db);
    throw new UpgradeError('schema_newer', `The data was saved by a newer version of Autark (schema ${from}; this version knows ${SCHEMA_VERSION}).`, { dataSchema: from });
  }
  if (from > 0 && from < SCHEMA_VERSION) {
    try {
      const copy = ensurePreUpgradeBackup(db, { ...options, from });
      options.log?.info('pre-update copy ready', { id: copy.id, schema: from, to: SCHEMA_VERSION });
    } catch (error) {
      closeQuietly(db);
      throw new UpgradeError('backup_failed', `The safety copy before the update could not be made: ${message(error)}`, { dataSchema: from, cause: error });
    }
  }
  try {
    (options.migrateFn ?? ((target: Db) => { migrate(target); }))(db);
  } catch (error) {
    let reached = from;
    try { reached = storedSchema(db); } catch { /* keep the schema read before */ }
    closeQuietly(db);
    if (UNREADABLE.test(message(error))) throw new UpgradeError('data_unreadable', `The data file cannot be read: ${message(error)}`, { dataSchema: reached, cause: error });
    throw new UpgradeError('migration_failed', `Updating the data from schema ${reached} failed: ${message(error)}`, { dataSchema: reached, cause: error });
  }
  if (from > 0 && from < SCHEMA_VERSION) markMigrated(options);
  return db;
}

/** True when `file` holds older data this version will copy and migrate (read-only peek; false when unreadable or new). */
export function upgradePending(file: string): boolean {
  if (!existsSync(file)) return false;
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(file, { readOnly: true });
    const row = raw.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value?: string } | undefined;
    const schema = Number(row?.value ?? 0);
    return schema > 0 && schema < SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    try { raw?.close(); } catch { /* closed */ }
  }
}

/**
 * Reads the schema list once through a raw handle that is always closed: a damaged file fails here
 * (data_unreadable) instead of inside Db's constructor, whose half-open handle would keep the file
 * locked on Windows (the repair screen must be able to move it aside).
 */
function probe(file: string): void {
  if (!existsSync(file)) return;
  let raw: DatabaseSync | undefined;
  try {
    raw = new DatabaseSync(file, { readOnly: true });
    raw.prepare(`SELECT count(*) FROM sqlite_master`).get();
  } catch (error) {
    if (UNREADABLE.test(message(error))) throw new UpgradeError('data_unreadable', `The data file cannot be read: ${message(error)}`, { cause: error });
    // Anything else (a lock, a WAL that needs writing) is left to the real open below.
  } finally {
    try { raw?.close(); } catch { /* closed */ }
  }
}

function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'unknown';
}

function readManifest(file: string): UpgradeBackupInfo | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpgradeBackupInfo>;
    if (typeof value.id !== 'string' || typeof value.appVersion !== 'string' || typeof value.schema !== 'number' || typeof value.createdAt !== 'number') return undefined;
    return {
      id: value.id, appVersion: value.appVersion, schema: value.schema, bytes: Number(value.bytes) || 0, createdAt: value.createdAt,
      ...(typeof value.migratedAt === 'number' ? { migratedAt: value.migratedAt } : {}),
      ...(value.partial === true ? { partial: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

function writeManifest(dataDir: string, info: UpgradeBackupInfo): void {
  const file = path.join(backupDir(dataDir), `${info.id}.json`);
  writeFileSync(`${file}.part`, `${JSON.stringify({ ...info, targetSchema: SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.part`, file);
}

/** The migration of this version finished: its copy is a state the migration started from cleanly. */
function markMigrated(options: OpenOptions): void {
  try {
    const own = listUpgradeBackups(options.dataDir).find((info) => info.appVersion === options.version);
    if (own && own.migratedAt === undefined) writeManifest(options.dataDir, { ...own, migratedAt: (options.now ?? Date.now)() });
  } catch (error) {
    options.log?.warn('pre-update copy not marked as migrated', { error: message(error) }); // only pruning uses the mark
  }
}

/** The pre-update copies whose database file exists, newest first. */
export function listUpgradeBackups(dataDir: string): UpgradeBackupInfo[] {
  const dir = backupDir(dataDir);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const list: UpgradeBackupInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const info = readManifest(path.join(dir, name));
    if (info && info.id === name.slice(0, -5) && existsSync(path.join(dir, `${info.id}.db`))) list.push(info);
  }
  return list.sort((a, b) => b.createdAt - a.createdAt || b.schema - a.schema);
}

/** The database file of copy `id` (validated: one of listUpgradeBackups). */
export function upgradeBackupFile(dataDir: string, id: string): string | undefined {
  return listUpgradeBackups(dataDir).some((info) => info.id === id) ? path.join(backupDir(dataDir), `${id}.db`) : undefined;
}

function fileSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

/**
 * VACUUM INTO a copy of the data as it is now – once per app version: a retry of the same version
 * (after a failed migration, or after a restore) keeps the copy it already made – then prunes.
 */
export function ensurePreUpgradeBackup(db: Db, options: OpenOptions & { from: number }): UpgradeBackupInfo {
  const dir = backupDir(options.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${safeVersion(options.version)}-s${options.from}`;
  const target = path.join(dir, `${id}.db`);
  const before = listUpgradeBackups(options.dataDir);
  const existing = before.find((info) => info.appVersion === options.version) ?? before.find((info) => info.id === id);
  if (existing) return existing;
  for (const name of readdirSync(dir)) if (name.endsWith('.part')) rmSync(path.join(dir, name), { force: true });
  const needed = fileSize(options.file) + fileSize(`${options.file}-wal`);
  const free = (options.freeBytes ?? defaultFree)(dir);
  if (free !== undefined && free < needed * 1.1 + SPARE_BYTES) {
    throw new Error(`not enough free disk space (about ${Math.ceil((needed * 1.1 + SPARE_BYTES) / 1048576)} MB needed, ${Math.floor(free / 1048576)} MB free)`);
  }
  const part = `${target}.part`;
  rmSync(target, { force: true });
  db.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`);
  renameSync(part, target);
  // The newest earlier copy whose migration never finished: the data now is what that update left behind.
  const partial = before.length > 0 && before[0].migratedAt === undefined;
  const info: UpgradeBackupInfo = {
    id, appVersion: options.version, schema: options.from, bytes: fileSize(target), createdAt: (options.now ?? Date.now)(),
    ...(partial ? { partial: true as const } : {}),
  };
  writeManifest(options.dataDir, info);
  pruneBackups(options.dataDir, options.keep ?? KEEP_BACKUPS, id);
  return info;
}

/** Keeps the newest `keep` copies, always `current`, and always the newest clean copy (the real rollback point). */
function pruneBackups(dataDir: string, keep: number, current: string): void {
  const dir = backupDir(dataDir);
  const list = listUpgradeBackups(dataDir);
  const clean = list.find((info) => !info.partial)?.id;
  let kept = 0;
  for (const info of list) {
    if (info.id === current || info.id === clean || kept < keep - 1) { if (info.id !== current) kept++; continue; }
    rmSync(path.join(dir, `${info.id}.db`), { force: true });
    rmSync(path.join(dir, `${info.id}.json`), { force: true });
  }
}
