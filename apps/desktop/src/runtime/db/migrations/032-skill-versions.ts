// Migration 32 (X07): skill versions and learned playbooks (shared/model/skill-versions.ts).
// skill_versions: one row per recorded state of a skill name – `action` (baseline, save, playbook,
// revert, delete), `author_id` ('human', 'system' or the agent id), `run_id`, `reason`,
// `revert_of`, `draft_id`, `source` and `owner_agent_id` of that state and its whole text
// (`modes` JSON). store/skill-versions.ts keeps the newest 30 per name. AUTOINCREMENT: a version id
// is never handed out twice, also after pruning.
// playbook_drafts: skill proposals from repeated verified work, waiting for the person (`status`
// pending | approved | dismissed; `target` = the learned skill an update would change; `sources`
// JSON list of the tasks it came from).
// playbook_work: one row per verified agent task with enough real steps – the tool names it used
// (`tools` sorted unique, `steps` in order), the skills it loaded, the draft it fed (`draft_id`;
// 0 = the model found no shared procedure, never retried) and when a model call was made for it
// (`tried_at`: the learner's daily call budget and the pause before its kind is tried again).

export const sql = /* sql */ `
CREATE TABLE skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, owner_agent_id TEXT, source TEXT NOT NULL, action TEXT NOT NULL, author_id TEXT NOT NULL,
  run_id TEXT, reason TEXT, revert_of INTEGER, draft_id INTEGER,
  description TEXT NOT NULL, modes TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX skill_versions_name ON skill_versions(name, id);

CREATE TABLE playbook_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, target TEXT,
  description TEXT NOT NULL, body TEXT NOT NULL, modes TEXT NOT NULL, sources TEXT NOT NULL,
  private INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, skill_name TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
) STRICT;
CREATE INDEX playbook_drafts_status ON playbook_drafts(status, created_at);

CREATE TABLE playbook_work (
  task_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
  tools TEXT NOT NULL, steps TEXT NOT NULL, skills TEXT NOT NULL, verified_at INTEGER NOT NULL, draft_id INTEGER, tried_at INTEGER
) STRICT;
CREATE INDEX playbook_work_agent ON playbook_work(agent_id, mode, verified_at);
`;
