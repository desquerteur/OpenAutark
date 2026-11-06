// Migration 91 (04.11.2026, B-075): the rows of runs at work (state 'streaming', with their live values) are read up to
// twice a second while a run works – the chat summaries' live rows (chat/message-repo.ts liveRows) and the start-up
// reconcile. A partial index holds just those few rows by chat, so the reads never walk a chat's whole history.
// Owns: this index. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE INDEX IF NOT EXISTS messages_streaming ON messages(conversation_id) WHERE state = 'streaming';
`;
