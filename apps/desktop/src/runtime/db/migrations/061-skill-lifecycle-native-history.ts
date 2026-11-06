// Migration 61 (wave 2, knowledge/skill lifecycle extras):
// - skill_origins: where a skill imported from a public link came from – the link the person gave,
//   the URL actually read, sha256 of the downloaded text and of the body as written, the declared
//   version, review notes (possible injection signs) and a fetched update that waits for the person
//   (pending JSON: description, body, modes, version, sha256, notes). One row per skill name.
// - skill_audience: who may use a skill when the person chose it (readers '*' | 'agent:<id>' |
//   'space:<id>', the knowledge-area vocabulary), bound to the owner the skill had then ('' = shared
//   library) so a later skill of the same name by someone else never inherits it.
// - skill_loads: which skill text (sha256) an agent loaded in which chat with skills.load, so the next
//   turn can say once that it was deleted, withdrawn or replaced since (skills/withdrawals.ts).
// - native_deletions: provider-side histories queued for deletion through the provider's own API
//   after a Forget renewed their sessions (Codex thread/delete; privacy/native-history.ts).
// Owns: these schemas. Never: data rows, or edits of shipped migrations.

/** skill_audience on its own (compose/skill-lifecycle.ts rebuilds an early development table with it). */
export const audienceTable = /* sql */ `CREATE TABLE IF NOT EXISTS skill_audience (
  name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (name, owner, ref)
) STRICT;`;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS skill_origins (
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, fetched TEXT, sha256 TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  version TEXT, notes TEXT, previous_sha256 TEXT, imported_at INTEGER NOT NULL, checked_at INTEGER, pending TEXT
) STRICT;
${audienceTable}
CREATE TABLE IF NOT EXISTS skill_loads (
  agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, loaded_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id, name)
) STRICT;
CREATE INDEX IF NOT EXISTS skill_loads_name ON skill_loads(name);
CREATE TABLE IF NOT EXISTS native_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, engine TEXT NOT NULL, account_id TEXT NOT NULL, ref TEXT NOT NULL, agent_id TEXT,
  reason TEXT NOT NULL, requested_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER, error TEXT, UNIQUE (engine, account_id, ref)
) STRICT;
CREATE INDEX IF NOT EXISTS native_deletions_state ON native_deletions(state);
`;
