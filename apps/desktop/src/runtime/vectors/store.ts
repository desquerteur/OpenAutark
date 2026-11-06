// The stored vectors (migration vector-chunks): one row per embedded file (path, mtime and size when it was read, the
// embedding model, how many of its chunks are done) and one per chunk (line range, a short snippet, the vector as int8).
// Int8: 384 bytes per chunk with the local model, and a scan over 100k chunks stays a plain loop. Search reads rows in
// pages so the event loop gets a turn between them.
// Owns: the SQL of vector_files and vector_chunks and the int8 form. Never: reads files, embeds or decides what is embedded.

import type { Db } from '../db/database.ts';
import type { VectorHit } from '../../shared/model/vectors.ts';

export interface VectorFileRow {
  id: number;
  key: string;
  path: string;
  mtime: number;
  size: number;
  model: string;
  chunks: number;
  done: number;
}

export interface ChunkRow {
  chunk: number;
  from?: number;
  to?: number;
  snippet: string;
  vector: Int8Array;
}

const PAGE = 2000;

/** A unit vector as int8 (a score is the dot product over 127). */
export function toInt8(vector: Float32Array): Int8Array {
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return out;
}

/** The first key after every key below `key/` ('0' follows '/'). */
const rangeEnd = (key: string) => `${key}0`;

export class VectorStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  file(key: string): VectorFileRow | undefined {
    return this.db.get<VectorFileRow>('SELECT id, key, path, mtime, size, model, chunks, done FROM vector_files WHERE key = ?', [key]);
  }

  /** The files at or below a place's key (any model). */
  filesUnder(key: string): VectorFileRow[] {
    return this.db.all<VectorFileRow>(
      `SELECT id, key, path, mtime, size, model, chunks, done FROM vector_files WHERE key = ? OR (key >= ? AND key < ?)`,
      [key, `${key}/`, rangeEnd(key)],
    );
  }

  /** Files embedded with another model (what a model change re-embeds), oldest first. */
  staleFiles(model: string, limit: number): VectorFileRow[] {
    return this.db.all<VectorFileRow>('SELECT id, key, path, mtime, size, model, chunks, done FROM vector_files WHERE model <> ? ORDER BY embedded_at LIMIT ?', [model, limit]);
  }

  /** Starts a file over: its old chunks go, `chunks` new ones are expected. */
  begin(key: string, stored: string, mtime: number, size: number, model: string, chunks: number): number {
    return this.db.tx(() => {
      const known = this.file(key);
      if (known) this.db.run('DELETE FROM vector_chunks WHERE file_id = ?', [known.id]);
      this.db.run(
        `INSERT INTO vector_files (key, path, mtime, size, model, chunks, done, embedded_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET path = excluded.path, mtime = excluded.mtime, size = excluded.size, model = excluded.model, chunks = excluded.chunks, done = 0, embedded_at = excluded.embedded_at`,
        [key, stored, mtime, size, model, chunks, this.now()],
      );
      return (this.file(key) as VectorFileRow).id;
    });
  }

  /** Stores finished chunks; `done` is the file's count afterwards. False: the file left the store meanwhile. */
  put(fileId: number, rows: ChunkRow[], done: number): boolean {
    return this.db.tx(() => {
      if (!this.db.get('SELECT 1 AS hit FROM vector_files WHERE id = ?', [fileId])) return false;
      for (const row of rows) {
        this.db.run('INSERT OR REPLACE INTO vector_chunks (file_id, chunk, line_from, line_to, vector, snippet) VALUES (?, ?, ?, ?, ?, ?)',
          [fileId, row.chunk, row.from ?? null, row.to ?? null, new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), row.snippet]);
      }
      this.db.run('UPDATE vector_files SET done = ? WHERE id = ?', [done, fileId]);
      return true;
    });
  }

  remove(key: string): void {
    this.db.run('DELETE FROM vector_files WHERE key = ?', [key]);
  }

  /** The files at or below `key` go. */
  removeUnder(key: string): void {
    this.db.run('DELETE FROM vector_files WHERE key = ? OR (key >= ? AND key < ?)', [key, `${key}/`, rangeEnd(key)]);
  }

  /** The best `k` chunks of `fileIds` by dot product with the unit `query`; the event loop gets a turn between pages. */
  async top(query: Float32Array, fileIds: ReadonlySet<number>, k: number): Promise<Array<{ fileId: number; chunk: number; score: number }>> {
    return (await this.topMany([query], fileIds, k))[0] ?? [];
  }

  /** The best `k` chunks for each query in one scan of the chunks (a hop of vectors/hops.ts scores its whole beam at once). */
  async topMany(queries: readonly Float32Array[], fileIds: ReadonlySet<number>, k: number): Promise<Array<Array<{ fileId: number; chunk: number; score: number }>>> {
    const lists = queries.map(() => [] as Array<{ fileId: number; chunk: number; score: number }>);
    if (!queries.length) return lists;
    let after = 0;
    for (;;) {
      const page = this.db.all<{ rowid: number; file_id: number; chunk: number; vector: Uint8Array }>(
        'SELECT rowid, file_id, chunk, vector FROM vector_chunks WHERE rowid > ? ORDER BY rowid LIMIT ?', [after, PAGE],
      );
      for (const row of page) {
        if (!fileIds.has(row.file_id)) continue;
        const bytes = row.vector;
        for (const [index, query] of queries.entries()) {
          const dims = query.length;
          if (bytes.length !== dims) continue;
          const best = lists[index];
          let dot = 0;
          for (let i = 0; i < dims; i++) dot += query[i] * ((bytes[i] << 24) >> 24); // a byte read as int8
          if (best.length === k && dot <= best[k - 1].score) continue;
          let at = best.length === k ? k - 1 : best.length;
          while (at > 0 && best[at - 1].score < dot) { best[at] = best[at - 1]; at--; }
          best[at] = { fileId: row.file_id, chunk: row.chunk, score: dot };
        }
      }
      if (page.length < PAGE) break;
      after = page[page.length - 1].rowid;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return lists.map((best) => best.map((hit) => ({ ...hit, score: hit.score / 127 })));
  }

  /** A stored chunk's vector as a unit float vector (the next query of a hop, vectors/hops.ts); undefined when it is gone. */
  vectorOf(fileId: number, chunk: number): Float32Array | undefined {
    const row = this.db.get<{ vector: Uint8Array }>('SELECT vector FROM vector_chunks WHERE file_id = ? AND chunk = ?', [fileId, chunk]);
    if (!row) return undefined;
    const out = new Float32Array(row.vector.length);
    let length = 0;
    for (let i = 0; i < out.length; i++) { out[i] = (row.vector[i] << 24) >> 24; length += out[i] * out[i]; }
    length = Math.sqrt(length) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= length;
    return out;
  }

  /** The stored line range and snippet of a found chunk. */
  chunk(fileId: number, chunk: number): Pick<VectorHit, 'lines' | 'snippet'> | undefined {
    const row = this.db.get<{ line_from: number | null; line_to: number | null; snippet: string }>('SELECT line_from, line_to, snippet FROM vector_chunks WHERE file_id = ? AND chunk = ?', [fileId, chunk]);
    if (!row) return undefined;
    return { snippet: row.snippet, ...(row.line_from !== null && row.line_to !== null ? { lines: [row.line_from, row.line_to] as [number, number] } : {}) };
  }
}
