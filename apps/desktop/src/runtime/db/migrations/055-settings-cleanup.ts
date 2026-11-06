// Migration 55 (settings cleanup, 23.10.2026 – "Schau dir nochmal die Einstellungen an"):
//  1. One global cost mode. A cost mode stored in the default model policy (kv 'routing' /
//     'default_policy', once set under Settings › Agents › Defaults for all agents) shadowed
//     Settings › Models › Routing › Cost (router: policy.costMode ?? settings.costMode). It was the
//     effective value, so it moves into the stored routing settings and leaves the policy; an
//     emptied policy row goes. routing/policies.ts setPolicy keeps it that way.
//  2. Feedback goes where the operator's build says (runtime/feedback/transport.ts): the legacy
//     submitter settings feedback.repo / privateRepo / endpoint, which no code reads any more, are
//     removed from the stored feedback row (includeDiagnostics stays).
// Rows that are not valid JSON are left alone (settings/service.ts repairs them on load), with one
// exception: an invalid stored 'routing' row is replaced by {"costMode": <moved value>} when a valid
// cost mode moves – the loader would reset that section to defaults anyway, and the cost mode in
// effect is kept.
// Owns: these two data moves of the settings audit. Never: touches other settings, agents' own
// policies or a chat's model choice.

export const sql = /* sql */ `
INSERT INTO settings (key, value, updated_at)
SELECT 'routing',
       json_set(COALESCE((SELECT value FROM settings WHERE key = 'routing' AND json_valid(value)), '{}'), '$.costMode', json_extract(kv.value, '$.costMode')),
       kv.updated_at
FROM kv
WHERE kv.ns = 'routing' AND kv.key = 'default_policy' AND json_valid(kv.value)
  AND json_extract(kv.value, '$.costMode') IN ('economy', 'balanced', 'best')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

UPDATE kv SET value = json_remove(value, '$.costMode')
WHERE ns = 'routing' AND key = 'default_policy' AND json_valid(value) AND json_type(value, '$.costMode') IS NOT NULL;
DELETE FROM kv WHERE ns = 'routing' AND key = 'default_policy' AND json_valid(value) AND value = '{}';

UPDATE settings SET value = json_remove(value, '$.repo', '$.privateRepo', '$.endpoint')
WHERE key = 'feedback' AND json_valid(value)
  AND (json_type(value, '$.repo') IS NOT NULL OR json_type(value, '$.privateRepo') IS NOT NULL OR json_type(value, '$.endpoint') IS NOT NULL);
`;
