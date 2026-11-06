// Migration 81 (owner 29.10.2026 – a catalog like a skill with zero restrictions, card data included): every remaining
// binding goes – a card's and a card group's too – and its first rule becomes the source when there is none; every single
// secret and group gets its route (card data → payment, server words → servers, keys and tokens → keys, sign-ins →
// logins, the rest → notes) and empty tags; a grouped field's own route stays empty. Values stay.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

type Row = { domains: string; source: string | null; route: string | null; tags: string };
const row = (db: Db, table: string, id: string) => ({ ...db.get<Row>(`SELECT domains, source, route, tags FROM ${table} WHERE id = ?`, [id])! });

test('migration 81: no binding is left (cards included); the first rule becomes the source; routes and tags are set', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 80 });
  const secret = (id: string, kind: string, domains: string, source: string | null, label = 'Entry', description = '') =>
    db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, source, description) VALUES (?, ?, ?, x'01', '["*"]', ?, 1, ?, ?)`, [id, label, kind, domains, source, description]);
  secret('sec_card', 'card', '["*.Shop.example", "pay.example"]', null);
  secret('sec_card_sourced', 'card', '["pay.example"]', 'shop.example');
  secret('sec_key', 'api_key', '[]', null);
  secret('sec_pw', 'password', '[]', null);
  secret('sec_server', 'password', '[]', null, 'Build box', 'SSH login of the build server');
  secret('sec_note', 'note', '[]', null);
  const group = (id: string, kind: string, domains: string) =>
    db.run(`INSERT INTO secret_groups (id, label, kind, agents, domains, created_at) VALUES (?, 'Group', ?, '["*"]', ?, 1)`, [id, kind, domains]);
  group('sgr_card', 'card', '["www.shop.example"]');
  group('sgr_other_card', 'other', '["shop.example"]');
  group('sgr_login', 'login', '[]');
  group('sgr_other', 'other', '[]');
  db.run(`INSERT INTO secrets (id, label, kind, cipher, agents, domains, created_at, group_id, field) VALUES ('sec_in_card', 'Card · number', 'card', x'02', '[]', '[]', 1, 'sgr_other_card', 'number')`);

  migrate(db);
  assert.deepEqual(row(db, 'secrets', 'sec_card'), { domains: '[]', source: 'shop.example', route: 'payment', tags: '["for the web at shop.example","for the web at pay.example"]' }, 'a card keeps no shop; every rule stays as a tag');
  assert.deepEqual(row(db, 'secrets', 'sec_card_sourced'), { domains: '[]', source: 'shop.example', route: 'payment', tags: '["for the web at pay.example"]' }, 'a source stays; the rule becomes a tag');
  assert.deepEqual([row(db, 'secrets', 'sec_key').route, row(db, 'secrets', 'sec_pw').route, row(db, 'secrets', 'sec_server').route, row(db, 'secrets', 'sec_note').route], ['keys', 'logins', 'servers', 'notes']);
  assert.deepEqual(row(db, 'secret_groups', 'sgr_card'), { domains: '[]', source: 'shop.example', route: 'payment', tags: '["for the web at shop.example"]' });
  assert.equal(row(db, 'secrets', 'sec_key').tags, '[]', 'no rule, no tag');
  assert.deepEqual([row(db, 'secret_groups', 'sgr_other_card').domains, row(db, 'secret_groups', 'sgr_other_card').route], ['[]', 'payment'], 'a group holding a card');
  assert.deepEqual([row(db, 'secret_groups', 'sgr_login').route, row(db, 'secret_groups', 'sgr_other').route], ['logins', 'notes']);
  assert.equal(row(db, 'secrets', 'sec_in_card').route, null, 'a field follows its group');
  assert.equal(db.get<{ n: number }>(`SELECT count(*) AS n FROM secrets WHERE domains <> '[]'`)!.n + db.get<{ n: number }>(`SELECT count(*) AS n FROM secret_groups WHERE domains <> '[]'`)!.n, 0, 'nothing bound anywhere');
  assert.equal(db.get<{ n: number }>(`SELECT length(cipher) AS n FROM secrets WHERE id = 'sec_card'`)!.n, 1, 'values stay');
  assert.ok(SCHEMA_VERSION >= 81);
});
