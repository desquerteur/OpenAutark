// Migration 5 (SES1): durable session renewal. Earlier versions kept a compaction seed in
// memory under a synthetic `seed:<uuid>` session ref; after a restart that ref could never run
// again. Such rows are dropped (the next turn sends the full projection and starts a fresh
// native session). `context_window` stores the window the engine reported for the bound model,
// used for renewal when the model catalog has none.

export const sql = /* sql */ `
DELETE FROM engine_sessions WHERE session_ref LIKE 'seed:%';
ALTER TABLE engine_sessions ADD COLUMN context_window INTEGER;
`;
