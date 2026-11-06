// B-054 migration 82: the tasks table rebuild (nullable chat, space_id, origin), the detached stand-in rows of the
// hidden To-do and Inbox chats, the wake/run origin columns, and the runner's foreignKeysOff flag.
// Owns: checks of that schema step on migrate({until: 81}) fixtures. Never: task behaviour (the tracks test that).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';

const T = 1_700_000_000_000;
const columns = (db: Db, table: string) => db.all<{ name: string; notnull: number }>(`SELECT name, "notnull" FROM pragma_table_info('${table}')`);
const count = (db: Db, table: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
const fk = (db: Db) => Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys);

function chat(db: Db, id: string, settings: object, space?: string): void {
  db.run(`INSERT INTO conversations (id, title, space_id, created_by, settings, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, ?, ?)`,
    [id, id, space ?? null, JSON.stringify(settings), T, T]);
}

function task(db: Db, id: string, conversationId: string, extra: { parent?: string; message?: string; title?: string; kind?: string } = {}): void {
  db.run(`INSERT INTO tasks (id, conversation_id, message_id, parent_id, title, assignee_kind, created_by, created_at, updated_at, private, "window")
          VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?, 0, '{"from":1}')`,
  [id, conversationId, extra.message ?? null, extra.parent ?? null, extra.title ?? `Title ${id}`, extra.kind ?? 'human', T, T]);
  const rowid = db.get<{ r: number }>('SELECT rowid AS r FROM tasks WHERE id = ?', [id])!.r;
  db.run('INSERT INTO tasks_fts (rowid, task_id, text) VALUES (?, ?, ?)', [rowid, id, (extra.title ?? `title ${id}`).toLowerCase()]);
}

/** A profile at schema 81 with a normal chat, the To-do chat, the Inbox chat and rows that reference tasks. */
function fixture(): Db {
  const db = new Db(':memory:');
  migrate(db, { until: 81 });
  chat(db, 'cv_work', {}, 'sp_work');
  chat(db, 'cv_todo', { hiddenFromList: true, system: 'todo' }, 'sp_home');
  chat(db, 'cv_inbox', { hiddenFromList: true, system: 'inbox' });
  task(db, 'tk_work', 'cv_work', { message: 'ms_anchor', title: 'Prepare the offer', kind: 'agent' });
  task(db, 'tk_work_step', 'cv_work', { parent: 'tk_work', title: 'Collect figures' });
  task(db, 'tk_todo', 'cv_todo', { message: 'ms_todo', title: 'Call the bank' });
  task(db, 'tk_todo_step', 'cv_todo', { parent: 'tk_todo', title: 'Find the number' });
  task(db, 'tk_inbox', 'cv_inbox', { message: 'ms_inbox', title: 'Book the venue', kind: 'team' });
  task(db, 'tk_inbox_step', 'cv_inbox', { parent: 'tk_inbox', title: 'Compare quotes', kind: 'team' });
  task(db, 'tk_inbox_free', 'cv_inbox', { title: 'Order paper', kind: 'team' });
  db.run(`INSERT INTO task_routes (task_id, origin, state, space_id, created_by, created_at, updated_at) VALUES ('tk_inbox', 'quick', 'routed', 'sp_route', 'human', ?, ?)`, [T, T]);
  db.run(`INSERT INTO task_news (agent_id, task_id, kind, source, at) VALUES ('ag_ava', 'tk_work', 'status', 'subscription', ?), ('ag_ava', 'tk_todo', 'status', 'subscription', ?)`, [T, T]);
  db.run(`INSERT INTO calendar_events (id, owner_id, kind, task_id, start_at, end_at, set_by, created_by, created_at, updated_at)
          VALUES ('ce_1', 'human', 'task', 'tk_todo', ?, ?, 'human', 'human', ?, ?)`, [T, T + 1, T, T]);
  db.run(`INSERT INTO wakes (id, agent_id, reason, due_at, created_at) VALUES ('wk_1', 'ag_ava', 'task', ?, ?)`, [T, T]);
  db.run(`INSERT INTO runs (id, agent_id, trigger, status, started_at) VALUES ('rn_1', 'ag_ava', 'task', 'done', ?)`, [T]);
  return db;
}

const COUNTED = ['tasks', 'task_news', 'calendar_events', 'task_routes', 'conversations', 'tasks_fts'];

