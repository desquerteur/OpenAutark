// Migration 80 (owner correction 29.10.2026, no site restriction at all): every binding on a non-card entry goes – the
// person's 'Only on', a first-use binding, the app's own – and its first rule becomes the source when there is none;
// card data (a card, a card group, a group holding a card field) keeps its shop. Values stay. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const row = (db: Db, table: string, id: string) => ({ ...db.get<{ domains: string; source: string | null }>(`SELECT domains, source FROM ${table} WHERE id = ?`, [id])! });

test('migration 80: no entry but card data keeps a site binding; the first rule becomes its source', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 79 });
  const secret = (id: string, kind: string, domains: string, source: string | null) =>
    db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, source) VALUES (?, 'Entry', ?, x'01', '["*"]', ?, 1, ?)`, [id, kind, domains, source]);
  secret('sec_person', 'password', '["bank.example"]', null); // the person's 'Only on' or a first use
  secret('sec_wild', 'api_key', '["*.Example.com","sso.example"]', null);
  secret('sec_www', 'password', '["www.bank.example"]', null);
  secret('sec_sourced', 'password', '["other.example"]', 'forum.example'); // a source stays
  secret('sec_odd', 'note', 'not json', null);
  secret('sec_free', 'token', '[]', null);
  secret('sec_card', 'card', '["shop.example"]', null);
  const group = (id: string, kind: string, domains: string) =>
    db.run(`INSERT INTO secret_groups (id, label, kind, agents, domains, created_at) VALUES (?, 'Login', ?, '["*"]', ?, 1)`, [id, kind, domains]);
  group('sgr_login', 'login', '["example.com"]');
  group('sgr_card', 'card', '["shop.example"]');
  group('sgr_other_card', 'other', '["shop.example"]');
  db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, group_id, field) VALUES ('sec_in_card', 'Card · number', 'card', x'02', '[]', '[]', 1, 'sgr_other_card', 'number')`);

  migrate(db, { until: 80 }); // migration 81 (owner 29.10.2026, card data included) drops the rest – migration-81.test.ts
  assert.deepEqual(row(db, 'secrets', 'sec_person'), { domains: '[]', source: 'bank.example' });
  assert.deepEqual(row(db, 'secrets', 'sec_wild'), { domains: '[]', source: 'example.com' });
  assert.deepEqual(row(db, 'secrets', 'sec_www'), { domains: '[]', source: 'bank.example' });
  assert.deepEqual(row(db, 'secrets', 'sec_sourced'), { domains: '[]', source: 'forum.example' });
  assert.deepEqual(row(db, 'secrets', 'sec_odd'), { domains: '[]', source: null });
  assert.deepEqual(row(db, 'secrets', 'sec_free'), { domains: '[]', source: null });
  assert.deepEqual(row(db, 'secrets', 'sec_card'), { domains: '["shop.example"]', source: null }, 'a card keeps its shop');
  assert.deepEqual(row(db, 'secret_groups', 'sgr_login'), { domains: '[]', source: 'example.com' });
  assert.equal(row(db, 'secret_groups', 'sgr_card').domains, '["shop.example"]');
  assert.equal(row(db, 'secret_groups', 'sgr_other_card').domains, '["shop.example"]', 'a group holding a card keeps its shop');
  assert.equal(db.get<{ n: number }>(`SELECT length(cipher) AS n FROM secrets WHERE id = 'sec_person'`)!.n, 1, 'values stay');
  assert.ok(SCHEMA_VERSION >= 80);
});
