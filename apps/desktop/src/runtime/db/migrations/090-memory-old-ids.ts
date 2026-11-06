// Migration 90 (01.11.2026): a working state before 0.2.9 kept the old `kn_…` ids of the memory move as one JSON map, meta key
// `memory.old-ids`; 0.2.9 reads one meta row per id (`memory.old-id.<id>`, knowledge/memory-migrate.ts). A profile with the map
// gets its rows: a row that exists stays, and a map that is no JSON object just goes (it found nothing either).
// Owns: this one step. Never: other meta rows, or edits of shipped migrations.

export const sql = /* sql */ `
INSERT OR IGNORE INTO meta (key, value)
  SELECT 'memory.old-id.' || entry.key, entry.value
  FROM meta AS map, json_each(CASE WHEN json_valid(map.value) AND json_type(map.value) = 'object' THEN map.value ELSE '{}' END) AS entry
  WHERE map.key = 'memory.old-ids' AND entry.type = 'text';
DELETE FROM meta WHERE key = 'memory.old-ids';
`;
