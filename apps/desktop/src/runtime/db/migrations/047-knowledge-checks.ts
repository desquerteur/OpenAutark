// Migration 47 (LIFECYCLE): the check state of changeable knowledge (time validity). One row per
// knowledge version that a review policy (shared/model/lifecycle.ts) or the saving agent made due
// for a real check: method (re-open the source, ask the owner, run a check tool), target (URL, file,
// source document ref + the document's hash at that time, tool name), reviewer (agent; NULL = the
// person), due time, status (pending / ok / stale / unverified), the last check (when, by whom,
// what it found) and why it went stale. Forgetting a version deletes its row (ON DELETE CASCADE); a
// correction's new version gets its own row. `target_doc` indexes source-document targets, so a
// changed source marks its facts stale on the corpus' own change event (no polling).
// Owns: the knowledge_checks schema. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS knowledge_checks (
  item_id TEXT PRIMARY KEY REFERENCES knowledge(id) ON DELETE CASCADE,
  method TEXT NOT NULL, target TEXT, target_doc TEXT, target_hash TEXT, reviewer TEXT, policy TEXT,
  due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, asked_at INTEGER,
  checked_at INTEGER, checked_by TEXT, evidence TEXT, stale_since INTEGER, stale_reason TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_checks_due ON knowledge_checks(reviewer, due_at);
CREATE INDEX IF NOT EXISTS knowledge_checks_doc ON knowledge_checks(target_doc) WHERE target_doc IS NOT NULL;
`;
