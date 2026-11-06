// Migration 2 (R4): the media library. One row per stored file (FileStore id = sha256) with
// size/length facts and an optional description + tags written by the human or an agent.
// `media_fts` is maintained by the media repository (German-folded text, like knowledge_fts);
// there are no triggers. Rule: file bytes stay in the blob store, never in these tables.

export const sql = /* sql */ `
CREATE TABLE media (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  conversation_id TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL,
  width INTEGER, height INTEGER, duration_ms INTEGER, pages INTEGER,
  description TEXT, tags TEXT, described_by TEXT, described_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX media_conversation ON media(conversation_id, created_at);
CREATE INDEX media_kind ON media(kind, created_at);

CREATE VIRTUAL TABLE media_fts USING fts5(file_id UNINDEXED, name, description, tags, tokenize = 'unicode61 remove_diacritics 2');
`;
