// Migration 79 (owner decision 29.10.2026, secrets usable everywhere): the automatic binding agents' tools wrote (an
// agent's own single secret or login, or a form answer's fixed-id entry, with exactly one plain domain) becomes its `source` and the restriction goes; a
// card keeps its domains (also inside a group), and so do the person's entries, the app's own, several domains, a
// "*." or www rule and an invalid list. Values stay. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const row = (db: Db, table: string, id: string) => ({ ...db.get<{ domains: string; source: string | null }>(`SELECT domains, source FROM ${table} WHERE id = ?`, [id])! });

test('migration 79: agents\' automatic bindings become the source; restrictions the person may have set stay', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 78 });
  const secret = (id: string, kind: string, domains: string, createdBy: string | null) =>
    db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, created_by) VALUES (?, 'Entry', ?, x'01', '["ag_mira"]', ?, 1, ?)`, [id, kind, domains, createdBy]);
  secret('sec_saved', 'api_key', '["stripe-test.example"]', 'ag_mira'); // browser.save_secret
  secret('sec_generated', 'password', '["example.com"]', 'ag_mira'); // secrets.generate
  secret('sec_card', 'card', '["shop.example"]', 'ag_mira');
  secret('sec_person', 'password', '["bank.example"]', null); // the person's (or a first use) – cannot be told apart
  secret('sec_system', 'token', '["calendar.example"]', 'system');
  secret('sec_two', 'password', '["example.com","sso.example"]', 'ag_mira');
  secret('sec_wild', 'password', '["*.example.com"]', 'ag_mira');
  secret('sec_www', 'password', '["www.bank.example"]', 'ag_mira');
  secret('sec_odd', 'password', 'not json', 'ag_mira');
  secret('sec_0123456789abcdef01234567', 'password', '["shop.example"]', null); // a form answer (fixed hash id)
  secret('sec_01jab3k9z7mx2c4qrstv', 'password', '["shop.example"]', null); // Settings (time-based id): the person's
  secret('sec_0123456789abcdef0123456z', 'password', '["shop.example"]', null); // not hex: not a form answer
  const group = (id: string, kind: string, domains: string, createdBy: string | null) =>
    db.run(`INSERT INTO secret_groups (id, label, kind, agents, domains, created_at, created_by) VALUES (?, 'Login', ?, '["ag_mira"]', ?, 1, ?)`, [id, kind, domains, createdBy]);
  group('sgr_login', 'login', '["example.com"]', 'ag_mira'); // browser.save_totp / secrets.generate with username
  group('sgr_person', 'login', '["example.com"]', null);
  group('sgr_0123456789abcdef01234567', 'login', '["shop.example"]', null); // a form's login (fixed hash id)
  group('sgr_card', 'card', '["shop.example"]', 'ag_mira');
  group('sgr_other_card', 'other', '["shop.example"]', 'ag_mira');
  db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, group_id, field) VALUES ('sec_in_card', 'Card · number', 'card', x'02', '[]', '[]', 1, 'sgr_other_card', 'number')`);

  migrate(db, { until: 79 }); // migration 80 then drops every non-card binding (migration-80.test.ts)
  assert.deepEqual(row(db, 'secrets', 'sec_saved'), { domains: '[]', source: 'stripe-test.example' });
  assert.deepEqual(row(db, 'secrets', 'sec_generated'), { domains: '[]', source: 'example.com' });
  assert.deepEqual(row(db, 'secret_groups', 'sgr_login'), { domains: '[]', source: 'example.com' });
  assert.deepEqual(row(db, 'secrets', 'sec_0123456789abcdef01234567'), { domains: '[]', source: 'shop.example' }, 'a form answer\'s field domain was automatic');
  assert.deepEqual(row(db, 'secret_groups', 'sgr_0123456789abcdef01234567'), { domains: '[]', source: 'shop.example' });
  for (const id of ['sec_01jab3k9z7mx2c4qrstv', 'sec_0123456789abcdef0123456z']) assert.deepEqual(row(db, 'secrets', id), { domains: '["shop.example"]', source: null }, id);
  for (const id of ['sec_card', 'sec_person', 'sec_system', 'sec_two', 'sec_wild', 'sec_www', 'sec_odd']) assert.equal(row(db, 'secrets', id).source, null, id);
  assert.equal(row(db, 'secrets', 'sec_card').domains, '["shop.example"]', 'a card keeps its shop');
  assert.equal(row(db, 'secrets', 'sec_person').domains, '["bank.example"]', 'the person\'s stays');
  assert.equal(row(db, 'secrets', 'sec_two').domains, '["example.com","sso.example"]');
  assert.equal(row(db, 'secrets', 'sec_odd').domains, 'not json', 'an invalid list is left alone');
  for (const id of ['sgr_person', 'sgr_card', 'sgr_other_card']) assert.equal(row(db, 'secret_groups', id).source, null, id);
  assert.equal(row(db, 'secret_groups', 'sgr_other_card').domains, '["shop.example"]', 'a group holding a card keeps its shop');
  assert.equal(db.get<{ n: number }>(`SELECT length(cipher) AS n FROM secrets WHERE id = 'sec_saved'`)!.n, 1, 'values stay');
  assert.ok(SCHEMA_VERSION >= 79);
});
