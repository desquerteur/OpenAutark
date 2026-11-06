// Migration 88 (01.11.2026): the vector system's store (runtime/vectors/store.ts) – one row per file a model embedded on
// purpose (or a memory file), one per chunk with its vector as int8. A file's chunks go with it.
// Owns: the schema of vector_files and vector_chunks. Never: data rows, or edits of shipped migrations.

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS vector_files (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  model TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  done INTEGER NOT NULL,
  embedded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS vector_files_model ON vector_files(model, embedded_at);
CREATE TABLE IF NOT EXISTS vector_chunks (
  rowid INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES vector_files(id) ON DELETE CASCADE,
  chunk INTEGER NOT NULL,
  line_from INTEGER,
  line_to INTEGER,
  vector BLOB NOT NULL,
  snippet TEXT NOT NULL,
  UNIQUE (file_id, chunk)
) STRICT;
`;
