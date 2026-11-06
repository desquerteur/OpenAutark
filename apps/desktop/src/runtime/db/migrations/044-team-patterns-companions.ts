// Migration 44 (F-51): the person's own team patterns and the companion ("counter-role") settings.
// team_patterns: a saved or imported pattern – its Markdown text (resources/patterns format), the
//   front matter's name/version, `source` 'saved' | 'imported' and its provenance (JSON: kind url |
//   file | org, the URL or file name – never a local path –, sha256, at, previousSha256). Built-in
//   patterns stay files in resources/patterns and are never rows.
// companions: one companion agent on an agent's work (target_kind 'agent') or on one task
//   ('task'), with the person's brief and the contributions per task (max_rounds).
// companion_rounds: contributions so far per companion setting and task (the attempt bound).
// Owns: the tables. Never: secrets (pattern text is scrubbed before it is stored), permissions or budgets.

export const sql = /* sql */ `
CREATE TABLE team_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE companions (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  brief TEXT NOT NULL,
  max_rounds INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (target_kind, target_id, companion_id)
) STRICT;
CREATE INDEX companions_target ON companions(target_kind, target_id);

CREATE TABLE companion_rounds (
  companion_row TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (companion_row, task_id)
) STRICT;
`;
