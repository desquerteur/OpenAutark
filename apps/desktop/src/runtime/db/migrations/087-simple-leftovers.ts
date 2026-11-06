// Migration 87 (Umbau Einfachheit, 31.10.2026): the tables and kv rows the other removed parts left behind go:
//  * agent mind: the context ledger (077), model outcomes, the learned-playbook drafts and work;
//  * work: task routes, subscriptions and news (task center), companions and their rounds;
//  * skills: versions, audience, loads and origins (skills are plain files now);
//  * voice and media: live calls and their realtime usage, media segments with their search and vectors;
//  * the app overlay's customization requests and the old remote access audit;
//  * kv namespaces nothing reads any more (the overlay's requests, the subconscious, Artificial Analysis and the model
//    feeds, the learned model outcomes, the task center's compete/delegate marks, wake holds, native-turn and rebuild
//    probes, effect questions, manager reports, the task assigner, the speech word list's learner) and the mode-switch
//    counters.
// The old `settings` table stays: a start moves its rows into settings.json once (also after restoring an old backup).
// Owns: these data steps. Never: other tables, rows or namespaces.

export const sql = /* sql */ `
DROP TABLE IF EXISTS context_items;
DROP TABLE IF EXISTS model_outcomes;
DROP TABLE IF EXISTS playbook_drafts;
DROP TABLE IF EXISTS playbook_work;

DROP TABLE IF EXISTS task_news;
DROP TABLE IF EXISTS task_subscriptions;
DROP TABLE IF EXISTS task_routes;
DROP TABLE IF EXISTS companion_rounds;
DROP TABLE IF EXISTS companions;

DROP TABLE IF EXISTS skill_loads;
DROP TABLE IF EXISTS skill_audience;
DROP TABLE IF EXISTS skill_origins;
DROP TABLE IF EXISTS skill_versions;

DROP TRIGGER IF EXISTS media_vectors_segment_delete;
DROP TRIGGER IF EXISTS media_segments_fts_delete;
DROP TABLE IF EXISTS media_vectors;
DROP TABLE IF EXISTS media_segments_fts;
DROP TABLE IF EXISTS media_segments;
DROP TABLE IF EXISTS call_usage;
DROP TABLE IF EXISTS calls;

DROP TABLE IF EXISTS customizations;
DROP TABLE IF EXISTS remote_audit;

DELETE FROM kv WHERE ns IN ('customize', 'customize.request', 'subconscious', 'aa', 'artificial-analysis', 'model-feeds',
  'outcome_rated', 'outcome_window', 'outcome_pending', 'engine-rebuild-probe', 'tasks.compete', 'tasks.compete.part',
  'tasks.delegated', 'wake_hold', 'native-turns', 'effects.asked', 'manager_report', 'task_assigner', 'vocabulary');
DELETE FROM kv WHERE ns = 'modes' AND key LIKE 'switches:%';
`;
