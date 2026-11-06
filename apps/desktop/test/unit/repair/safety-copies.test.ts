// Safety copies of the whole database (repair/safety-copies.ts, repair/service.ts restore): a restore refuses a copy
// newer than this app's schema and moves nothing; the set-aside folders are pruned to KEEP_REPLACED at each restore
// (never the one just made); the copies are listed with their path and time and say they hold the secrets encrypted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { backupDir, openDatabase } from '../../../src/runtime/db/upgrade.ts';
import { BootJournal } from '../../../src/runtime/repair/journal.ts';
import { RepairService } from '../../../src/runtime/repair/service.ts';
import { KEEP_REPLACED, pruneReplaced, replacedFolders, safetyCopies } from '../../../src/runtime/repair/safety-copies.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { StartProblem } from '../../../src/shared/model/repair.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

function tempData(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-safety-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** Old data (schema 20) migrated once by 0.9.0: one pre-update copy '0.9.0-s20'. */
function upgraded(dir: string): void {
  const file = path.join(dir, 'workforce.db');
  const db = new Db(file);
  migrate(db, { until: 20 });
  db.close();
  openDatabase({ file, dataDir: dir, version: '0.9.0', now: () => 1_000 }).close();
}

function service(dir: string, restarts: { n: number }, now = () => Date.UTC(2026, 9, 23, 10)): RepairService {
  const problem: StartProblem = { code: 'schema_newer', version: '0.9.0', at: 1 };
  const host = { restart: async () => { restarts.n++; }, openPath: async () => {} } as unknown as Pick<Host, 'restart' | 'openPath'>;
  return new RepairService({ dataDir: dir, version: '0.9.0', host, journal: new BootJournal({ dataDir: dir }), problem, now });
}

test('a copy newer than this app is refused and nothing moves', async (t) => {
  const dir = tempData(t);
  upgraded(dir);
  const id = `1.2.0-s${SCHEMA_VERSION + 3}`;
  writeFileSync(path.join(backupDir(dir), `${id}.db`), 'x');
  writeFileSync(path.join(backupDir(dir), `${id}.json`), JSON.stringify({ id, appVersion: '1.2.0', schema: SCHEMA_VERSION + 3, bytes: 1, createdAt: 2_000 }));
  const restarts = { n: 0 };
  await assert.rejects(service(dir, restarts).restore(id), (error: unknown) => error instanceof WorkforceError && error.code === 'conflict' && /newer version/.test(error.message));
  assert.equal(restarts.n, 0);
  assert.deepEqual(replacedFolders(dir), [], 'the live data was not moved');
  assert.ok(existsSync(path.join(dir, 'workforce.db')));
});

test('restores keep only the newest set-aside folders (never the one just made)', async (t) => {
  const dir = tempData(t);
  upgraded(dir);
  const restarts = { n: 0 };
  let now = Date.UTC(2026, 9, 23, 10);
  const kept: string[] = [];
  for (let index = 0; index < KEEP_REPLACED + 2; index++) {
    now += 60_000;
    kept.push((await service(dir, restarts, () => now).restore('0.9.0-s20')).kept);
    utimesSync(path.join(kept[index], 'workforce.db'), new Date(now), new Date(now)); // data last written at that restore
  }
  assert.equal(restarts.n, KEEP_REPLACED + 2);
  assert.deepEqual(replacedFolders(dir).map((folder) => folder.path), kept.slice(-KEEP_REPLACED).reverse());
  assert.equal(pruneReplaced(dir, kept.at(-1)!), 0, 'nothing more to prune');
});

test('the safety copies are listed with their path and time and say they hold the secrets encrypted', (t) => {
  const dir = tempData(t);
  upgraded(dir);
  const aside = path.join(dir, 'before-repair-2026-10-23-101500');
  mkdirSync(aside);
  writeFileSync(path.join(aside, 'workforce.db'), 'x');
  const copies = safetyCopies(dir);
  assert.deepEqual(copies.map((copy) => [copy.kind, copy.label]), [['backup', 'Safety copy before an update'], ['backup', 'Data set aside by a restore']]);
  assert.equal(copies[0].path, backupDir(dir), 'Show in folder opens the folder, not the database file');
  assert.equal(copies[0].at, 1_000);
  for (const copy of copies) assert.match(copy.detail, /including secrets \(encrypted with this PC's key\) and anything forgotten since/);

});
