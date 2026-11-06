// The repair runtime over real RPC (repair/server.ts + rpc/handlers/repair.ts + repair/service.ts):
// after a failed migration the session may call only session.info and repair.*; repair.state names
// the problem and the pre-update copy; diagnostics are redacted and shown in the file manager;
// restore moves the live database aside (kept), puts the copy back, clears the problem and
// restarts; retry clears it and restarts; on a normal runtime retry/restore are refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { openDatabase } from '../../../src/runtime/db/upgrade.ts';
import { BootJournal } from '../../../src/runtime/repair/journal.ts';
import { startRepairRuntime } from '../../../src/runtime/repair/server.ts';
import { repairOf } from '../../../src/runtime/rpc/handlers/repair.ts';
import { memoryConnection } from '../../../src/runtime/rpc/connection.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { RepairState, StartProblem } from '../../../src/shared/model/repair.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

interface Setup { dir: string; journal: BootJournal; problem: StartProblem; host: Host; restarts: () => number; opened: string[] }

/** A data folder whose migration failed: old data at schema 20, its pre-update copy, a pinned problem. */
function failedUpgrade(t: { after(fn: () => void): void }): Setup {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-repair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(dir, 'workforce.db');
  const db = new Db(file);
  migrate(db, { until: 20 });
  db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_1', 'Mira', 'm', 'human', 1, 1)`);
  db.close();
  const journal = new BootJournal({ dataDir: dir, now: () => 50 });
  journal.begin('0.9.0');
  let thrown: unknown;
  try { openDatabase({ file, dataDir: dir, version: '0.9.0', now: () => 40, migrateFn: (target) => { migrate(target, { until: 24 }); throw new Error('no such column: foo (api_key=sk-test-abcdefghijklmnopqrstuv)'); } }); } catch (error) { thrown = error; }
  const problem = journal.failed(thrown, '0.9.0')!;
  mkdirSync(path.join(dir, 'logs'), { recursive: true });
  writeFileSync(path.join(dir, 'logs', 'runtime.log'), '{"msg":"runtime starting"}\n{"msg":"mail anna@example.com","token":"Bearer abcdefghijklmnopqrstuvwxyz"}\n');
  let restarts = 0;
  const opened: string[] = [];
  const host = {
    kind: 'electron', app: { version: '0.9.0', packaged: true, resourcesDir: dir, dataDir: dir, executable: 'x' },
    restart: async () => { restarts++; },
    openPath: async (target: string) => { opened.push(target); },
  } as unknown as Host;
  return { dir, journal, problem, host, restarts: () => restarts, opened };
}

function client(attach: (connection: ReturnType<typeof memoryConnection>['server']) => void) {
  const pair = memoryConnection();
  attach(pair.server);
  let id = 0;
  return async <T>(method: string, params?: unknown): Promise<T> => {
    const mine = ++id;
    const response = await new Promise<{ result?: unknown; error?: { code: string; message: string } }>((resolve) => {
      const off = pair.client.onFrame((frame) => { const reply = frame as { id?: number }; if (reply.id === mine) { off(); resolve(frame as never); } });
      pair.client.send(params === undefined ? { id: mine, method } : { id: mine, method, params });
    });
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result as T;
  };
}

test('repair mode serves only session.info and repair.*; the state names the problem and the pre-update copy', async (t) => {
  const setup = failedUpgrade(t);
  assert.equal(setup.problem.code, 'migration_failed');
  assert.doesNotMatch(setup.problem.detail ?? '', /sk-test/, 'the error line is redacted');
  const repair = startRepairRuntime({ dataDir: setup.dir, version: '0.9.0', host: setup.host, journal: setup.journal, problem: setup.problem });
  t.after(() => repair.close());
  const call = client((connection) => repair.attach(connection));
  const session = await call<{ allowedMethods: string[] }>('session.info');
  assert.deepEqual(session.allowedMethods.sort(), ['repair.diagnostics', 'repair.restore', 'repair.retry', 'repair.state', 'session.info']);
  await assert.rejects(call('settings.get'), /Unknown method/);
  const state = await call<RepairState>('repair.state');
  assert.equal(state.active, true);
  assert.equal(state.problem?.code, 'migration_failed');
  assert.equal(state.problem?.dataSchema, 24);
  assert.equal(state.appSchema, SCHEMA_VERSION);
  assert.deepEqual(state.backups.map((info) => [info.id, info.schema]), [['0.9.0-s20', 20]]);
});

