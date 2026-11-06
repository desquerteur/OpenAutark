// Migration 84 (B-057 "Ultra mode", owner 29.10.2026 – an agent splits itself up):
// an agent splits itself into parallel workers (shared/model/splits.ts).
//  * split_groups – one agents.split call of a parent run: where it came from (chat, task or origin source, the
//    parent's thread, mode and folder), its goal, the chat's Ultra switch at that moment and its lifecycle.
//  * splits – one part of a group (1-based idx, unique per group): brief, context, model/effort, `after` (JSON array
//    of lower part indices), worktree flag, how its session was seeded (`fork`, JSON), its branch (JSON) and status.
//  * runs.split_id – the split a run worked for (NULL for every other run), with a partial index.
// 83 is reserved by another package (Transkription); this step takes 84 regardless (migrate.ts numbering rule).
// Owns: these tables, that column and their indexes. Never: data steps or edits of a shipped migration.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS split_groups (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL, conversation_id TEXT, task_id TEXT, source TEXT, source_label TEXT, thread TEXT NOT NULL,
  mode_key TEXT, cwd TEXT, goal TEXT NOT NULL, ultra INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, gathered_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS split_groups_agent ON split_groups(agent_id, created_at);
CREATE INDEX IF NOT EXISTS split_groups_parent ON split_groups(parent_run_id);
CREATE INDEX IF NOT EXISTS split_groups_thread ON split_groups(agent_id, thread, status);

CREATE TABLE IF NOT EXISTS splits (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, returns TEXT,
  context TEXT NOT NULL DEFAULT 'fork', model TEXT, effort TEXT, "after" TEXT NOT NULL DEFAULT '[]', worktree INTEGER NOT NULL DEFAULT 0,
  fork TEXT, branch TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, UNIQUE (group_id, idx)
) STRICT;
CREATE INDEX IF NOT EXISTS splits_agent_status ON splits(agent_id, status);

ALTER TABLE runs ADD COLUMN split_id TEXT;
CREATE INDEX IF NOT EXISTS runs_split ON runs(split_id) WHERE split_id IS NOT NULL;
`;
