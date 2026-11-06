// Migration 82 (B-054, owner 29.10.2026 – runs and to-dos without a chat binding):
// a task is its own row, a chat only the place it was handed over in.
//  1. `tasks` is rebuilt (SQLite cannot drop NOT NULL in place): conversation_id becomes nullable with ON DELETE
//     SET NULL, and space_id (chat-free tasks only), source and source_label (the origin) are added. The rowid is
//     copied, because tasks_fts is keyed by it; every index and trigger on tasks is read from sqlite_master
//     before the drop and created again. Runs with foreign keys OFF (migrate.ts `foreignKeysOff`), otherwise the
//     DROP would cascade-delete steps, task_news, task_subscriptions and calendar_events rows.
//  2. The stand-in rows are detached: tasks in the hidden To-do chat ('todo') or Inbox chat ('inbox') – by the
//     chat's system marker or the chat id kept in kv – lose their chat and anchor message, keep the space (an
//     Inbox task its route's, else the chat's) and get the origin 'todo-list' / 'intake'. Their pending wakes and the
//     reminders and routines agents made while working there follow them (chat-free; a routine then creates chat-free
//     tasks); a scheduled message into such a chat is switched off. The two chats and their messages stay as inert
//     rows; nothing is deleted. A To-do chat kept only in kv (made before the 'todo' marker
//     existed) gets the marker and hiddenFromList now, so the inert chat stays out of every chat list (this replaces
//     the old startup backfill tasks/human.ts markTodoChat).
//  3. wakes and runs get source/source_label, runs the indexes runs_task and runs_source.
// engine_sessions, context_items and knowledge_audience are not touched.
// Owns: this schema step and that one data step. Never: deletes a row, writes task text, or edits a shipped migration.

import type { Db } from '../database.ts';

/** The columns of `tasks` today (001, 009 assigned_by, 068 day fields), in their order. */
const COLUMNS = [
  'id', 'conversation_id', 'message_id', 'parent_id', 'title', 'notes', 'status', 'assignee_kind', 'assignee_id', 'created_by',
  'priority', 'due_at', 'depends_on', 'goal', 'done_when', 'mode', 'widget', 'human_reason', 'waiting_on', 'result',
  'ledger', 'attempts', 'sort', 'rev', 'client_id', 'created_at', 'updated_at', 'started_at', 'completed_at',
  'assigned_by', 'estimate_min', 'estimate_source', 'spent_ms', 'timer_started_at', 'window', 'prep', 'private',
] as const;

const CREATE = /* sql */ `
CREATE TABLE tasks_v82 (
  id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT, parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  assignee_kind TEXT NOT NULL DEFAULT 'team', assignee_id TEXT, created_by TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, due_at INTEGER, depends_on TEXT NOT NULL DEFAULT '[]',
  goal TEXT, done_when TEXT, mode TEXT, widget TEXT, human_reason TEXT, waiting_on TEXT, result TEXT,
  ledger TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0, client_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
  assigned_by TEXT,
  estimate_min INTEGER, estimate_source TEXT, spent_ms INTEGER, timer_started_at INTEGER, "window" TEXT, prep TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  space_id TEXT, source TEXT, source_label TEXT
) STRICT;`;

/** The stand-in chats: by marker, or the id the app kept in kv (a To-do chat from before the marker). */
const standIn = (kind: 'todo' | 'inbox', key: string) => /* sql */ `(
  SELECT c.id FROM conversations c WHERE json_extract(c.settings, '$.system') = '${kind}'
  UNION SELECT json_extract(k.value, '$') FROM kv k WHERE k.ns = 'tasks' AND k.key = '${key}' AND json_valid(k.value))`;

