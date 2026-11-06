// Migration 50 (media segments, 23.10.2026): precise parts of a stored file as first-class,
// searchable metadata – an image region, a time span of a recording or video, or a region within a
// video's time span – written by the person or an agent (runtime/media/segments.ts), plus text
// vectors of the configured embedding profile for files and segments (runtime/media/vectors.ts).
// media_segments: `start_ms`/`end_ms` the span (both or neither), `x`/`y`/`w`/`h` the region as
//   fractions 0–1 of the picture (all or none); `tags` a JSON list; `created_by` 'human' or an
//   agent id. A segment goes with its media row (ON DELETE CASCADE from media, which goes with its
//   files row), so deleting a file removes everything derived from it.
// media_segments_fts mirrors description and tags (folded text, rowid = the segment's rowid); a
//   trigger removes the mirror with every delete, also the cascade. FTS5 'secure-delete' (as
//   migration 46 for source chunks): a deleted or changed segment's words leave the index at once,
//   not only at the next merge.
// media_vectors: one unit vector per item – a file id (name, description, tags) or a segment id –
//   of one embedding profile; `hash` names the text it was made from (re-embedded when that
//   changes). Rows go with their media row and, for segments, with the segment (trigger).
// Never: file bytes, page or chat text, or query vectors.

export const sql = /* sql */ `
CREATE TABLE media_segments (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES media(file_id) ON DELETE CASCADE,
  start_ms INTEGER, end_ms INTEGER,
  x REAL, y REAL, w REAL, h REAL,
  description TEXT, tags TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX media_segments_file ON media_segments(file_id, start_ms);

CREATE VIRTUAL TABLE media_segments_fts USING fts5(segment_id UNINDEXED, file_id UNINDEXED, description, tags, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO media_segments_fts (media_segments_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER media_segments_fts_delete AFTER DELETE ON media_segments BEGIN
  DELETE FROM media_segments_fts WHERE rowid = old.rowid;
END;

CREATE TABLE media_vectors (
  item TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES media(file_id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX media_vectors_profile ON media_vectors(profile, file_id);
CREATE TRIGGER media_vectors_segment_delete AFTER DELETE ON media_segments BEGIN
  DELETE FROM media_vectors WHERE item = old.id;
END;
`;
