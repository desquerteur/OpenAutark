// Migration 89 (01.11.2026): the context ledger comes back (087 dropped it on 31.10. by mistake) – one row per unit of an agent's
// working context in a chat (m<seq> chat message, t/s/r/a/f<n> tool call, skill text, reasoning, own text, file content), with
// `applied` (the state its native session holds since the last rebuild), the last mark (who, why, when – retention counts 14 days
// from it), `bytes` (an original kept in a blob: the 64 MB budget) and `pruned_at` (that original is gone; the row stays, so an id
// never dangles). The same schema as 077. "order" is quoted everywhere (a keyword).
// Owns: the context_items schema. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS context_items (
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  "order" INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'keep',
  condensed TEXT,
  pinned_until INTEGER,
  origin_engine TEXT,
  origin_model TEXT,
  ref TEXT,
  applied TEXT NOT NULL DEFAULT 'keep',
  marked_by TEXT,
  mark_reason TEXT,
  marked_at INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  pruned_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS context_items_id ON context_items(agent_id, conversation_id, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS context_items_order ON context_items(agent_id, conversation_id, "order");
CREATE INDEX IF NOT EXISTS context_items_ref ON context_items(agent_id, conversation_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS context_items_chat ON context_items(conversation_id);
`;
