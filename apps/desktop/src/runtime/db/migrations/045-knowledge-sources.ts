// Migration 45 (KS1): the source corpus – provided and public texts (bundled guide, built-in and
// installed skills), the person's project folders and files, and episodes of finished agent runs –
// as source- and version-bound chunks beside the knowledge notes, plus named knowledge areas and
// the person's "Make searchable" embedding jobs (runtime/sources/*).
// source_sets: one registered source. `kind` guide | skills | installed-skills | folder | file | work;
//   `root` the absolute path of a folder/file source (NULL for bundled kinds: resolved from the app's
//   paths at run time); `live` 1 = watched for changes; `embed_profile` the embedding profile the
//   person made it searchable with (NULL = keyword search only).
// source_docs: one file (or one run for kind work) of a set – `path` relative to the root with '/',
//   `hash` sha256 of the original bytes (the version), `mtime`/`size` for the start-up reconcile,
//   `owner_agent` only for work episodes (readable by that agent and the person). The id stays the
//   same for a path across versions, so a chunk reference `<docId>:<seq>` survives re-indexing.
// source_chunks: the searchable parts of a doc (`seq` order, `parent_seq` the section or episode
//   chunk it belongs to, `start` offset in the doc text, `pointer` JSON back to the original –
//   run item ids of an episode segment), with an optional vector of one embedding profile.
//   source_chunks_fts mirrors heading and body (folded text, rowid = chunk id); a trigger keeps it
//   in step with every delete, also the cascade from a removed doc or set.
// knowledge_areas / knowledge_area_members: named areas; members are sources (kind 'source', ref =
//   set id) and readers (kind 'reader', ref '*' | 'agent:<id>' | 'space:<id>') – overlapping.
// source_jobs: the person's "Make searchable" jobs and the re-embed jobs after a profile change
//   (state running | paused | done | cancelled | failed); progress survives a restart.
// Never: a copy of chat messages (they stay canonical in `messages`) or secret values (texts pass the
// vault redaction and the generic scrub runtime/sources/scrub.ts before they are stored). Migration 46
// rebuilds source_chunks (set_id, BLOB last, covering index) and turns on FTS5 secure-delete.

export const sql = /* sql */ `
CREATE TABLE source_sets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  root TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  embed_profile TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  scanned_at INTEGER,
  error TEXT
) STRICT;

CREATE TABLE source_docs (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES source_sets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  owner_agent TEXT,
  indexed_at INTEGER NOT NULL,
  UNIQUE (set_id, path)
) STRICT;
CREATE INDEX source_docs_owner ON source_docs(owner_agent) WHERE owner_agent IS NOT NULL;

CREATE TABLE source_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES source_docs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  parent_seq INTEGER,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  start INTEGER NOT NULL,
  pointer TEXT,
  embedding BLOB,
  embedding_profile TEXT,
  UNIQUE (doc_id, seq)
) STRICT;
CREATE INDEX source_chunks_profile ON source_chunks(embedding_profile, id);

CREATE VIRTUAL TABLE source_chunks_fts USING fts5(heading, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER source_chunks_fts_delete AFTER DELETE ON source_chunks BEGIN
  DELETE FROM source_chunks_fts WHERE rowid = old.id;
END;

CREATE TABLE knowledge_areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX knowledge_areas_name ON knowledge_areas(name COLLATE NOCASE);

CREATE TABLE knowledge_area_members (
  area_id TEXT NOT NULL REFERENCES knowledge_areas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (area_id, kind, ref)
) STRICT;
CREATE INDEX knowledge_area_members_ref ON knowledge_area_members(kind, ref);

CREATE TABLE source_jobs (
  id TEXT PRIMARY KEY,
  set_ids TEXT NOT NULL,
  profile TEXT NOT NULL,
  state TEXT NOT NULL,
  total INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX source_jobs_state ON source_jobs(state, created_at);
`;
