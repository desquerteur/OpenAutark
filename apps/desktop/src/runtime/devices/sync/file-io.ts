// Whole files between linked PCs, the plain parts the file, blob and login syncs share: a piece of a file for the
// other PC (at most 1 MiB, like send-file.ts), the pieces of one pulled into a temp file, and putting a file in
// place whole – a rename of the temp file beside it; where Windows refuses the rename (EPERM, EBUSY, EACCES: the
// target is open elsewhere, e.g. by a virus scanner), the bytes are copied over the target instead.
// Owns: these reads and writes. Never: decides which paths may be read or written (the callers do) or logs content.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, lstat, open, rename, rm } from 'node:fs/promises';

/** B-077: 1 MiB (was 4): a piece is one frame on the link, and the 15 s keepalive pings must not wait behind it on a slow path. */
export const PIECE = 1024 * 1024;

export interface Piece { data: string; size: number }

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The piece of `file` at `offset` (base64) with the file's size; undefined when it is no file. */
export async function readPiece(file: string, offset: number): Promise<Piece | undefined> {
  if (!(await lstat(file).catch(() => undefined))?.isFile()) return undefined;
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.max(0, Math.min(PIECE, size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return { data: buffer.subarray(0, bytesRead).toString('base64'), size };
  } finally {
    await handle.close();
  }
}

/** Appends every piece `get` returns to `temp` until the file is whole. */
export async function pullPieces(temp: string, get: (offset: number) => Promise<unknown>): Promise<void> {
  for (let offset = 0; ;) {
    const piece = await get(offset) as Partial<Piece> | undefined;
    if (typeof piece?.data !== 'string' || typeof piece.size !== 'number') throw new Error('not a file piece');
    const bytes = Buffer.from(piece.data, 'base64');
    await appendFile(temp, bytes, { mode: 0o600 });
    offset += bytes.length;
    if (offset >= piece.size || !bytes.length) return;
  }
}

const REFUSED: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Puts `temp` in place of `file` (same folder): a rename (`move`, tests), or a copy over the target where the rename is refused. */
export async function replaceWith(temp: string, file: string, move: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  try {
    await move(temp, file);
  } catch (error) {
    if (!REFUSED.has(String((error as NodeJS.ErrnoException)?.code))) throw error;
    await copyFile(temp, file);
    await rm(temp, { force: true });
  }
}
