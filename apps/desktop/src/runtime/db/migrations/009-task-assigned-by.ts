// Migration 9 (T08): who gave a task its owner. `assigned_by` = assign()'s `by` (the human, the
// system or an agent), or the agent itself on claim(). Rows from earlier versions keep NULL: no
// assigner is woken for them (tasks/assigner.ts).

export const sql = /* sql */ `
ALTER TABLE tasks ADD COLUMN assigned_by TEXT;
`;
