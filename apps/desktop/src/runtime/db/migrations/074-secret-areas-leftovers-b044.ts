// Migration 74 (B-044 secrets like skills, 25.10.2026): what the removed
// secret areas left in the database goes:
//  * every 'branch:<agent id>' entry in the access lists of single secrets and groups – since B-044 such an entry
//    grants nothing (an access list holds '*' or agent ids), and the RPC refuses a list that still carries one, so a
//    stored one blocked every later edit of that secret (Settings' dialog, Agent › Permissions' toggles); the other
//    entries stay in their order;
//  * the area rows (`secret_areas`: the person's area descriptions and visibility lists) and the grant audit
//    (`secret_grant_log`) – no code reads, exports or prunes them any more.
// The tables of migration 48 stay (empty, unused); the logical `path` column of migration 35 stays (the readable export
// still lists it). The connection runs with secure_delete on (db/database.ts), so the freed bytes are overwritten.
// Owns: these updates and deletions. Never: a value, a cipher, a domain or any other access entry.

const dropBranches = (table: string) => /* sql */ `
UPDATE ${table} SET agents = (SELECT json_group_array(entry.value) FROM json_each(${table}.agents) AS entry WHERE substr(entry.value, 1, 7) <> 'branch:')
WHERE instr(agents, '"branch:') > 0 AND CASE WHEN json_valid(agents) THEN json_type(agents) = 'array' ELSE 0 END;`;

export const sql = /* sql */ `
${dropBranches('secrets')}
${dropBranches('secret_groups')}
DELETE FROM secret_areas;
DELETE FROM secret_grant_log;
`;