/** A detached row's space: an Inbox task its route's (a step its parent's route), else the chat's. */
const DETACH = /* sql */ `
CREATE TEMP TABLE b054_stand_in AS
  SELECT id, 'todo' AS kind FROM ${standIn('todo', 'todo_conversation')}
  UNION SELECT id, 'inbox' FROM ${standIn('inbox', 'inbox_conversation')};
DELETE FROM b054_stand_in WHERE id IS NULL OR (kind = 'todo' AND id IN (SELECT id FROM b054_stand_in WHERE kind = 'inbox'));
UPDATE tasks SET
  space_id = COALESCE(
    CASE WHEN (SELECT kind FROM b054_stand_in s WHERE s.id = tasks.conversation_id) = 'inbox' THEN COALESCE(
      (SELECT r.space_id FROM task_routes r WHERE r.task_id = tasks.id),
      (SELECT r.space_id FROM task_routes r WHERE r.task_id = tasks.parent_id)) END,
    (SELECT c.space_id FROM conversations c WHERE c.id = tasks.conversation_id)),
  source = CASE (SELECT kind FROM b054_stand_in s WHERE s.id = tasks.conversation_id) WHEN 'inbox' THEN 'intake' ELSE 'todo-list' END,
  source_label = CASE (SELECT kind FROM b054_stand_in s WHERE s.id = tasks.conversation_id) WHEN 'inbox' THEN 'Quick task' ELSE 'To-do area' END,
  message_id = NULL,
  conversation_id = NULL
WHERE conversation_id IN (SELECT id FROM b054_stand_in);
UPDATE wakes SET conversation_id = NULL WHERE conversation_id IN (SELECT id FROM b054_stand_in) AND task_id IS NOT NULL;
UPDATE schedules SET conversation_id = NULL WHERE conversation_id IN (SELECT id FROM b054_stand_in) AND kind <> 'message';
UPDATE schedules SET active = 0 WHERE conversation_id IN (SELECT id FROM b054_stand_in) AND kind = 'message';
DROP TABLE b054_stand_in;`;

/** The old To-do chat kept in kv becomes the 'todo' system chat when it lacks a marker (pre-marker profiles). */
const MARK_TODO = /* sql */ `
UPDATE conversations SET settings = json_set(CASE WHEN json_valid(settings) THEN settings ELSE '{}' END, '$.hiddenFromList', json('true'), '$.system', 'todo')
WHERE id = (SELECT json_extract(k.value, '$') FROM kv k WHERE k.ns = 'tasks' AND k.key = 'todo_conversation' AND json_valid(k.value))
  AND COALESCE(json_extract(settings, '$.system'), '') NOT IN ('todo', 'inbox');`;

const RUNS_AND_WAKES = /* sql */ `
ALTER TABLE wakes ADD COLUMN source TEXT;
ALTER TABLE wakes ADD COLUMN source_label TEXT;
ALTER TABLE runs ADD COLUMN source TEXT;
ALTER TABLE runs ADD COLUMN source_label TEXT;
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS runs_source ON runs(agent_id, source, started_at);`;

/** Runs inside the runner's transaction, with foreign keys OFF (migrate.ts checks foreign_key_check after it). */
export function run(db: Db): void {
  const present = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('tasks')`).map((row) => row.name);
  const unknown = present.filter((name) => !(COLUMNS as readonly string[]).includes(name));
  if (unknown.length) throw new Error(`Migration 82: tasks has columns this migration does not know (${unknown.join(', ')}).`);
  const missing = COLUMNS.filter((name) => !present.includes(name));
  if (missing.length) throw new Error(`Migration 82: tasks lacks columns (${missing.join(', ')}).`);
  // Indexes and triggers on tasks (autoindexes have no sql – the PRIMARY KEY makes them again).
  const keep = db.all<{ type: string; name: string; sql: string }>(
    `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'tasks' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`,
  );
  const list = COLUMNS.map((name) => `"${name}"`).join(', ');
  const before = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')?.n ?? 0);
  db.exec(CREATE);
  db.exec(`INSERT INTO tasks_v82 (rowid, ${list}) SELECT rowid, ${list} FROM tasks;`);
  db.exec('DROP TABLE tasks;');
  db.exec('ALTER TABLE tasks_v82 RENAME TO tasks;');
  for (const entry of keep) db.exec(`${entry.sql};`);
  const after = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')?.n ?? 0);
  if (after !== before) throw new Error(`Migration 82: ${before} tasks before the rebuild, ${after} after.`);
  db.exec(DETACH);
  db.exec(MARK_TODO);
  db.exec(RUNS_AND_WAKES);
}
