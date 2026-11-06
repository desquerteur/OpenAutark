// Migration 73 (B-044 knowledge cleanup, 25.10.2026): what
// the removed knowledge features left in the database goes, so nothing keeps data no code reads or prunes:
//  * the X04 change wishes – kv 'wishes' (the person's own words quoted from their chats), 'wishes.scan'
//    (the scan cursor per chat) and 'wishes.meta' (the proposal state); the feature and its switch are gone;
//  * every check row of the removed review rules (`knowledge_checks`) and their kv marks (ns 'lifecycle',
//    keys 'backfilled', 'backfill-cursor', 'batch:<agent>');
//  * every capture policy of references (`reference_policies`): the capture rule is fixed since B-044
//    (references/policy.ts) and no code reads the rows any more.
// The tables of migrations 43 and 47 stay (empty, unused). The connection runs with secure_delete on
// (db/database.ts), so the freed bytes are overwritten.
// Owns: these deletions. Never: knowledge notes, references, their grants or drafts, the "Corrected
// memory" shown-once marks (kv 'lifecycle' 'seen:…', knowledge/corrections-note.ts), or other namespaces.

export const sql = /* sql */ `
DELETE FROM kv WHERE ns IN ('wishes', 'wishes.scan', 'wishes.meta');
DELETE FROM kv WHERE ns = 'lifecycle' AND (key IN ('backfilled', 'backfill-cursor') OR substr(key, 1, 6) = 'batch:');
DELETE FROM knowledge_checks;
DELETE FROM reference_policies;
`;
