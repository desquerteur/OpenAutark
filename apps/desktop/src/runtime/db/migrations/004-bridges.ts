// Migration 4 (R4): chat bridges (a chat mirrored to Telegram …). `secret_id` is the vault
// handle of the bot token; the token itself never lands in this table. `cursor` is the
// bridge's position in the external update stream (e.g. Telegram update_id).

export const sql = /* sql */ `
CREATE TABLE bridges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL, external_chat_id TEXT NOT NULL, cursor TEXT,
  status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX bridges_conversation ON bridges(conversation_id);
`;
