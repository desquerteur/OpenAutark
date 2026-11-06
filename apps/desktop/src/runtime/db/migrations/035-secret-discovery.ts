// Owns: discoverable secret metadata and secret reference drafts.
// Never: plaintext values; paths are logical namespaces, not filesystem locations.
export const sql = `
ALTER TABLE secrets ADD COLUMN path TEXT NOT NULL DEFAULT '/';
ALTER TABLE secrets ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE secrets ADD COLUMN conversation_id TEXT;
ALTER TABLE drafts ADD COLUMN secret_ids TEXT NOT NULL DEFAULT '[]';
`;
