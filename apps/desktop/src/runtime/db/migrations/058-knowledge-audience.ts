// Migration 58 (F-52, chat-scoped memory boundary): who may meet what an agent learned in a chat with
// people. One row per knowledge version that was learned in such a chat: the chat and its readers then
// (JSON array of human ids, sorted; 'human' = the owner while the chat was not hidden from the owner).
// No row = the organisation's knowledge (as before). Forgetting a version deletes its row (ON DELETE
// CASCADE); a correction's new version gets the row of the version it replaced (runtime/knowledge/
// audience.ts, in the same transaction). `knowledge_shares` records each widening by a person (who,
// when, which chat and circle) – a share is never undone silently.
// Owns: the knowledge_audience and knowledge_shares schema. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS knowledge_audience (
  item_id TEXT PRIMARY KEY REFERENCES knowledge(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  readers TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_audience_chat ON knowledge_audience(conversation_id);
CREATE TABLE IF NOT EXISTS knowledge_shares (
  item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  readers TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  shared_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_shares_chat ON knowledge_shares(conversation_id, shared_at);
`;