test('migration 82 rebuilds tasks: same rows, rowids, FTS hits and references; conversation_id nullable', () => {
  const db = fixture();
  const before = Object.fromEntries(COUNTED.map((table) => [table, count(db, table)]));
  const rowids = db.all<{ id: string; r: number }>('SELECT id, rowid AS r FROM tasks ORDER BY id');
  const indexes = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE tbl_name = 'tasks' AND type = 'index' AND sql IS NOT NULL ORDER BY name`);

  assert.deepEqual(migrate(db, { until: 82 }), { from: 81, to: SCHEMA_VERSION }); // 87 drops task_news and task_routes later
  assert.ok(SCHEMA_VERSION >= 82);
  for (const table of COUNTED) assert.equal(count(db, table), before[table], table);
  assert.deepEqual(db.all('SELECT id, rowid AS r FROM tasks ORDER BY id').map((r) => ({ ...r })), rowids.map((r) => ({ ...r })));
  assert.deepEqual(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE tbl_name = 'tasks' AND type = 'index' AND sql IS NOT NULL ORDER BY name`).map((r) => r.name),
    indexes.map((r) => r.name));
  for (const name of ['tasks_board', 'tasks_conversation', 'tasks_assignee']) assert.ok(indexes.some((row) => row.name === name), name);
  assert.equal(db.all('PRAGMA foreign_key_check').length, 0);
  assert.equal(fk(db), 1, 'the runner restores foreign_keys = ON');

  const cols = columns(db, 'tasks');
  assert.equal(cols.find((c) => c.name === 'conversation_id')?.notnull, 0);
  assert.deepEqual(cols.slice(-3).map((c) => c.name), ['space_id', 'source', 'source_label']);
  assert.equal(db.get<{ w: string }>(`SELECT "window" AS w FROM tasks WHERE id = 'tk_todo'`)?.w, '{"from":1}', 'day fields copied');
  // FTS still finds the tasks through the kept rowids.
  const hit = (q: string) => db.all<{ id: string }>('SELECT t.id FROM tasks t WHERE t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?)', [q]).map((r) => r.id);
  assert.deepEqual(hit('bank'), ['tk_todo']);
  assert.deepEqual(hit('venue'), ['tk_inbox']);
  // The new FK: deleting a chat detaches (safety net), the parent FK still cascades.
  db.run(`DELETE FROM conversations WHERE id = 'cv_work'`);
  assert.equal(db.get<{ c: string | null }>(`SELECT conversation_id AS c FROM tasks WHERE id = 'tk_work'`)?.c, null);
  db.run(`DELETE FROM tasks WHERE id = 'tk_work'`);
  assert.equal(count(db, `tasks WHERE id = 'tk_work_step'`), 0, 'steps go with their parent');
  assert.equal(count(db, `task_news WHERE task_id = 'tk_work'`), 0, 'task_news still cascades');
});

test('migration 82 detaches the stand-in rows and gives them space and origin; normal tasks keep their chat', () => {
  const db = fixture();
  migrate(db, { until: 82 });
  type R = { id: string; conversation_id: string | null; message_id: string | null; space_id: string | null; source: string | null; source_label: string | null };
  const rows = new Map(db.all<R>('SELECT id, conversation_id, message_id, space_id, source, source_label FROM tasks').map((r) => [r.id, { ...r }]));
  assert.deepEqual(rows.get('tk_work'), { id: 'tk_work', conversation_id: 'cv_work', message_id: 'ms_anchor', space_id: null, source: null, source_label: null });
  assert.equal(rows.get('tk_work_step')?.conversation_id, 'cv_work');
  assert.deepEqual(rows.get('tk_todo'), { id: 'tk_todo', conversation_id: null, message_id: null, space_id: 'sp_home', source: 'todo-list', source_label: 'To-do area' });
  assert.deepEqual(rows.get('tk_todo_step'), { id: 'tk_todo_step', conversation_id: null, message_id: null, space_id: 'sp_home', source: 'todo-list', source_label: 'To-do area' });
  assert.deepEqual(rows.get('tk_inbox'), { id: 'tk_inbox', conversation_id: null, message_id: null, space_id: 'sp_route', source: 'intake', source_label: 'Quick task' });
  assert.equal(rows.get('tk_inbox_step')?.space_id, 'sp_route', "a step takes its parent's route space");
  assert.equal(rows.get('tk_inbox_free')?.space_id, null, 'no route and a chat without space: none');
  // The hidden chats stay as inert rows.
  assert.equal(count(db, `conversations WHERE id IN ('cv_todo', 'cv_inbox')`), 2);
});

