// Migration 46 (KS1 review): source_chunks gets its set id (denormalized from source_docs, which never
// changes it) and a column order with the vector BLOB last, so the job and coverage queries read
// `set_id` / `embedding_profile` from one covering index (source_chunks_set) instead of walking every
// row's overflow pages and sorting the whole set per batch. Ids stay the same (chunk refs, the FTS
// rowids and the AUTOINCREMENT high-water mark are kept); the delete trigger is re-created on the new
// table. The FTS index of the chunks gets FTS5 'secure-delete' (SQLite 3.42+): a deleted chunk's
// tokens are removed from the index segments at once, not only at the next merge.
// Never: drops data – every row is copied – or touches another package's tables (knowledge_fts keeps
// its own way: an FTS optimize after a Forget, knowledge/erase.ts; see docs/ARCHITECTURE.md §7).

export const sql = /* sql */ `
CREATE TABLE source_chunks_v46 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES source_docs(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_seq INTEGER,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  start INTEGER NOT NULL,
  pointer TEXT,
  embedding_profile TEXT,
  embedding BLOB,
  UNIQUE (doc_id, seq)
) STRICT;

INSERT INTO source_chunks_v46 (id, doc_id, set_id, seq, parent_seq, heading, body, start, pointer, embedding_profile, embedding)
  SELECT c.id, c.doc_id, d.set_id, c.seq, c.parent_seq, c.heading, c.body, c.start, c.pointer, c.embedding_profile, c.embedding
    FROM source_chunks c JOIN source_docs d ON d.id = c.doc_id;

DELETE FROM sqlite_sequence WHERE name = 'source_chunks_v46';
INSERT INTO sqlite_sequence (name, seq) SELECT 'source_chunks_v46', seq FROM sqlite_sequence WHERE name = 'source_chunks';

DROP TABLE source_chunks;
ALTER TABLE source_chunks_v46 RENAME TO source_chunks;

CREATE INDEX source_chunks_profile ON source_chunks(embedding_profile, id);
CREATE INDEX source_chunks_set ON source_chunks(set_id, id, embedding_profile);

CREATE TRIGGER source_chunks_fts_delete AFTER DELETE ON source_chunks BEGIN
  DELETE FROM source_chunks_fts WHERE rowid = old.id;
END;

INSERT INTO source_chunks_fts (source_chunks_fts, rank) VALUES ('secure-delete', 1);
`;
