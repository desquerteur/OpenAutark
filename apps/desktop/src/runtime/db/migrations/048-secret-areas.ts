// Migration 48 (LIFECYCLE): secret areas and the grant audit. `secret_areas` gives a logical vault
// path its own description and its own visibility list (agent ids, '*', branch:<id> – who may see
// the path and description; entries keep their own access lists) – an area exists without entries.
// `secret_grant_log` records every change of who may use a secret, group or area (by the person) and
// every org change that moved an agent into or out of a branch grant (shared/model/secret-areas.ts).
// No values anywhere; the log names ids, labels and grants only.
// Owns: the secret_areas and secret_grant_log schema. Never: data rows, secret values, or edits of
// shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS secret_areas (
  path TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', agents TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS secret_grant_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL,
  grant_entry TEXT NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL, detail TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS secret_grant_log_target ON secret_grant_log(target, id);
`;
