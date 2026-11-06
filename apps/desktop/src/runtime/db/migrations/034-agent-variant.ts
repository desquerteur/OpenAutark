// Migration 34 (X10): a derived agent's variant (shared/model/agent-variants.ts) as JSON –
// {kind: copy|twin|reviewer, inherit?: {kinds?, tags?, hidden?, none?}, review?: each|escalation}.
// NULL: not derived, or derived before X10 (a copy without a filter). knowledge/lineage.ts reads it
// in SQL (twins by json_extract); a value that is not valid JSON counts as "takes nothing".

export const sql = /* sql */ `
ALTER TABLE agents ADD COLUMN variant TEXT;
`;
