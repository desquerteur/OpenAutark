// Migration 74 (B-044, secret area leftovers): the 'branch:<id>' entries go from the access lists of single secrets
// and groups (the other entries stay in order, a list without one is untouched, an invalid list does not stop the
// migration), the area rows and the grant audit go; the tables stay, and so do values, domains and paths.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const count = (db: Db, table: string): number => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const agents = (db: Db, table: string, id: string): string => db.get<{ agents: string }>(`SELECT agents FROM ${table} WHERE id = ?`, [id])!.agents;

test('migration 74: branch grants, secret area rows and the grant audit go, everything else stays', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 73 });
  const secret = (id: string, list: string) => db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, path) VALUES (?, 'Key', 'api_key', x'01', ?, '["api.example.com"]', 1, '/company/mail')`, [id, list]);
  secret('sec_mixed', '["ag_ana","branch:ag_boss","*"]');
  secret('sec_branch', '["branch:ag_boss"]');
  secret('sec_plain', '["ag_ana"]');
  secret('sec_odd', 'not json "branch:x');
  db.run(`INSERT INTO secret_groups (id, label, kind, agents, domains, created_at) VALUES ('sgr_1', 'Login', 'login', '["branch:ag_boss","ag_ben"]', '[]', 1)`);
  db.run(`INSERT INTO secret_areas (path, description, agents, created_by, created_at, updated_at) VALUES ('/company', 'Company mail and banking', '["*"]', 'human', 1, 1)`);
  db.run(`INSERT INTO secret_grant_log (at, target, label, grant_entry, action, by) VALUES (1, 'sec_branch', 'Key', 'branch:ag_boss', 'added', 'human')`);

  migrate(db, { until: 74 }); // migration 80 (29.10.2026) later drops non-card domains – not this one's business
  assert.equal(agents(db, 'secrets', 'sec_mixed'), '["ag_ana","*"]', 'the other entries stay in order');
  assert.equal(agents(db, 'secrets', 'sec_branch'), '[]', 'a branch grant gave nothing: now the list says so');
  assert.equal(agents(db, 'secrets', 'sec_plain'), '["ag_ana"]');
  assert.equal(agents(db, 'secrets', 'sec_odd'), 'not json "branch:x', 'an invalid list is left alone');
  assert.equal(agents(db, 'secret_groups', 'sgr_1'), '["ag_ben"]');
  assert.equal(count(db, 'secret_areas'), 0, 'the table stays, empty');
  assert.equal(count(db, 'secret_grant_log'), 0, 'the table stays, empty');
  const row = db.get<{ domains: string; path: string; n: number }>(`SELECT domains, path, length(cipher) AS n FROM secrets WHERE id = 'sec_mixed'`)!;
  assert.deepEqual([row.domains, row.path, row.n], ['["api.example.com"]', '/company/mail', 1], 'values, domains and paths stay');
  assert.ok(SCHEMA_VERSION >= 74);
});