test('diagnostics: one redacted file, shown in the file manager', async (t) => {
  const setup = failedUpgrade(t);
  const repair = startRepairRuntime({ dataDir: setup.dir, version: '0.9.0', host: setup.host, journal: setup.journal, problem: setup.problem });
  t.after(() => repair.close());
  const call = client((connection) => repair.attach(connection));
  const result = await call<{ path: string; bytes: number }>('repair.diagnostics');
  assert.ok(result.path.startsWith(path.join(setup.dir, 'diagnostics')));
  assert.deepEqual(setup.opened, [result.path]);
  const text = readFileSync(result.path, 'utf8');
  assert.match(text, /App version: 0\.9\.0/);
  assert.match(text, new RegExp(`Data schema: 24 \\(this app: ${SCHEMA_VERSION}\\)`));
  assert.match(text, /Start problem: migration_failed/);
  assert.match(text, /0\.9\.0-s20: version 0\.9\.0, schema 20/);
  assert.match(text, /runtime starting/);
  assert.doesNotMatch(text, /anna@example\.com|abcdefghijklmnopqrstuvwxyz|sk-test-abc/, 'no addresses, tokens or keys');
});

test('restore: the live database moves aside, the copy comes back, the problem is cleared and the runtime restarts', async (t) => {
  const setup = failedUpgrade(t);
  const repair = startRepairRuntime({ dataDir: setup.dir, version: '0.9.0', host: setup.host, journal: setup.journal, problem: setup.problem });
  t.after(() => repair.close());
  const call = client((connection) => repair.attach(connection));
  await assert.rejects(call('repair.restore', { id: '../../etc' }), /no longer there/);
  const result = await call<{ ok: true; kept: string }>('repair.restore', { id: '0.9.0-s20' });
  assert.equal(setup.restarts(), 1);
  assert.ok(existsSync(path.join(result.kept, 'workforce.db')), 'the replaced data is kept');
  const live = new DatabaseSync(path.join(setup.dir, 'workforce.db'), { readOnly: true });
  try {
    assert.equal((live.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string }).value, '20');
    assert.equal((live.prepare(`SELECT name FROM agents WHERE id = 'ag_1'`).get() as { name: string }).name, 'Mira');
  } finally { live.close(); }
  assert.deepEqual(setup.journal.begin('0.9.0'), { attempt: 1 }, 'the next start runs normally');
});

test('retry clears the problem and restarts; a double click does not run twice; a normal runtime refuses both', async (t) => {
  const setup = failedUpgrade(t);
  const repair = startRepairRuntime({ dataDir: setup.dir, version: '0.9.0', host: setup.host, journal: setup.journal, problem: setup.problem });
  t.after(() => repair.close());
  const call = client((connection) => repair.attach(connection));
  const [first, second] = await Promise.allSettled([call('repair.retry'), call('repair.retry')]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(setup.restarts(), 1);
  assert.equal(setup.journal.problem('0.9.0'), undefined);

  const services = { paths: { data: setup.dir }, host: setup.host, clock: { now: () => 1 }, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as RuntimeServices;
  const normal = repairOf({ services });
  assert.equal(normal.state().active, false);
  assert.deepEqual(normal.state().backups.map((info) => info.id), ['0.9.0-s20'], 'the copies are listed on a normal runtime too');
  await assert.rejects(normal.retry(), (error: unknown) => error instanceof WorkforceError && error.code === 'conflict');
  await assert.rejects(normal.restore('0.9.0-s20'), (error: unknown) => error instanceof WorkforceError && error.code === 'conflict');
  assert.equal(setup.restarts(), 1);
});
