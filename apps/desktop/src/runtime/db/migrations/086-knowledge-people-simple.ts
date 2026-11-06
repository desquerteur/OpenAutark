// Migration 86 (Umbau Einfachheit, 31.10.2026): what only the removed knowledge, people, reference, recipe,
// source, privacy, notes and worktree machinery stored goes:
//  * references are plain knowledge rows (scope 'reference') – their rights, policies and draft tables go;
//  * the chat-scoped note audience and its shares, the sources corpus (sets, documents, chunks, knowledge
//    areas, jobs), chat vectors with their triggers on messages and the knowledge embeddings (columns emptied);
//  * recipes (macros), the notes' version history, the Codex thread deletion queue, a person's own settings,
//    the agents' change history and the never-read tables of earlier removals (knowledge checks, reference
//    policies, territories, secret areas and their grant log);
//  * kv namespaces of the curator, the corrected-memory note, people's notices, due reminders and reports,
//    recipe attempt marks, task worktree records and the Forget renewal marks.
// Owns: these data steps. Never: other tables, rows or namespaces (the knowledge rows, people, person uploads
// and their audit stay).

export const sql = /* sql */ `
DROP TABLE IF EXISTS reference_drafts;
DROP TABLE IF EXISTS reference_grants;
DROP TABLE IF EXISTS reference_policies;
DROP TABLE IF EXISTS reference_items;

DROP TABLE IF EXISTS knowledge_shares;
DROP TABLE IF EXISTS knowledge_audience;
DROP TABLE IF EXISTS knowledge_checks;

DROP TABLE IF EXISTS source_chunks_fts;
DROP TABLE IF EXISTS source_chunks;
DROP TABLE IF EXISTS source_docs;
DROP TABLE IF EXISTS source_jobs;
DROP TABLE IF EXISTS knowledge_area_members;
DROP TABLE IF EXISTS knowledge_areas;
DROP TABLE IF EXISTS source_sets;

DROP TRIGGER IF EXISTS chat_vectors_message_deleted;
DROP TRIGGER IF EXISTS chat_vectors_message_changed;
DROP TABLE IF EXISTS chat_vectors;
UPDATE knowledge SET embedding = NULL, embedding_profile = NULL WHERE embedding IS NOT NULL OR embedding_profile IS NOT NULL;

DROP TABLE IF EXISTS macros;
DROP TABLE IF EXISTS chat_note_revisions;
DROP TABLE IF EXISTS native_deletions;
DROP TABLE IF EXISTS person_settings;
DROP TABLE IF EXISTS agent_revisions;

DROP TABLE IF EXISTS territory_focus;
DROP TABLE IF EXISTS territory_routes;
DROP TABLE IF EXISTS territories;
DROP TABLE IF EXISTS secret_grant_log;
DROP TABLE IF EXISTS secret_areas;

DELETE FROM kv WHERE ns IN ('knowledge.curator', 'lifecycle', 'person_notice', 'person_due', 'person_report', 'recipes', 'task_worktrees');
DELETE FROM kv WHERE ns = 'privacy' AND key LIKE 'renew:%';
`;
