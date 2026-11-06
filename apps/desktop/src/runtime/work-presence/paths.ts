// B-055 G (WORK-PRESENCE, Q11): one spelling per file for the work-presence ledger, and the short form an agent reads.
// A path from any engine (Claude's absolute file_path, a Codex patch's relative one, our files tools' real path) is
// resolved against the folder the call ran in; on Windows the key is case-folded with backslashes, so "C:/a/B.ts" and
// "c:\a\b.ts" are one file. The file keeps its spelling for display.
// Owns: resolveFile (key + file), isUnder (a folder's files – never through a `.worktrees` folder below it: another
// task's own worktree is a separate copy) and shownPath (relative to a base, '/'-separated, clipped).
// Never: touches the file system (no realpath – callers that have the real path pass it).

import path from 'node:path';

/** Longest path an agent reads in a presence line (the tail is kept). */
export const SHOWN_MAX = 60;
const WORKTREES = '.worktrees';

export interface FileRef {
  /** The match key: absolute, normalized, case-folded on Windows. */
  key: string;
  /** The absolute path as spelled (normalized). */
  file: string;
}

const api = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** A path as the ledger keys it, resolved against `base` (the call's folder). Undefined for an empty path. */
export function resolveFile(given: string, base: string, platform: NodeJS.Platform = process.platform): FileRef | undefined {
  const trimmed = given.trim();
  if (!trimmed) return undefined;
  const p = api(platform);
  let file = p.resolve(base, trimmed);
  if (file.length > p.parse(file).root.length) file = file.replace(/[\\/]+$/, '');
  return { key: platform === 'win32' ? file.toLowerCase() : file, file };
}

/** The key of a folder (same rules as a file). */
export function folderKey(dir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return resolveFile(dir, dir, platform)?.key;
}

/** Is the file `key` inside the folder `dirKey` – not through a `.worktrees` folder below it (another task's copy)? */
export function isUnder(key: string, dirKey: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = api(platform).sep;
  const prefix = dirKey.endsWith(sep) ? dirKey : dirKey + sep;
  if (!key.startsWith(prefix)) return false;
  return !key.slice(prefix.length).split(sep).slice(0, -1).includes(WORKTREES);
}

/** `file` relative to the first base it is inside ('/'-separated), else its last three parts; clipped to SHOWN_MAX from the left. */
export function shownPath(file: string, bases: ReadonlyArray<string | undefined>, platform: NodeJS.Platform = process.platform): string {
  const p = api(platform);
  let shown = '';
  for (const base of bases) {
    if (!base) continue;
    const relative = p.relative(base, file);
    if (relative && !relative.startsWith('..') && !p.isAbsolute(relative)) { shown = relative; break; }
  }
  if (!shown) {
    const parts = file.split(/[\\/]+/).filter(Boolean);
    shown = parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : file;
  }
  shown = shown.replace(/\\/g, '/');
  return shown.length > SHOWN_MAX ? `…${shown.slice(shown.length - SHOWN_MAX + 1)}` : shown;
}
