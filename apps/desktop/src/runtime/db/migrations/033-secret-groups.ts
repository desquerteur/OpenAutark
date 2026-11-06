// Migration 33 (X05): grouped secrets (shared/model/security.ts SecretGroup). A login (username,
// password, 2FA setup key) or a card (number, expiry, CVC, holder) is one row in secret_groups –
// metadata only, never a value – and each of its fields is a `secrets` row of its own (its own
// handle secret://<id>) with `group_id` and `field`. For a grouped row the GROUP's `agents` and
// `domains` count; the row's own columns stay '[]'. Field names are unique per group.
// `created_by` (groups and single secrets): the agent that created the row (secrets.generate,
// browser.save_totp) – NULL for the person's and for rows from before this migration; an agent
// changes only its own without asking (secrets/groups.ts).
// Portability needs nothing new: groups hold no values, and the existing scrub of secrets.cipher
// and the re-entry list cover every field (also 2FA keys).

export const sql = /* sql */ `
CREATE TABLE secret_groups (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, description TEXT,
  agents TEXT NOT NULL DEFAULT '[]', domains TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used_at INTEGER,
  created_by TEXT
) STRICT;
ALTER TABLE secrets ADD COLUMN group_id TEXT REFERENCES secret_groups(id) ON DELETE CASCADE;
ALTER TABLE secrets ADD COLUMN field TEXT;
ALTER TABLE secrets ADD COLUMN created_by TEXT;
CREATE UNIQUE INDEX secrets_group_field ON secrets(group_id, field) WHERE group_id IS NOT NULL;
`;
