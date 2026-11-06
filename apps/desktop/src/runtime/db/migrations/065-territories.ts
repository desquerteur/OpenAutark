// Migration 65 (wave 3, TERRITORY): work territories – an agent's preferred folders and files.
// territories: one named territory of one agent (no foreign key: agents are archived, never deleted, and a
//   territory of an unknown agent is simply unused; `state` auto | always | off; `area_id` the knowledge area
//   that carries its reach once the person shares a folder or sets a reach – NULL = only its agent).
// territory_routes: its routes (absolute `path`, `enabled`; `shared_set` = the source the person's add put
//   into the territory's area, NULL for a route an agent added – that one only names a place; `off_by` who
//   switched it off: 'human' = only the person switches it on again). territories.off_by likewise.
// territory_focus: where a territory is active for an agent: 'chosen' for a chat (knowledge.territory focus),
//   'inferred' when the work named it (sticky for a while, runtime/territories/activation.ts), 'dismissed' when
//   the agent said "not here" (no inference in that chat). Rows go with their territory or chat.
// IF NOT EXISTS: runtime/territories/store.ts creates the tables on a database whose schema version passed 65
// before this migration existed (67 shipped first in this wave).
// Owns: this schema. Never: data rows, a permission (reading stays with knowledge_area_members).

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS territories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'auto',
  area_id TEXT,
  off_by TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_id, name)
) STRICT;
CREATE TABLE IF NOT EXISTS territory_routes (
  territory_id TEXT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  shared_set TEXT,
  off_by TEXT,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (territory_id, path)
) STRICT;
CREATE TABLE IF NOT EXISTS territory_focus (
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  territory_id TEXT NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
  how TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id, territory_id)
) STRICT;
CREATE INDEX IF NOT EXISTS territories_agent ON territories(agent_id);
CREATE INDEX IF NOT EXISTS territory_focus_territory ON territory_focus(territory_id);
`;
