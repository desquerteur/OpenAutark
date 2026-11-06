// Migration 69 (settings cleanup of B-044, 25.10.2026 – "weniger Einstellungen, Standard entscheidet
// das System"):
//  1. The stored values of the removed settings leave their rows: preferences.motion / density /
//     suggestChanges, the whole telecoding section, onboarding.suggestedSetup, lifecycle.reviews,
//     routing.guide and routing.findHints. Their readers go with the owning tracks; a value left
//     behind would shadow the fixed behaviour or, once the key is unknown, break its section
//     (knowledge/lifecycle-settings.ts refuses unknown lifecycle keys).
//  2. onboarding.step (new, default 'ai'): an installation whose onboarding was completed, or whose
//     person already sent the suggested setup message to the Manager (suggestedSetup – the value
//     this migration strips, so its meaning is kept here), reads 'done', so the first-run layer
//     never shows again there.
// A row emptied by this (e.g. lifecycle with only reviews) goes – an absent row means the defaults.
// Rows that are not valid JSON are left alone (settings/service.ts repairs them on load).
// Owns: these data moves. Never: other keys, other tables (person_settings keeps a person's own
// preferences – PERSON_PREFERENCES decides which of them count – and may be missing on old profiles).

export const sql = /* sql */ `
UPDATE settings SET value = json_remove(value, '$.motion', '$.density', '$.suggestChanges')
WHERE key = 'preferences' AND json_valid(value)
  AND (json_type(value, '$.motion') IS NOT NULL OR json_type(value, '$.density') IS NOT NULL OR json_type(value, '$.suggestChanges') IS NOT NULL);

DELETE FROM settings WHERE key = 'telecoding';

UPDATE settings SET value = json_set(value, '$.step', 'done')
WHERE key = 'onboarding' AND json_valid(value) AND json_type(value, '$.step') IS NULL
  AND (json_type(value, '$.completed') = 'true' OR json_type(value, '$.suggestedSetup') = 'true');

UPDATE settings SET value = json_remove(value, '$.suggestedSetup')
WHERE key = 'onboarding' AND json_valid(value) AND json_type(value, '$.suggestedSetup') IS NOT NULL;

UPDATE settings SET value = json_remove(value, '$.reviews')
WHERE key = 'lifecycle' AND json_valid(value) AND json_type(value, '$.reviews') IS NOT NULL;

UPDATE settings SET value = json_remove(value, '$.guide', '$.findHints')
WHERE key = 'routing' AND json_valid(value) AND (json_type(value, '$.guide') IS NOT NULL OR json_type(value, '$.findHints') IS NOT NULL);

DELETE FROM settings WHERE key IN ('preferences', 'onboarding', 'lifecycle', 'routing') AND json_valid(value) AND value = '{}';
`;
