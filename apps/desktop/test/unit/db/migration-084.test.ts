// B-057 migration 84 (runtime/db/migrations/084-agent-splits.ts): the split_groups and splits tables with their
// indexes, runs.split_id with its partial index, existing runs untouched, applied once.
// Owns: checks of that schema step on migrate({until: 82}) fixtures. Never: split behaviour (test/unit/splits/**).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const T = 1_700_000_000_000;
const columns = (db: Db, table: string) => db.all<{ name: string; notnull: number; dflt_value: string | null }>(`SELECT name, "notnull", dflt_value FROM pragma_table_info('${table}')`);
const indexes = (db: Db, table: string) => db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`, [table]).map((row) => row.name);
const schema = (db: Db) => Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)?.value);

function fixture(): Db {
  const db = new Db(':memory:');
  migrate(db, { until: 82 });
  db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at) VALUES ('ag_ava', 'Ava', '{}', 'human', 0, 0)`);
  db.run(`INSERT INTO runs (id, agent_id, trigger, status, started_at) VALUES ('rn_old', 'ag_ava', 'message', 'done', ?)`, [T]);
  return db;
}

test('migration 84 adds split_groups, splits and runs.split_id; old runs keep their rows', () => {
  const db = fixture();
  assert.equal(schema(db), 82);
  assert.deepEqual(migrate(db), { from: 82, to: SCHEMA_VERSION });
  assert.ok(SCHEMA_VERSION >= 84);
  assert.equal(schema(db), SCHEMA_VERSION);

  assert.deepEqual(columns(db, 'split_groups').map((c) => c.name), [
    'id', 'agent_id', 'parent_run_id', 'conversation_id', 'task_id', 'source', 'source_label', 'thread', 'mode_key', 'cwd', 'goal',
    'ultra', 'status', 'created_at', 'started_at', 'ended_at', 'gathered_at',
  ]);
  assert.deepEqual(columns(db, 'splits').map((c) => c.name), [
    'id', 'group_id', 'agent_id', 'idx', 'title', 'brief', 'returns', 'context', 'model', 'effort', 'after', 'worktree', 'fork', 'branch',
    'status', 'attempts', 'error', 'created_at', 'started_at', 'ended_at',
  ]);
  const split = Object.fromEntries(columns(db, 'splits').map((c) => [c.name, c]));
  assert.equal(split.after.dflt_value, `'[]'`);
  assert.equal(split.context.dflt_value, `'fork'`);
  assert.equal(split.status.dflt_value, `'pending'`);
  assert.deepEqual(indexes(db, 'split_groups'), ['split_groups_agent', 'split_groups_parent', 'split_groups_thread']);
  assert.deepEqual(indexes(db, 'splits'), ['splits_agent_status']);
  assert.ok(indexes(db, 'runs').includes('runs_split'));
  const runs = columns(db, 'runs');
  assert.equal(runs.find((c) => c.name === 'split_id')?.notnull, 0);
  assert.equal(db.get<{ split_id: string | null }>(`SELECT split_id FROM runs WHERE id = 'rn_old'`)?.split_id, null);
  assert.equal(db.all('PRAGMA foreign_key_check').length, 0);
});

test('the tables are STRICT, keyed and linked: idx unique per group, a group goes with its agent', () => {
  const db = fixture();
  migrate(db);
  db.run(`INSERT INTO split_groups (id, agent_id, parent_run_id, thread, goal, created_at) VALUES ('sg_1', 'ag_ava', 'rn_old', 'cv_1', 'Goal', ?)`, [T]);
  db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('sp_1', 'sg_1', 'ag_ava', 1, 'One', 'Brief', ?)`, [T]);
  const row = db.get<{ after: string; worktree: number; attempts: number; status: string; context: string }>(`SELECT "after", worktree, attempts, status, context FROM splits WHERE id = 'sp_1'`);
  assert.deepEqual({ ...row }, { after: '[]', worktree: 0, attempts: 0, status: 'pending', context: 'fork' });
  assert.equal(db.get<{ ultra: number; status: string }>(`SELECT ultra, status FROM split_groups WHERE id = 'sg_1'`)?.status, 'pending');
  assert.throws(() => db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('sp_2', 'sg_1', 'ag_ava', 1, 'Two', 'Brief', ?)`, [T]), /UNIQUE/);
  assert.throws(() => db.run(`INSERT INTO splits (id, group_id, agent_id, idx, title, brief, created_at) VALUES ('sp_3', 'sg_1', 'ag_ava', 'two', 'Two', 'Brief', ?)`, [T]), /cannot store TEXT value in INTEGER column/, 'STRICT');
  assert.throws(() => db.run(`INSERT INTO split_groups (id, agent_id, parent_run_id, thread, goal, created_at) VALUES ('sg_x', 'ag_none', 'rn_old', 'cv_1', 'Goal', ?)`, [T]), /FOREIGN KEY/);
  db.run(`DELETE FROM agents WHERE id = 'ag_ava'`);
  assert.equal(db.all(`SELECT id FROM split_groups`).length, 0);
  assert.equal(db.all(`SELECT id FROM splits`).length, 0);
});

test('migration 84 is applied once, and only as 84', () => {
  const db = fixture();
  migrate(db);
  assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }, 'applied once');
  const steps = new Db(':memory:');
  migrate(steps, { until: 83 });
  assert.ok(schema(steps) < 84);
  assert.equal(columns(steps, 'splits').length, 0, 'no split table before 84');
  migrate(steps, { until: 84 });
  assert.equal(schema(steps), 84);
  assert.ok(columns(steps, 'runs').some((c) => c.name === 'split_id'));
});
