// Migration 30 (O5): an agent's change history (shared/model/agent-revisions.ts). One row per
// edit, archive, restore or revert: `author_id` ('human' or the agent id), `run_id` (the agent's
// run), `reason`, `revert_of` (the revision a revert undid) and `changes` (JSON list of the
// changed fields with their values before and after). store/agent-revisions.ts keeps the newest
// 200 rows per agent. AUTOINCREMENT: a revision id is never handed out twice, also after pruning.

export const sql = /* sql */ `
CREATE TABLE agent_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action TEXT NOT NULL, author_id TEXT NOT NULL, run_id TEXT, reason TEXT, revert_of INTEGER,
  changes TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX agent_revisions_agent ON agent_revisions(agent_id, id);
`;
