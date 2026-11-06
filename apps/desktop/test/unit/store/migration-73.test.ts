// Migration 73 (B-044, knowledge leftovers): the X04 change wishes (kv 'wishes', 'wishes.scan',
// 'wishes.meta'), the removed review rules' check rows (knowledge_checks) and kv marks ('lifecycle'
// 'backfilled', 'backfill-cursor', 'batch:…') and the reference capture policies (reference_policies)
// go; the tables stay, and notes, reference grants, the "Corrected memory" seen marks and every other
// kv row stay. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';

const count = (db: Db, table: string): number => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;

test('migration 73: wishes, check rows and marks and capture policies go, everything else stays', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 72 });
  const kv = new KvRepo(db);
  kv.set('wishes', 'cw_1', { id: 'cw_1', conversationId: 'ch_1', text: 'Make the sidebar narrower', createdAt: 1 }, 1);
  kv.set('wishes.scan', 'ch_1', 12, 1);
  kv.set('wishes.meta', 'state', { recent: [1], dismissStreak: 0 }, 1);
  kv.set('lifecycle', 'backfilled', 1, 1);
  kv.set('lifecycle', 'backfill-cursor', 40, 1);
  kv.set('lifecycle', 'batch:ag_ana', 1, 1);
  kv.set('lifecycle', 'seen:ag_ana:ch_1:kn_1', 1, 1);
  kv.set('wishesque', 'other', 'kept', 1);
  kv.set('pwa', 'vapid', 'cipher', 1);
  db.run(`INSERT INTO knowledge (id, scope, kind, title, body, source, created_by, recorded_at, valid_from) VALUES ('kn_1', 'global', 'fact', 'Price', 'The VPS costs 12 EUR', '{"kind":"human","trusted":true}', 'human', 1, 1)`);
  db.run(`INSERT INTO knowledge_checks (item_id, method, due_at, created_at) VALUES ('kn_1', 'source', 2, 1)`);
  db.run(`INSERT INTO reference_policies (subject, level, chats, auto_capture, updated_at, updated_by) VALUES ('human', 'selected', '["ch_1"]', 1, 1, 'human')`);
  db.run(`INSERT INTO reference_grants (subject, principal, rights, spheres, granted_at, granted_by) VALUES ('human', 'agent:ag_ana', '["retrieve"]', '[]', 1, 'human')`);

  migrate(db, { until: 73 }); // 86 removes more of the same rows later
  const after = new KvRepo(db);
  for (const [ns, key] of [['wishes', 'cw_1'], ['wishes.scan', 'ch_1'], ['wishes.meta', 'state'], ['lifecycle', 'backfilled'], ['lifecycle', 'backfill-cursor'], ['lifecycle', 'batch:ag_ana']]) {
    assert.equal(after.get(ns, key), undefined, `${ns} ${key}`);
  }
  assert.equal(after.get('lifecycle', 'seen:ag_ana:ch_1:kn_1'), 1, 'the Corrected-memory seen marks stay');
  assert.equal(after.get('wishesque', 'other'), 'kept', 'only the three wish namespaces');
  assert.equal(after.get('pwa', 'vapid'), 'cipher');
  assert.equal(count(db, 'knowledge_checks'), 0, 'the table stays, empty');
  assert.equal(count(db, 'reference_policies'), 0, 'the table stays, empty');
  assert.equal(count(db, 'knowledge'), 1, 'the note itself stays');
  assert.equal(count(db, 'reference_grants'), 1, 'reference grants stay');
  assert.ok(SCHEMA_VERSION >= 73);
});
