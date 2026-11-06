// Migration 67 (wave 3, shared editing): a chat's shared notes – the current text with its version and last
// author, and the history of versions with author, kind of change and time. Both belong to the chat and are
// deleted with it (foreign keys). IF NOT EXISTS, so runtime/notes/store.ts can create them on a database whose
// schema version passed 67 before this migration existed (parallel packages).
// Owns: the chat_notes and chat_note_revisions schema. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS chat_notes (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS chat_note_revisions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  op TEXT NOT NULL,
  restored_from INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, version)
) STRICT;
`;
