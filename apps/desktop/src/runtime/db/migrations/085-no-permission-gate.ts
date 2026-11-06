// Migration 85 (Umbau Einfachheit, 31.10.2026): the permission gate and the guardian are gone – agents act on
// their own, asking the person is a chat message or human.ask. What only the gate stored goes:
//  * the approvals table;
//  * kv namespaces of approvals, permission offers, the guardian's deny memory and purchase notes;
//  * the stored permission settings, agents' permission overrides and chats' permission mode;
//  * open host approval to-dos (a binding approve widget with an approvalId) – nothing waits on them any more;
//  * the dispatcher's budget pauses: agents paused only for their budget run again.
// Owns: these data steps. Never: other tables, rows or namespaces.

export const sql = /* sql */ `
DROP TABLE IF EXISTS approvals;

DELETE FROM kv WHERE ns IN ('permissions.approval', 'permission-offer', 'permissions.denials', 'spend.meta', 'dispatcher.budget');

DELETE FROM settings WHERE key = 'permissions';

UPDATE agents SET permissions = '{}' WHERE permissions <> '{}';

UPDATE conversations SET settings = json_remove(settings, '$.permissionMode')
WHERE json_valid(settings) AND json_type(settings, '$.permissionMode') IS NOT NULL;

UPDATE tasks SET status = 'cancelled', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE assignee_kind = 'human' AND status NOT IN ('done', 'cancelled')
  AND json_valid(widget) AND json_extract(widget, '$.approvalId') IS NOT NULL;

UPDATE agents SET status = 'idle', status_note = NULL WHERE status = 'paused' AND status_note = 'budget reached';
`;
