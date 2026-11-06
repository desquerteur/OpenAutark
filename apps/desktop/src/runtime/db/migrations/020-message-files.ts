// Migration 20 (MM6): a partial index over the messages that carry attachments, so the blob
// clean-up (files/references.ts) can ask "does any message still attach this file?" without
// scanning every message body. Only rows with attachments are in the index (most messages
// have none); `attachments` is part of the key so the lookup reads the index alone.
// Rule: no data changes – the index is derived from `messages`.

export const sql = /* sql */ `
CREATE INDEX messages_files ON messages(conversation_id, attachments) WHERE attachments <> '[]';
`;
