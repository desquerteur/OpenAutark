// Migration 42 (F-52): an agent may report to a person of the organisation (one org chart). The
// `agents.manager_id` column references agents(id) (migration 1), so a person id cannot be stored
// there; `person_manager_id` holds it instead (no foreign key – people live in `people`, and a
// revoked person stays as a row). store/agents.ts maps both to Agent.managerId (at most one is set).
// compose/people.ts adds the same column on a database whose schema version passed 42 before this
// migration existed (parallel version numbers).
// Owns: that column. Never: changes agent rows or the manager_id column.

export const sql = /* sql */ `
ALTER TABLE agents ADD COLUMN person_manager_id TEXT;
`;
