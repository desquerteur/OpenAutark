// Migration 78 (B-048 E5, 28.10.2026 – routing, CLI switch, compacting and the subconscious):
// chat vectors – the embedded chat lines (the person's messages and agents' answers, item id m<seq>, agent_id ''
// = every member may find it) and an agent's condensed or hidden context-ledger texts (its own item ids, only
// that agent finds them), one unit vector per row of the embedding profile it was made with (knowledge/chat-vectors.ts).
// A chat line's vector goes when its message is deleted, edited or moved to another seq (the triggers – a later
// pass embeds it again); a removed chat takes its rows with it (foreign key).
// Owns: the chat_vectors schema and its triggers. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS chat_vectors (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT '',
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  text_hash TEXT NOT NULL,
  embedding_profile TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent_id, item_id)
) STRICT;
CREATE INDEX IF NOT EXISTS chat_vectors_profile ON chat_vectors(conversation_id, embedding_profile);
CREATE INDEX IF NOT EXISTS chat_vectors_ref ON chat_vectors(ref) WHERE ref IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS chat_vectors_message_deleted AFTER DELETE ON messages BEGIN
  DELETE FROM chat_vectors WHERE ref = 'msg:' || OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS chat_vectors_message_changed AFTER UPDATE OF body, seq ON messages
  WHEN OLD.state = 'final' AND (OLD.body IS NOT NEW.body OR OLD.seq IS NOT NEW.seq) BEGIN
  DELETE FROM chat_vectors WHERE ref = 'msg:' || OLD.id;
END;
`;
