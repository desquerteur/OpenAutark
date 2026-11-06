// R4 contracts schema: migrations 2–4 (media + media_fts, agents.based_on, bridges), the
// upgrade path from a schema-1 database, the list order of all migrations (db/migrate.ts: ascending,
// gap numbers unused), and that AgentRepo leaves the old based_on and budget columns alone.
// Owns: checks of the tables and the minimal agent mapping only (media/bridges behaviour is
// tested by their packages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { sql as initial } from '../../../src/runtime/db/migrations/001-initial.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { memoryDb } from './helpers.ts';

const FILE = 'f'.repeat(64);

function columns(db: Db, table: string): string[] {
  return db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name);
}

function agentRow(extra: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_1', name: 'Writer', role: '', avatar: { kind: 'initials', value: 'WR', color: 0 }, instructions: '', mode: 'general',
    skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 1, updatedAt: 1, ...extra,
  };
}

test('a fresh database has the media, media_fts and bridges tables and agents.based_on (kept, unused)', () => {
  const db = memoryDb();
  assert.ok(SCHEMA_VERSION >= 4, 'R4 tables exist from version 4 on (005 renews sessions)');
  assert.deepEqual(columns(db, 'media'), [
    'file_id', 'conversation_id', 'kind', 'mime', 'name', 'width', 'height', 'duration_ms', 'pages',
    'description', 'tags', 'described_by', 'described_at', 'created_at', 'updated_at',
    'colors', 'peak_db', 'rms_db', 'silent', 'loudness_partial', 'measured_at', // MM5 (migration 031)
  ]);
  assert.deepEqual(columns(db, 'bridges'), [
    'id', 'kind', 'conversation_id', 'secret_id', 'external_chat_id', 'cursor', 'status', 'error', 'created_at', 'updated_at',
    'owner_user_id', 'owner_name', 'owner_linked_at', // C9 (migration 011)
  ]);
  assert.ok(columns(db, 'agents').includes('based_on'));
  assert.deepEqual(columns(db, 'media_fts'), ['file_id', 'name', 'description', 'tags']);
});

test('a schema-1 database upgrades to the latest schema and keeps its rows', () => {
  const db = new Db(':memory:');
  db.exec(initial);
  db.run(`INSERT INTO meta (key, value) VALUES ('schema', '1')`);
  // A row written by an app before R4 (no based_on column yet), so inserted directly.
  db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_1', 'Writer', '{}', 'human', 1, 1)`);
  assert.deepEqual(migrate(db), { from: 1, to: SCHEMA_VERSION });
  const agent = new AgentRepo(db).get('ag_1');
  assert.equal(agent?.name, 'Writer');
  assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }); // idempotent
});

test('migrations apply in ascending list order; the unused gap numbers are not needed to upgrade', () => {
  const db = new Db(':memory:');
  const recorded = () => Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)?.value ?? 0);
  const steps: number[] = [];
  for (let until = 1; until <= SCHEMA_VERSION; until++) { migrate(db, { until }); steps.push(recorded()); }
  steps.forEach((value, index) => {
    assert.ok(value <= index + 1, `nothing above ${index + 1} applied yet`);
    if (index) assert.ok(value >= steps[index - 1], `the recorded version never goes back (step ${index + 1})`);
  });
  assert.equal(steps.at(-1), SCHEMA_VERSION);
  assert.deepEqual([54, 57].map((until) => steps[until - 1]), [50, 55], 'the gaps 51–54 and 56–57 hold no migration');
  const profile = new Db(':memory:');
  migrate(profile, { until: 55 });
  assert.deepEqual(migrate(profile), { from: 55, to: SCHEMA_VERSION }, 'a profile at 55 upgrades through the rest');
});

test('media rows reference stored files and are searchable through media_fts', () => {
  const db = memoryDb();
  const insertMedia = () => db.run(
    `INSERT INTO media (file_id, kind, mime, name, tags, created_at, updated_at) VALUES (?, 'image', 'image/png', 'logo.png', '["brand"]', 1, 1)`, [FILE],
  );
  assert.throws(insertMedia, /FOREIGN KEY/); // no file row yet
  db.run(`INSERT INTO files (id, name, mime, size, created_at) VALUES (?, 'logo.png', 'image/png', 3, 1)`, [FILE]);
  insertMedia();
  db.run('INSERT INTO media_fts (file_id, name, description, tags) VALUES (?, ?, ?, ?)', [FILE, 'logo.png', 'Blue company logo', 'brand']);
  const hits = db.all<{ file_id: string }>(`SELECT file_id FROM media_fts WHERE media_fts MATCH 'logo'`);
  assert.deepEqual(hits.map((hit) => hit.file_id), [FILE]);
});

test('bridges belong to a chat and disappear with it', () => {
  const db = memoryDb();
  db.run(`INSERT INTO conversations (id, title, created_by, created_at, updated_at) VALUES ('ch_1', 'Ops', 'human', 1, 1)`);
  db.run(
    `INSERT INTO bridges (id, kind, conversation_id, secret_id, external_chat_id, status, created_at, updated_at)
     VALUES ('br_1', 'telegram', 'ch_1', 'sec_1', '12345', 'connecting', 1, 1)`,
  );
  assert.throws(() => db.run(
    `INSERT INTO bridges (id, kind, conversation_id, secret_id, external_chat_id, status, created_at, updated_at)
     VALUES ('br_2', 'telegram', 'ch_missing', 'sec_1', '12345', 'connecting', 1, 1)`,
  ), /FOREIGN KEY/);
  db.run(`DELETE FROM conversations WHERE id = 'ch_1'`);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bridges')?.n, 0);
});

test('AgentRepo neither reads nor writes the old based_on and budget columns', () => {
  const db = memoryDb();
  const repo = new AgentRepo(db);
  repo.save(agentRow());
  db.run(`UPDATE agents SET based_on = 'ag_origin', budget = '{"monthlyUsd":20}' WHERE id = 'ag_1'`);
  assert.deepEqual(repo.get('ag_1'), agentRow()); // the stored values do not show up on the agent
  repo.save({ ...repo.get('ag_1')!, name: 'Editor', updatedAt: 2 });
  assert.equal(repo.get('ag_1')?.name, 'Editor');
  assert.deepEqual({ ...db.get('SELECT based_on, budget FROM agents WHERE id = ?', ['ag_1'])! }, { based_on: 'ag_origin', budget: '{"monthlyUsd":20}' }); // an update leaves them as they were
  repo.save(agentRow({ id: 'ag_2', name: 'Plain' }));
  assert.deepEqual({ ...db.get('SELECT based_on, budget FROM agents WHERE id = ?', ['ag_2'])! }, { based_on: null, budget: '{}' }); // a new row takes the defaults
});
