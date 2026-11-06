// Repository for `files` (metadata of content-addressed blobs; id = sha256 of the bytes).
// Owns: SQL and row↔FileRef mapping, the text cache column, deleting a row (MM6: only
// Blobs.remove calls it, once the blob is gone). Never: touches blob bytes or decides whether
// a file may go (files/cleanup.ts and files/references.ts do).

import type { Db, Row } from '../db/database.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { compact, nul, optNumber } from './rows.ts';

/** Length of the text head exposed on FileRef (the full cached text stays in the row). */
export const PREVIEW_HEAD = 400;

function toFile(row: Row): FileRef {
  const text = row.text_preview;
  return compact({
    id: String(row.id),
    name: String(row.name),
    mime: String(row.mime),
    size: Number(row.size),
    createdAt: Number(row.created_at),
    textPreview: typeof text === 'string' && text ? text.slice(0, PREVIEW_HEAD) : undefined,
    width: optNumber(row.width),
    height: optNumber(row.height),
    durationMs: optNumber(row.duration_ms),
  });
}

export class FileRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): FileRef | undefined {
    const row = this.db.get('SELECT * FROM files WHERE id = ?', [id]);
    return row ? toFile(row) : undefined;
  }

  /** Inserts metadata once; an existing row (same content) is kept as is. */
  insert(file: FileRef): FileRef {
    this.db.run(
      `INSERT INTO files (id, name, mime, size, created_at, text_preview, width, height, duration_ms)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [file.id, file.name, file.mime, file.size, file.createdAt, nul(file.width), nul(file.height), nul(file.durationMs)],
    );
    return this.get(file.id)!;
  }

  /**
   * Cached extracted text: undefined = not extracted yet, '' = extracted, nothing readable.
   */
  cachedText(id: string): string | undefined {
    const row = this.db.get<{ text_preview: string | null }>('SELECT text_preview FROM files WHERE id = ?', [id]);
    return row?.text_preview ?? undefined;
  }

  setText(id: string, text: string): void {
    this.db.run('UPDATE files SET text_preview = ? WHERE id = ?', [text, id]);
  }

  addRefs(id: string, delta: number): void {
    this.db.run('UPDATE files SET refs = MAX(0, refs + ?) WHERE id = ?', [delta, id]);
  }

  /** Deletes the metadata row (its `media` row follows by the foreign key). True when it existed. */
  remove(id: string): boolean {
    return this.db.run('DELETE FROM files WHERE id = ?', [id]).changes > 0;
  }

  setMedia(id: string, media: { width?: number; height?: number; durationMs?: number }): void {
    this.db.run(
      'UPDATE files SET width = COALESCE(?, width), height = COALESCE(?, height), duration_ms = COALESCE(?, duration_ms) WHERE id = ?',
      [nul(media.width), nul(media.height), nul(media.durationMs), id],
    );
  }
}
