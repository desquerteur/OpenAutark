// A minimal, bounded ZIP reader for documents held in memory (Office files, office.ts): the end of
// central directory record, the central directory and stored/deflated entries, inflated with
// node:zlib under a per-entry and a per-file output budget (a "zip bomb" stops at the budget, not at
// the size the archive claims). ZIP64, encrypted entries, multi-disk archives and other methods are
// refused – Office writes none of them for ordinary documents.
// Owns: the record layout, these limits and their errors. Never: writes files, follows entry paths
// to the file system, or inflates an entry nobody asked for.

import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

const inflate = promisify(inflateRaw);

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff; // the record plus the longest comment

export const ZIP_LIMITS = {
  /** Entries listed in the central directory at most. */
  entries: 20_000,
  /** Inflated bytes of one entry at most. */
  entryBytes: 32 * 1024 * 1024,
  /** Inflated bytes of all entries read from one archive at most. */
  totalBytes: 96 * 1024 * 1024,
};

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressed: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

/** The shared inflate budget of one archive (bytes still allowed). */
export interface ZipBudget { left: number }

export function zipBudget(total = ZIP_LIMITS.totalBytes): ZipBudget {
  return { left: total };
}

function findEnd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_SEARCH);
  for (let at = buf.length - EOCD_MIN; at >= stop; at--) {
    if (buf.readUInt32LE(at) === EOCD) return at;
  }
  throw new ZipError('not a zip archive');
}

/** Every entry of the central directory by name (later duplicates are ignored). */
export function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length < EOCD_MIN) throw new ZipError('not a zip archive');
  const end = findEnd(buf);
  const disk = buf.readUInt16LE(end + 4);
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  if (disk !== 0) throw new ZipError('multi-disk archives are not supported');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (count > ZIP_LIMITS.entries) throw new ZipError('too many entries');
  if (start + size > end) throw new ZipError('damaged central directory');
  const out = new Map<string, ZipEntry>();
  let at = start;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('damaged central directory');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const length = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (!out.has(name)) out.set(name, { name, method, flags, compressed, size: length, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The inflated bytes of one entry; spends them from `budget`. */
export async function readEntry(buf: Buffer, entry: ZipEntry, budget: ZipBudget): Promise<Buffer> {
  if (entry.flags & 0x1) throw new ZipError('encrypted entries are not supported');
  const allowed = Math.min(ZIP_LIMITS.entryBytes, budget.left);
  if (entry.size > allowed) throw new ZipError('entry too large');
  const at = entry.offset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new ZipError('damaged entry');
  const data = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  if (data + entry.compressed > buf.length) throw new ZipError('damaged entry');
  const raw = buf.subarray(data, data + entry.compressed);
  let out: Buffer;
  if (entry.method === 0) out = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      out = await inflate(raw, { maxOutputLength: Math.max(1, allowed) });
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new ZipError(code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'entry too large' : 'damaged entry');
    }
  } else throw new ZipError('unsupported compression');
  budget.left -= out.length;
  return out;
}
