// Upgrade safety (db/upgrade.ts): one consistent pre-update copy (VACUUM INTO) per app version
// before older data migrates – never for a new or current database, none for a retry of the same
// version, pruned to KEEP_BACKUPS but never the newest clean copy (the untouched data an earlier
// release wrote), stamped migratedAt when the migration finished, `partial` when made from data a
// failed update left behind; refused data of a newer app, a failed migration, a failed copy and a
// damaged file each throw an UpgradeError with the database closed (its file can be moved).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { backupDir, isUpgradeError, listUpgradeBackups, openDatabase, storedSchema, upgradeBackupFile, upgradePending, UpgradeError } from '../../../src/runtime/db/upgrade.ts';

function tempData(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** A database an older app left behind: schema `until`, one agent row. */
function oldDb(dir: string, until = 9): string {
  const file = path.join(dir, 'workforce.db');
  const db = new Db(file);
  migrate(db, { until });
  db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_old', 'Old Manager', 'm', 'human', 1, 1)`);
  db.close();
  return file;
}

function schemaOf(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string }).value); } finally { db.close(); }
}

test('a new database migrates without a copy; the current schema takes none either', (t) => {
  const dir = tempData(t);
  const file = path.join(dir, 'workforce.db');
  const db = openDatabase({ file, dataDir: dir, version: '0.3.0' });
  assert.equal(storedSchema(db), SCHEMA_VERSION);
  db.close();
  assert.equal(existsSync(backupDir(dir)), false, 'nothing to keep from an empty database');
  openDatabase({ file, dataDir: dir, version: '0.3.1' }).close();
  assert.deepEqual(listUpgradeBackups(dir), [], 'no migration, no copy');
});

test('older data: one consistent copy of the untouched data, then the migration; a second start keeps it', (t) => {
  const dir = tempData(t);
  const file = oldDb(dir, 9);
  let now = 1000;
  const db = openDatabase({ file, dataDir: dir, version: '0.3.0', now: () => now });
  assert.equal(storedSchema(db), SCHEMA_VERSION);
  assert.equal(db.get<{ name: string }>(`SELECT name FROM agents WHERE id = 'ag_old'`)?.name, 'Old Manager', 'the live data migrated');
  db.close();
  const [copy] = listUpgradeBackups(dir);
  assert.deepEqual({ id: copy.id, appVersion: copy.appVersion, schema: copy.schema, createdAt: copy.createdAt }, { id: '0.3.0-s9', appVersion: '0.3.0', schema: 9, createdAt: 1000 });
  assert.ok(copy.bytes > 0);
  const copyFile = upgradeBackupFile(dir, copy.id)!;
  assert.equal(schemaOf(copyFile), 9, 'the copy holds the data as it was before the update');
  const old = new DatabaseSync(copyFile, { readOnly: true });
  assert.equal((old.prepare(`SELECT name FROM agents WHERE id = 'ag_old'`).get() as { name: string }).name, 'Old Manager');
  old.close();
  now = 2000;
  openDatabase({ file, dataDir: dir, version: '0.3.0', now: () => now }).close();
  assert.equal(listUpgradeBackups(dir).length, 1, 'current schema: nothing new');
  assert.equal(readdirSync(backupDir(dir)).some((name) => name.endsWith('.part')), false);
  assert.equal(upgradeBackupFile(dir, '../workforce'), undefined, 'only listed copies resolve');
});

test('a failed migration closes the database, keeps the copy and says where it stopped; the retry does not overwrite the copy', (t) => {
  const dir = tempData(t);
  const file = oldDb(dir, 20);
  const failing = (db: Db) => {
    migrate(db, { until: 24 }); // a few migrations pass …
    db.exec('CREATE TABLE broken (x'); // … then one fails
  };
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.0', now: () => 5, migrateFn: failing }), (error: unknown) => {
    assert.ok(isUpgradeError(error));
    assert.equal(error.stage, 'migration_failed');
    assert.equal(error.dataSchema, 24, 'the schema the data reached');
    assert.equal(error.appSchema, SCHEMA_VERSION);
    assert.match(error.message, /from schema 24 failed/);
    return true;
  });
  // Closed: the file can be moved (Windows refuses to rename an open database).
  renameSync(file, `${file}.moved`);
  renameSync(`${file}.moved`, file);
  assert.equal(schemaOf(upgradeBackupFile(dir, '0.4.0-s20')!), 20, 'the copy is of the untouched data');
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.0', now: () => 9, migrateFn: failing }), UpgradeError);
  const copies = listUpgradeBackups(dir);
  assert.deepEqual(copies.map((info) => [info.id, info.createdAt, info.migratedAt]), [['0.4.0-s20', 5, undefined]], 'one copy per app version: the retry takes none, the migration never finished');
});

