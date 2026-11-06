// Migration 76 (B-047 D12, 28.10.2026 – the owner's decision on the AI's autonomy):
// manager.md no longer carries `effort: high`, but org/hire.ts copied the template's effort into the seeded
// Manager's model policy, so existing installs kept a fixed high effort on every Manager turn. The seeded
// value goes; the router picks the effort per turn again. A person who wants high effort sets it again in
// the agent's model settings. Rows that are not valid JSON are left alone.
// Owns: this data move. Never: other agents, other policy keys.

export const sql = /* sql */ `
UPDATE agents SET model_policy = json_remove(model_policy, '$.effort')
WHERE template = 'manager' AND json_valid(model_policy) AND json_extract(model_policy, '$.effort') = 'high';
`;
