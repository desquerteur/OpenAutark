// The app's own writes in the open data folder (B-044, runtime/root; split out of watcher.ts): what the app last
// wrote to a path – its size and content hash, or null when it removed the file – so the RootWatcher drops the
// events of those writes. A path holds the app's write while it has exactly that content; the first look that
// finds anything else drops the mark (an outside edit back to the same text is an edit again). Content hashes,
// not file times: two quick writes of the same size can share a time stamp on Windows.
// Owns: the marks (bounded, the oldest goes first). Never: watches, decides what a change means, or reads a file
// that has no mark.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

/** Marks kept (the oldest goes first). */
const MAX_MARKS = 1000;
/** Larger own writes are not marked: their events always reach the owner. */
const MAX_MARK_BYTES = 4 * 1024 * 1024;

/** What the app last wrote to a path: its size and hash (null: it removed the file). */
type Mark = { size: number; hash: string } | null;

export class OwnMarks {
  private readonly marks = new Map<string, Mark>();

  /** The app wrote `content` to the path looked up by `key` (null: it removed the file). */
  set(key: string, content: string | null): void {
    this.marks.delete(key);
    const size = content === null ? 0 : Buffer.byteLength(content, 'utf8');
    if (size <= MAX_MARK_BYTES) this.marks.set(key, content === null ? null : { size, hash: digest(content) });
    if (this.marks.size > MAX_MARKS) this.marks.delete(this.marks.keys().next().value as string);
  }

  /** True when `file` (marked under `key`) still holds exactly what the app last wrote there; the mark goes once it does not. */
  holds(key: string, file: string): boolean {
    if (!this.marks.has(key)) return false;
    if (matches(file, this.marks.get(key)!)) return true;
    this.marks.delete(key);
    return false;
  }

  clear(): void {
    this.marks.clear();
  }
}

function matches(file: string, mark: Mark): boolean {
  let size: number;
  try {
    const info = lstatSync(file);
    if (!info.isFile()) return false;
    size = info.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return mark === null && (code === 'ENOENT' || code === 'ENOTDIR');
  }
  if (mark === null || size !== mark.size) return false;
  try { return digest(readFileSync(file)) === mark.hash; } catch { return false; }
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('base64');
}
