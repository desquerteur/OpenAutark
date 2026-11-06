// Migration 60 (wave 2, call extras + media segment carry-over, 23.10.2026):
// call_usage – one row per realtime voice session of a live call (calls/realtime/usage.ts): which call,
//   chat, agent and model, from when to when, the provider's reported token counts (text/audio in and
//   out, cached input, the input transcription's tokens or seconds) and the price in USD computed from the
//   maintained list prices (NULL = a part had no known price). `updated_at` = the last reported usage (the end
//   of a session the runtime lost). `booked` = its cost went to the agent's spend ledger once (a lost session is
//   booked at the next start). No foreign key: a cost record
//   stays when its chat is removed. Counts only – never audio or transcripts.
// media_segments.review / carried_from – a segment carried to a new render of the same video series
//   (media/segment-carry.ts): `carried_from` the segment it came from, `review` why it needs a look (NULL =
//   mapped exactly by the edit list, or set by hand).
// calls/realtime/usage.ts and media/segment-carry.ts create these once more on a database whose schema
// version already passed 60 without them (parallel version numbers).
// Owns: this schema. Never: data rows.

/** The usage table alone (calls/realtime/usage.ts creates it on a database that skipped 60). */
export const callUsageTable = /* sql */ `
CREATE TABLE IF NOT EXISTS call_usage (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  text_in INTEGER NOT NULL DEFAULT 0,
  text_in_cached INTEGER NOT NULL DEFAULT 0,
  audio_in INTEGER NOT NULL DEFAULT 0,
  audio_in_cached INTEGER NOT NULL DEFAULT 0,
  text_out INTEGER NOT NULL DEFAULT 0,
  audio_out INTEGER NOT NULL DEFAULT 0,
  transcribe_in INTEGER NOT NULL DEFAULT 0,
  transcribe_out INTEGER NOT NULL DEFAULT 0,
  transcribe_seconds REAL NOT NULL DEFAULT 0,
  usd REAL,
  booked INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS call_usage_agent ON call_usage(agent_id, started_at);
`;

/** The two segment columns, one statement each (media/segment-carry.ts adds a missing one). */
export const segmentColumns = ['review TEXT', 'carried_from TEXT'] as const;

export const sql = callUsageTable + segmentColumns.map((column) => `ALTER TABLE media_segments ADD COLUMN ${column};`).join(' ');
