// Migration 87 (runtime/db/migrations/087-simple-leftovers.ts): the dead tables of the removed ledger, task center,
// companions, skill history, calls, media segments and overlay go with their rows; the dead kv namespaces and the
// mode-switch counters go; other kv rows and the old settings table (moved into settings.json at a start) stay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const tables = (db: Db) => new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
const kvKeys = (db: Db) => db.all<{ ns: string; key: string }>('SELECT ns, key FROM kv ORDER BY ns, key').map((row) => `${row.ns}/${row.key}`);

test('migration 89 brings the context ledger back after 87 dropped it', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 88 });
  assert.ok(!tables(db).has('context_items'));
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 89);
  assert.ok(tables(db).has('context_items'));
});

test('migration 87 drops the dead tables and kv rows, keeps the rest', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 86 });
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES
    ('subconscious', 'tips-direct:ag_1', '{}', 0), ('tasks.compete', 'tk_1', '{}', 0), ('vocabulary', 'asked', '[]', 0),
    ('modes', 'switches:ag_1', '3', 0), ('modes', 'other', '1', 0), ('catalog', 'acc_1', '{}', 0), ('customize', 'x', '{}', 0)`);
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('profile', '{"name":"Ada"}', 0)`);

  migrate(db);
  assert.ok(SCHEMA_VERSION >= 87);
  const left = tables(db);
  for (const gone of ['model_outcomes', 'playbook_drafts', 'playbook_work', 'task_routes', 'task_subscriptions', 'task_news',
    'companions', 'companion_rounds', 'skill_versions', 'skill_audience', 'skill_loads', 'skill_origins', 'media_segments', 'media_segments_fts',
    'media_vectors', 'calls', 'call_usage', 'customizations', 'remote_audit']) assert.ok(!left.has(gone), gone);
  for (const kept of ['settings', 'media', 'kv', 'team_patterns']) assert.ok(left.has(kept), kept);
  assert.deepEqual(kvKeys(db), ['catalog/acc_1', 'modes/other']);
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger'").length, 0, 'no trigger points at a dropped table');
  assert.equal(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'profile'")?.value, '{"name":"Ada"}');
});