test('a fixed release after a failed one keeps the copy of the untouched data (the real rollback point)', (t) => {
  const dir = tempData(t);
  const file = oldDb(dir, 20);
  const failingAt = (until: number) => (db: Db) => { migrate(db, { until }); db.exec('CREATE TABLE broken (x'); };
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.0', now: () => 5, migrateFn: failingAt(24) }), UpgradeError);
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.0', now: () => 6, migrateFn: failingAt(24) }), UpgradeError, 'Try again: the same failure');
  // 0.4.1 also stops partway (s24 → s28), 0.4.2 finally migrates.
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.1', now: () => 7, migrateFn: failingAt(28) }), UpgradeError);
  openDatabase({ file, dataDir: dir, version: '0.4.2', now: () => 8 }).close();
  const copies = listUpgradeBackups(dir);
  assert.deepEqual(copies.map((info) => [info.id, info.partial ?? false, info.migratedAt]), [
    ['0.4.2-s28', true, 8], // made from what 0.4.1 left behind; its migration finished
    ['0.4.1-s24', true, undefined],
    ['0.4.0-s20', false, undefined], // the untouched data: kept beyond KEEP_BACKUPS
  ]);
  assert.equal(schemaOf(upgradeBackupFile(dir, '0.4.0-s20')!), 20);
});

test('the simple case: a failed version, its retry, then the fixed one – the untouched copy stays', (t) => {
  const dir = tempData(t);
  const file = oldDb(dir, 20);
  const failing = (db: Db) => { migrate(db, { until: 24 }); db.exec('CREATE TABLE broken (x'); };
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.0', now: () => 5, migrateFn: failing }), UpgradeError);
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.4.0', now: () => 6, migrateFn: failing }), UpgradeError);
  openDatabase({ file, dataDir: dir, version: '0.4.1', now: () => 7 }).close();
  assert.deepEqual(listUpgradeBackups(dir).map((info) => info.id), ['0.4.1-s24', '0.4.0-s20']);
  assert.equal(listUpgradeBackups(dir)[0].partial, true, 'labelled as made after an incomplete update');
});

test('data of a newer app is refused before anything is touched', (t) => {
  const dir = tempData(t);
  const file = oldDb(dir, 9);
  const db = new Db(file);
  db.run(`UPDATE meta SET value = ? WHERE key = 'schema'`, [String(SCHEMA_VERSION + 7)]);
  db.close();
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.3.0' }), (error: unknown) => isUpgradeError(error) && error.stage === 'schema_newer' && error.dataSchema === SCHEMA_VERSION + 7);
  assert.deepEqual(listUpgradeBackups(dir), [], 'no copy of data this app cannot read');
  assert.equal(schemaOf(file), SCHEMA_VERSION + 7);
});

test('too little disk space: nothing migrates (backup_failed), the data stays at its schema', (t) => {
  const dir = tempData(t);
  const file = oldDb(dir, 9);
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.3.0', freeBytes: () => 1024 }), (error: unknown) => isUpgradeError(error) && error.stage === 'backup_failed' && /free disk space/.test(error.message));
  assert.equal(schemaOf(file), 9, 'not migrated without the copy');
  assert.deepEqual(listUpgradeBackups(dir), []);
});

test('a damaged file is data_unreadable', (t) => {
  const dir = tempData(t);
  const file = path.join(dir, 'workforce.db');
  writeFileSync(file, Buffer.alloc(8192, 7));
  assert.throws(() => openDatabase({ file, dataDir: dir, version: '0.3.0' }), (error: unknown) => isUpgradeError(error) && error.stage === 'data_unreadable');
});

test('copies are pruned to the newest two (the current one always stays)', (t) => {
  const dir = tempData(t);
  const schemas = [9, 20, 24];
  for (const [index, version] of ['0.3.0', '0.4.0', '0.5.0'].entries()) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path.join(dir, `workforce.db${suffix}`), { force: true });
    const file = oldDb(dir, schemas[index]);
    openDatabase({ file, dataDir: dir, version, now: () => 100 + index }).close();
  }
  assert.deepEqual(listUpgradeBackups(dir).map((info) => info.id), ['0.5.0-s24', '0.4.0-s20']);
});

test('upgradePending: only older, readable data (the start then asks main for the long boot wait)', (t) => {
  const dir = tempData(t);
  const file = path.join(dir, 'workforce.db');
  assert.equal(upgradePending(file), false, 'no file');
  oldDb(dir, 9);
  assert.equal(upgradePending(file), true);
  openDatabase({ file, dataDir: dir, version: '0.3.0' }).close();
  assert.equal(upgradePending(file), false, 'current schema');
});
