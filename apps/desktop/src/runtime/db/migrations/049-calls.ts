// Migration 49 (live calls, shared/model/call.ts): one row per call of a chat – when it started and
// ended, who started it, why it ended, how many people took part at most and which transport served
// it. A row without `ended_at` after a restart is a call the runtime lost (it ends it with a chat line).
// Idempotent (IF NOT EXISTS): calls/history.ts runs it once more on a database whose schema version
// already passed 49 without it (a profile migrated while 49 did not exist yet).
// Owns: the table. Never: audio, transcripts (spoken lines are ordinary chat messages) or device secrets.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  started_by TEXT NOT NULL,
  ended_at INTEGER,
  reason TEXT,
  peak_people INTEGER NOT NULL DEFAULT 1,
  engine TEXT NOT NULL DEFAULT 'hybrid'
) STRICT;
CREATE INDEX IF NOT EXISTS calls_open ON calls(conversation_id) WHERE ended_at IS NULL;
`;
