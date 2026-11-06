// Migration 41 (F-52): people of the organisation next to the agents (runtime/people/*).
// people: one row per person – the owner ('human', title and scopes only; the name is the profile
//   name) and everyone invited ('per_…'). `manager_id` a person id or an agent id (one org chart);
//   `avatar` and `scopes` JSON ({spaces:'all'|[ids], startChats, assignAgents}); `status` invited |
//   active | revoked; `joined_at` the first accepted device, `revoked_at` the end of access.
// people_audit: what happened to a person's access (invited, joined, device removed, scopes changed,
//   revoked, chats added/removed) – `actor` 'human', 'system' or the person; `details` JSON (no
//   tokens, tickets or codes).
// Device tokens and invite tickets of people live in `tokens` (kinds 'person' and 'person-invite',
// scope JSON {personId}; only their sha256) – one token store for every client.
// IF NOT EXISTS: compose/people.ts runs the same SQL on a database whose schema version passed 41
// before this migration existed (parallel version numbers).
// Owns: the people and people_audit tables. Never: tokens, tickets or codes (they live hashed in tokens).

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '{}',
  manager_id TEXT,
  scopes TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  joined_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS people_manager ON people(manager_id);

CREATE TABLE IF NOT EXISTS people_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS people_audit_person ON people_audit(person_id, at);
`;
