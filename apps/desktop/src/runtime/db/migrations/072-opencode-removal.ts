// Migration 72 (OpenCode removed, B-044, 25.10.2026): the
// engine, its detection and sign-in are gone, so what it left in the database goes too – its
// accounts (provider 'opencode'; they only ever had CLI homes, no stored key), their model listings
// (kv 'catalog' / 'listing:<id>'), its catalog rows and learned outcomes, its native sessions (the
// next turn of such a chat starts on another engine with the full projection, as after any engine
// switch), every routing setting that names one of its models ('opencode:…' in
// routing.functions, routing.helper, routing.decisionModel, routing.embeddingModel) or the
// provider itself (routing.workPlan) – those settings then read as unset (the defaults decide) –,
// and every model choice that pins one of its models: an agent's policy pin (agents.model_policy),
// the global default pin (kv 'routing' / 'default_policy') and a chat's choice or suggestion per
// agent (conversations.settings models / modelHints) – those then route automatically again.
// A routing row emptied by this goes (an absent row means the defaults); rows that are not valid
// JSON are left alone (settings/service.ts repairs them on load).
// Owns: these deletions. Never: files – an OpenCode home below <data>/accounts/opencode/ stays on
// disk (no row points at it any more) –, OpenCode's own folders outside the data folder, or other
// providers' rows.

export const sql = /* sql */ `
DELETE FROM kv WHERE ns = 'catalog' AND key IN (SELECT 'listing:' || id FROM accounts WHERE provider = 'opencode');
DELETE FROM engine_sessions WHERE engine = 'opencode';
DELETE FROM models WHERE engine = 'opencode' OR provider = 'opencode';
DELETE FROM model_outcomes WHERE substr(model_id, 1, 9) = 'opencode:';
DELETE FROM accounts WHERE provider = 'opencode';

UPDATE settings SET value = json_set(value, '$.functions', json((
  SELECT json_group_object(key, CASE WHEN type IN ('object', 'array') THEN json(value) ELSE value END)
  FROM json_each(settings.value, '$.functions')
  WHERE NOT (type = 'text' AND substr(value, 1, 9) = 'opencode:')
)))
WHERE key = 'routing' AND json_valid(value) AND json_type(value, '$.functions') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(settings.value, '$.functions') WHERE type = 'text' AND substr(value, 1, 9) = 'opencode:');

UPDATE settings SET value = json_remove(value, '$.helper')
WHERE key = 'routing' AND json_valid(value) AND json_type(value, '$.helper') = 'text' AND substr(json_extract(value, '$.helper'), 1, 9) = 'opencode:';

UPDATE settings SET value = json_remove(value, '$.decisionModel')
WHERE key = 'routing' AND json_valid(value) AND json_type(value, '$.decisionModel') = 'text' AND substr(json_extract(value, '$.decisionModel'), 1, 9) = 'opencode:';

UPDATE settings SET value = json_remove(value, '$.embeddingModel')
WHERE key = 'routing' AND json_valid(value) AND json_type(value, '$.embeddingModel') = 'text' AND substr(json_extract(value, '$.embeddingModel'), 1, 9) = 'opencode:';

UPDATE settings SET value = json_remove(value, '$.workPlan')
WHERE key = 'routing' AND json_valid(value) AND json_extract(value, '$.workPlan') = 'opencode';

DELETE FROM settings WHERE key = 'routing' AND json_valid(value) AND value = '{}';

UPDATE agents SET model_policy = json_remove(model_policy, '$.pin')
WHERE json_valid(model_policy) AND json_type(model_policy, '$.pin') = 'text' AND substr(json_extract(model_policy, '$.pin'), 1, 9) = 'opencode:';

UPDATE kv SET value = json_remove(value, '$.pin')
WHERE ns = 'routing' AND key = 'default_policy' AND json_valid(value) AND json_type(value, '$.pin') = 'text' AND substr(json_extract(value, '$.pin'), 1, 9) = 'opencode:';

UPDATE conversations SET settings = json_set(settings, '$.models', json((
  SELECT json_group_object(key, CASE WHEN type IN ('object', 'array') THEN json(value) ELSE value END)
  FROM json_each(conversations.settings, '$.models')
  WHERE NOT (type = 'text' AND substr(value, 1, 9) = 'opencode:')
)))
WHERE json_valid(settings) AND json_type(settings, '$.models') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(conversations.settings, '$.models') WHERE type = 'text' AND substr(value, 1, 9) = 'opencode:');

UPDATE conversations SET settings = json_set(settings, '$.modelHints', json((
  SELECT json_group_object(key, CASE WHEN type IN ('object', 'array') THEN json(value) ELSE value END)
  FROM json_each(conversations.settings, '$.modelHints')
  WHERE NOT (type = 'text' AND substr(value, 1, 9) = 'opencode:')
)))
WHERE json_valid(settings) AND json_type(settings, '$.modelHints') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(conversations.settings, '$.modelHints') WHERE type = 'text' AND substr(value, 1, 9) = 'opencode:');
`;
