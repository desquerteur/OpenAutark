// Migration 59 (F-52, wave 2: people at work): a person's own settings (notifications, appearance, time
// zone – kept apart from the owner's settings) and the files a person uploaded into one of their chats
// (who, which chat, the name they gave it, size, when – the attach rule, their limits and their reading
// rule; the blob itself stays in `files`, cleaned up like every other upload).
// Owns: the person_settings and person_uploads schema. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS person_settings (
  person_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS person_uploads (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, file_id, conversation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS person_uploads_recent ON person_uploads(person_id, created_at);
CREATE INDEX IF NOT EXISTS person_uploads_file ON person_uploads(file_id);
`;