test('migration 82 finds a To-do chat from before its marker through kv and marks it a system chat', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 81 });
  chat(db, 'cv_old_todo', { hiddenFromList: true }, 'sp_home');
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('tasks', 'todo_conversation', ?, ?)`, [JSON.stringify('cv_old_todo'), T]);
  task(db, 'tk_old', 'cv_old_todo');
  migrate(db, { until: 82 });
  assert.deepEqual({ ...db.get(`SELECT conversation_id AS c, source AS s FROM tasks WHERE id = 'tk_old'`)! }, { c: null, s: 'todo-list' });
  const settings = JSON.parse(String(db.get<{ settings: string }>(`SELECT settings FROM conversations WHERE id = 'cv_old_todo'`)!.settings));
  assert.deepEqual(settings, { hiddenFromList: true, system: 'todo' }, 'the inert old chat stays out of every chat list (was markTodoChat)');
});

test('migration 82 adds the wake and run origin columns and run indexes; old rows keep NULL', () => {
  const db = fixture();
  migrate(db, { until: 82 }); // B-057: migration 84 adds runs.split_id after them
  for (const table of ['wakes', 'runs']) assert.deepEqual(columns(db, table).slice(-2).map((c) => c.name), ['source', 'source_label'], table);
  const names = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'`).map((r) => r.name);
  for (const name of ['runs_task', 'runs_source']) assert.ok(names.includes(name), name);
  assert.equal(db.get<{ s: string | null }>(`SELECT source AS s FROM wakes WHERE id = 'wk_1'`)?.s, null);
  assert.equal(db.get<{ s: string | null }>(`SELECT source AS s FROM runs WHERE id = 'rn_1'`)?.s, null);
});

test('a failing foreignKeysOff migration rolls back and still restores foreign_keys = ON', () => {
  const db = fixture();
  db.exec(`DROP TABLE task_routes`); // the data step reads task_routes: the migration throws inside its transaction
  assert.throws(() => migrate(db));
  assert.equal(fk(db), 1);
  assert.equal(db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)?.value, '81');
  assert.equal(columns(db, 'tasks').find((c) => c.name === 'conversation_id')?.notnull, 1, 'rolled back: the old table is still there');
  assert.equal(count(db, 'tasks'), 7);
  assert.equal(count(db, 'task_news'), 2, 'no cascade on the dropped table');
});

test('B-054 fix: migration 82 moves pending wakes and schedules of the stand-in chats with their tasks', () => {
  const db = fixture();
  db.run(`INSERT INTO wakes (id, agent_id, conversation_id, task_id, reason, due_at, created_at) VALUES ('wk_todo', 'ag_ava', 'cv_todo', 'tk_todo', 'task', ?, ?)`, [T, T]);
  db.run(`INSERT INTO wakes (id, agent_id, conversation_id, task_id, reason, due_at, created_at) VALUES ('wk_work', 'ag_ava', 'cv_work', 'tk_work', 'task', ?, ?)`, [T, T]);
  db.run(`INSERT INTO schedules (id, owner_id, conversation_id, task_id, kind, title, spec, created_at) VALUES ('sc_rem', 'ag_ava', 'cv_todo', 'tk_todo', 'reminder', 'Look again', '{}', ?)`, [T]);
  db.run(`INSERT INTO schedules (id, owner_id, conversation_id, kind, title, spec, created_at) VALUES ('sc_rt', 'ag_ava', 'cv_inbox', 'routine', 'Morning check', '{}', ?)`, [T]);
  db.run(`INSERT INTO schedules (id, owner_id, conversation_id, kind, title, spec, created_at) VALUES ('sc_msg', 'ag_ava', 'cv_todo', 'message', 'Hello', '{}', ?)`, [T]);
  migrate(db, { until: 82 });
  const wake = (id: string) => db.get<{ c: string | null }>('SELECT conversation_id AS c FROM wakes WHERE id = ?', [id])?.c;
  const schedule = (id: string) => db.get<{ c: string | null; a: number }>('SELECT conversation_id AS c, active AS a FROM schedules WHERE id = ?', [id]);
  assert.equal(wake('wk_todo'), null, 'the task wake follows its chat-free task');
  assert.equal(wake('wk_work'), 'cv_work', 'a normal chat keeps its wakes');
  assert.deepEqual({ ...schedule('sc_rem') }, { c: null, a: 1 });
  assert.deepEqual({ ...schedule('sc_rt') }, { c: null, a: 1 }, 'a routine there now creates chat-free tasks');
  assert.deepEqual({ ...schedule('sc_msg') }, { c: 'cv_todo', a: 0 }, 'a scheduled message into the inert chat is switched off');
});
