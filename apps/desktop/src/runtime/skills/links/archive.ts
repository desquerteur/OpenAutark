// The files of a skill source as one bounded view (AF-007): a ZIP (downloaded, a GitHub archive or uploaded) read through
// files/zip.ts, or a single SKILL.md. Every entry name is checked before anything else sees it: '/' and '\' are both
// separators; absolute paths, drive letters, '.' and '..', control characters, names Windows cannot hold (<>:"|?*, a
// trailing dot or space, CON, NUL, COM1 …) and names that differ only in case are left out with the reason, as are links,
// devices, encrypted entries and entries that inflate suspiciously far. Bytes are inflated only when a file is read, under
// a budget the caller holds (files/zip.ts stops a "zip bomb" at that budget, not at the size the archive claims).
// Owns: LINK_LIMITS, the entry-name rules and the view. Never: writes, runs or follows a path to the file system.

import { readEntry, zipBudget, zipComment, zipEntries, ZipError, type ZipBudget, type ZipEntry } from '../../files/zip.ts';
import { WorkforceError } from '../../../shared/errors.ts';

export const LINK_LIMITS = {
  /** A downloaded or uploaded ZIP. */
  archiveBytes: 64 * 1024 * 1024,
  /** A SKILL.md (as the skill discovery reads it). */
  skillFileBytes: 256 * 1024,
  /** One file of a skill. */
  fileBytes: 10 * 1024 * 1024,
  /** All files of one skill. */
  skillBytes: 30 * 1024 * 1024,
  /** Files of one skill. */
  skillFiles: 500,
  /** Skills one source lists at most. */
  skills: 100,
  /** Folder depth of a skill below the linked folder. */
  depth: 8,
  /** Inflated / compressed at most for a file over 1 MB. */
  ratio: 200,
} as const;

export interface SourceFile {
  /** Relative to the source root, '/' separators, checked. */
  path: string;
  size: number;
  /** Unix mode from the archive (0 when it says none). */
  mode: number;
  read(budget: ZipBudget): Promise<Buffer>;
}

export interface SourceView {
  files: Map<string, SourceFile>;
  /** Entries left out, with why ('link', 'unsafe name', …). */
  skipped: Array<{ path: string; reason: string }>;
  /** git archive's commit id, when the archive carries one. */
  commit?: string;
}

const WINDOWS_BAD = /[<>:"|?*]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const MAX_PATH = 400;

/** The checked relative path of an archive entry name, or why it is not allowed. */
export function entryPath(name: string): { path: string } | { problem: string } {
  if (/[\u0000-\u001f\u007f]/.test(name)) return { problem: 'unsafe name' };
  const slashed = name.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return { problem: 'absolute path' };
  const parts = slashed.split('/').filter((part) => part !== '');
  if (!parts.length) return { problem: 'unsafe name' };
  for (const part of parts) {
    if (part === '.' || part === '..') return { problem: 'path outside the folder' };
    if (WINDOWS_BAD.test(part) || /[. ]$/.test(part) || RESERVED.test(part) || part.length > 255) return { problem: 'unsafe name' };
  }
  const path = parts.join('/');
  return path.length > MAX_PATH ? { problem: 'path too long' } : { path };
}

/** One SKILL.md as a source of its own (a direct address). */
export function fileView(bytes: Buffer): SourceView {
  if (bytes.byteLength > LINK_LIMITS.skillFileBytes) throw new WorkforceError('bad_request', 'This SKILL.md is larger than 256 KB.');
  const file: SourceFile = { path: 'SKILL.md', size: bytes.byteLength, mode: 0, read: async (budget) => { budget.left -= bytes.byteLength; return Buffer.from(bytes); } };
  return { files: new Map([[file.path, file]]), skipped: [] };
}

/**
 * The files of a ZIP. `stripTop`: every entry lies in one top folder (a GitHub archive's `<repo>-<ref>/`), which the
 * paths leave out. `prefix`: only the files below this folder of the source (a GitHub folder link) are kept.
 */
export function zipView(buf: Buffer, options: { stripTop?: boolean; prefix?: string } = {}): SourceView {
  if (buf.byteLength > LINK_LIMITS.archiveBytes) throw new WorkforceError('bad_request', 'This ZIP is larger than 64 MB.');
  let entries: Map<string, ZipEntry>;
  let comment = '';
  try {
    entries = zipEntries(buf);
    comment = zipComment(buf).trim();
  } catch (error) {
    throw new WorkforceError('bad_request', error instanceof ZipError ? `This is no ZIP a skill can come from (${error.message}).` : 'This ZIP could not be read.');
  }
  const view: SourceView = { files: new Map(), skipped: [], ...(/^[0-9a-f]{40}$/.test(comment) ? { commit: comment } : {}) };
  const folded = new Set<string>();
  let top: string | undefined;
  const prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
  for (const entry of entries.values()) {
    if (entry.name.endsWith('/') || entry.name.endsWith('\\')) continue; // a folder: its files say everything
    const checked = entryPath(entry.name);
    if ('problem' in checked) { view.skipped.push({ path: entry.name.slice(0, 200), reason: checked.problem }); continue; }
    let path = checked.path;
    if (options.stripTop) {
      const slash = path.indexOf('/');
      const first = slash < 0 ? '' : path.slice(0, slash);
      top ??= first;
      if (!first || first !== top) { view.skipped.push({ path, reason: 'outside the archive folder' }); continue; }
      path = path.slice(slash + 1);
    }
    if (prefix) {
      if (!path.startsWith(prefix)) continue; // another folder of the repository: not part of this source
      path = path.slice(prefix.length);
    }
    const mode = (entry.external >>> 16) & 0xffff;
    const type = mode & S_IFMT;
    if (type === S_IFLNK) { view.skipped.push({ path, reason: 'link' }); continue; }
    if (type === S_IFDIR) continue;
    if (type && type !== S_IFREG) { view.skipped.push({ path, reason: 'not a file' }); continue; }
    if (entry.flags & 0x1) { view.skipped.push({ path, reason: 'encrypted' }); continue; }
    if (entry.method !== 0 && entry.method !== 8) { view.skipped.push({ path, reason: 'unsupported compression' }); continue; }
    if (entry.size > 1024 * 1024 && entry.size > entry.compressed * LINK_LIMITS.ratio) { view.skipped.push({ path, reason: 'inflates suspiciously far' }); continue; }
    const key = path.toLowerCase();
    if (folded.has(key)) { view.skipped.push({ path, reason: 'same name as another file' }); continue; }
    folded.add(key);
    view.files.set(path, {
      path, size: entry.size, mode,
      read: async (budget) => {
        if (entry.size > LINK_LIMITS.fileBytes) throw new WorkforceError('bad_request', `${path} is larger than 10 MB.`);
        try {
          const bytes = await readEntry(buf, entry, budget);
          if (bytes.byteLength > LINK_LIMITS.fileBytes) throw new WorkforceError('bad_request', `${path} is larger than 10 MB.`);
          return bytes;
        } catch (error) {
          if (error instanceof WorkforceError) throw error;
          throw new WorkforceError('bad_request', `${path} could not be read from the ZIP (${error instanceof ZipError ? error.message : 'damaged'}).`);
        }
      },
    });
  }
  return view;
}

/** A fresh inflate budget for one skill. */
export const skillBudget = (): ZipBudget => zipBudget(LINK_LIMITS.skillBytes);
