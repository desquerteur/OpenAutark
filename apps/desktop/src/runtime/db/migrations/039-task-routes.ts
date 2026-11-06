// Migration 39 (task center): one routing record per task the task center handles – a quick task
// from the person's Inbox chat or an agent's tasks.submit (shared/model/task-center.ts TaskRoute).
// No foreign key: the 'task.removed' handler reads the Inbox anchor id before the row goes
// (runtime/tasks/center/service.ts); rows of tasks deleted with their chat are swept there too.
// Owns: the table. Never: task text (that stays in tasks/messages).

export const sql = /* sql */ `
CREATE TABLE task_routes (
  task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, state TEXT NOT NULL, method TEXT, owner_id TEXT,
  target TEXT, strength TEXT, space_id TEXT, reason TEXT, confidence REAL, decided_by TEXT, candidates INTEGER,
  passed TEXT NOT NULL DEFAULT '[]', intake_message_id TEXT, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_routes_state ON task_routes(state);
`;
