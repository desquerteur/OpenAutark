// Migration 75 (B-044 integration, 25.10.2026): the stored
// values of the settings B-044 removed that migration 69 did not cover:
//  * voice.markUncertain ("Mark unsure words" – unsure words are always marked since B-044; the key is gone,
//    so a stored value would only ride along); a voice row it empties goes (absent = the defaults);
//  * a person's own preferences.motion / preferences.density (person_settings, migration 59 – Animations and
//    Density left Settings with 69, PERSON_PREFERENCES no longer lists them). The tables of migration 59 are
//    created first when this database skipped it (the parallel-version hazard compose/people-work.ts guards);
//  * the Models library's strength corrections (kv 'routing'/'strength_overrides': the person's Weak/Strong per
//    model and category) – the library and every reader went with B-044.
// Checked against the removed keys of the B-044 reports: preferences.motion/density/suggestChanges, the telecoding
// section, onboarding.suggestedSetup, lifecycle.reviews, routing.guide/findHints are 69's; the permission keys
// without UI (rules, grants, guardianModel, quarantine), org.autoAssignTasks, routing.embeddingDimensions/
// functions/helper and lifecycle.retention stay (contract §4 "keep but no UI").
// Rows that are not valid JSON are left alone (settings/service.ts repairs them on load).
// Owns: these data moves. Never: other keys, rows or namespaces.

import { sql as peopleWorkTables } from './059-people-work.ts';

export const sql = /* sql */ `
UPDATE settings SET value = json_remove(value, '$.markUncertain')
WHERE key = 'voice' AND json_valid(value) AND json_type(value, '$.markUncertain') IS NOT NULL;

DELETE FROM settings WHERE key = 'voice' AND json_valid(value) AND value = '{}';

${peopleWorkTables}
UPDATE person_settings SET data = json_remove(data, '$.preferences.motion', '$.preferences.density')
WHERE json_valid(data) AND (json_type(data, '$.preferences.motion') IS NOT NULL OR json_type(data, '$.preferences.density') IS NOT NULL);

DELETE FROM kv WHERE ns = 'routing' AND key = 'strength_overrides';
`;
