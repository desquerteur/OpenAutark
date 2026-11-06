// Migration 28 (C9): the owner's own Telegram account linked to a bridge ("Link my Telegram").
// `owner_user_id` is the Telegram user id whose messages post as the owner (runtime only, never
// sent to clients), `owner_name` its display name at link time, `owner_linked_at` when it was
// linked. NULL = no link. Link codes are never stored (memory only, bridges/owner-link.ts);
// disconnecting deletes the row and with it the link.

export const sql = /* sql */ `
ALTER TABLE bridges ADD COLUMN owner_user_id TEXT;
ALTER TABLE bridges ADD COLUMN owner_name TEXT;
ALTER TABLE bridges ADD COLUMN owner_linked_at INTEGER;
`;
