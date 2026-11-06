// One text file of the open data folder that the app writes and a person, an editor, a script or an AI may
// change on disk at the same time (B-044 Phase 1, contract §5; extracted from agent-core/{layout,store}.ts):
//   - canonical compare: a UTF-8 BOM, CR line ends and trailing white space are no change (canonical);
//   - a bounded, validated read: lstat (a link is never followed: 'unreadable'), the size checked before
//     anything is read, no NUL, strict UTF-8, a character cap (readText); TextDoc.check costs one stat and
//     reads the file again only when its signature (mtime + size) changed;
//   - an atomic write: a temporary file in the same folder, then rename over the target. A rename Windows
//     refuses for a moment (a virus scanner or the indexer holding the new file) is tried again a few times;
//     where an editor holds the target open without delete sharing, the file is written in place (never
//     through a link). The data folder watcher is told (OwnWrites), so the write's own events are no outside edit;
//   - base/conflict: an edit that started from `base` never overwrites a change made meanwhile (staleBase,
//     TextDoc.writeFrom); isOutside tells whether the file is still the app's own last write;
//   - a rejected copy: a file the app replaces or refuses is kept once as <name>.rejected.<ext>;
//   - a quiet notice hook: one deduplicated problem per document (notice.ts), told only when it comes, changes or goes.
// Owns: these file mechanics. Never: decides what wins (the owner's rules), parses the text, polls or watches.

import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Clock } from '../contracts.ts';
import { QuietNotice, type NoticeHook, type TextNotice } from './notice.ts';

/** Why a file's text is not used as it is (a missing file is `kind: 'missing'`, no problem). */
export type TextProblem = 'too-large' | 'not-text' | 'unreadable';

/** What the file holds right now. `sig` (mtime + size) tells a later stat whether it changed. */
export type TextRead =
  | { kind: 'ok'; text: string; sig: string }
  | { kind: 'missing' }
  | { kind: 'problem'; problem: TextProblem; sig: string };

export interface TextLimits {
  /** Larger files are not read at all. */
  maxBytes: number;
  /** The longest text after canonical(); absent = only maxBytes. */
  maxChars?: number;
}

/** Told about every file the app writes (or, with null, removes) – the RootWatcher: those events are no outside edit. */
export interface OwnWrites {
  wrote(file: string, content: string | null): void;
}

/** Waits before a refused rename is tried again (Windows only; then the in-place write). */
const RENAME_RETRY_MS = [5, 15, 30];
const REJECTED = /\.rejected(?:\.[^.\\/]+)?$/;

/** The text as the app compares and stores it: BOM dropped, LF line ends, no trailing white space. */
export function canonical(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/**
 * True when an edit that started from `base` would overwrite a change made meanwhile: the text is no
 * longer `base` and the edit does not already say what it says now (optimistic concurrency).
 */
export function staleBase(current: string, base: string, next: string): boolean {
  const now = canonical(current);
  return canonical(base) !== now && canonical(next) !== now;
}

export const signature = (info: Pick<Stats, 'mtimeMs' | 'size'>): string => `${Math.round(info.mtimeMs * 1000)}:${info.size}`;

/** Stats the file itself – a link is not followed (undefined = missing; other errors throw). */
export function statFile(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Reads and validates a text file (the size is checked before anything is read). */
export function readText(file: string, limits: TextLimits, info?: Stats): TextRead {
  let stats: Stats | undefined;
  try {
    stats = info ?? statFile(file);
  } catch {
    return { kind: 'problem', problem: 'unreadable', sig: 'error' };
  }
  if (!stats) return { kind: 'missing' };
  const sig = signature(stats);
  if (!stats.isFile()) return { kind: 'problem', problem: 'unreadable', sig };
  if (stats.size > limits.maxBytes) return { kind: 'problem', problem: 'too-large', sig };
  let bytes: Buffer;
  try {
    bytes = readBounded(file, limits.maxBytes + 1);
  } catch {
    return { kind: 'problem', problem: 'unreadable', sig };
  }
  return textOf(bytes, limits, sig);
}

/** readText with the event loop free (a walk over many files). */
export async function readTextAsync(file: string, limits: TextLimits): Promise<TextRead> {
  let stats: Stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'problem', problem: 'unreadable', sig: 'error' };
  }
  const sig = signature(stats);
  if (!stats.isFile()) return { kind: 'problem', problem: 'unreadable', sig };
  if (stats.size > limits.maxBytes) return { kind: 'problem', problem: 'too-large', sig };
  try {
    return textOf(await readFile(file), limits, sig);
  } catch {
    return { kind: 'problem', problem: 'unreadable', sig };
  }
}

function textOf(bytes: Buffer, limits: TextLimits, sig: string): TextRead {
  if (bytes.byteLength > limits.maxBytes) return { kind: 'problem', problem: 'too-large', sig };
  if (bytes.includes(0)) return { kind: 'problem', problem: 'not-text', sig };
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'problem', problem: 'not-text', sig };
  }
  const text = canonical(decoded);
  if (limits.maxChars !== undefined && text.length > limits.maxChars) return { kind: 'problem', problem: 'too-large', sig };
  return { kind: 'ok', text, sig };
}

/** At most `max` bytes of `file` (a file growing while read is cut, never read without end). */
function readBounded(file: string, max: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(max);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, max - total, null);
      if (read <= 0) break;
      total += read;
      if (total >= max) break;
    }
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/** Writes `text` atomically (see the header); the folder is created; `writes` hears about it. */
export function writeAtomic(file: string, text: string, writes?: OwnWrites): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    renameRetrying(temp, file);
  } catch (error) {
    try {
      if (!isBusy(error)) throw error;
      if (isLink(file)) throw error; // never write through a link to a file elsewhere
      writeFileSync(file, text, 'utf8');
    } finally {
      rmSync(temp, { force: true });
    }
  }
  writes?.wrote(file, text);
}

function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const wait = RENAME_RETRY_MS[attempt];
      if (process.platform !== 'win32' || !isBusy(error) || wait === undefined) throw error;
      pause(wait);
    }
  }
}

/** A short synchronous wait (the writes are synchronous: an edit's hook must know the outcome). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** <name>.rejected.<ext> next to `file` (SYSTEM.md → SYSTEM.rejected.md, settings.json → settings.rejected.json). */
export function rejectedPath(file: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}.rejected${ext}`);
}

/** True for a rejected copy's file name (the watcher never reports them). */
export function isRejectedName(name: string): boolean {
  return REJECTED.test(name);
}

export interface TextDocOptions<P extends string> {
  file: string;
  limits: TextLimits;
  clock: Clock;
  /** The data folder watcher (its marks keep the app's own writes from counting as outside edits). */
  writes?: OwnWrites;
  /** Quiet notice hook (see QuietNotice). */
  onNotice?: NoticeHook<P>;
}

/** Outcome of TextDoc.writeFrom. */
export type WriteOutcome = 'written' | 'same' | 'conflict';

/** One text file: its read cache, the app's own writes, the rejected copy and the quiet notice. */
export class TextDoc<P extends string = TextProblem> {
  readonly file: string;
  readonly notices: QuietNotice<P>;
  private readonly options: TextDocOptions<P>;
  private last?: TextRead;
  private statSig?: string;
  private own?: string;

  constructor(options: TextDocOptions<P>) {
    this.options = options;
    this.file = options.file;
    this.notices = new QuietNotice(options.clock, options.onNotice);
  }

  /** The file now: one stat, read again only when its signature changed (a stat error other than 'missing' throws). */
  check(): TextRead {
    const stats = statFile(this.file);
    if (!stats) {
      this.last = { kind: 'missing' };
      this.statSig = undefined;
      return this.last;
    }
    const sig = signature(stats);
    if (this.last && this.statSig === sig) return this.last;
    this.last = readText(this.file, this.options.limits, stats);
    this.statSig = sig;
    return this.last;
  }

  /** check() that never throws (an error reads as 'unreadable'). */
  safeCheck(): TextRead {
    try { return this.check(); } catch { return { kind: 'problem', problem: 'unreadable', sig: 'error' }; }
  }

  /** True when `read` is not the app's own last write (or the take-over adopt() accepted). */
  isOutside(read: TextRead): boolean {
    return read.kind === 'missing' || read.sig !== this.own;
  }

  /** Accepts the file with `sig` as known to the app (an outside edit the owner took over). */
  adopt(sig: string): void {
    this.own = sig;
  }

  /** Writes `text` atomically and remembers it as the app's own (a failure throws; nothing is remembered). */
  write(text: string): void {
    writeAtomic(this.file, text, this.options.writes);
    this.last = undefined;
    try { this.own = signature(statSync(this.file)); } catch { this.own = undefined; }
  }

  /**
   * Writes `next` unless the file was changed meanwhile – it holds neither `base` (what the writer started
   * from) nor already `next` ('conflict': the file is left alone). 'same': it already says `next`. A missing
   * file is written; a problem file (too large, not text, unreadable) is kept as the rejected copy first.
   */
  writeFrom(base: string, next: string): WriteOutcome {
    const read = this.safeCheck();
    if (read.kind === 'ok') {
      if (read.text === canonical(next)) return 'same';
      if (staleBase(read.text, base, next)) return 'conflict';
    }
    if (read.kind === 'problem') this.keepRejected();
    this.write(next);
    return 'written';
  }

  /** Keeps the file as it is now once as <name>.rejected.<ext> (an older copy goes); 'copy' leaves it in place. */
  keepRejected(how: 'move' | 'copy' = 'move'): boolean {
    const target = rejectedPath(this.file);
    try {
      if (how === 'move') renameSync(this.file, target);
      else if (lstatSync(this.file).isFile()) copyFileSync(this.file, target); // a link is never followed
      else return false;
      this.last = undefined;
      return true;
    } catch {
      return false; // nothing to keep
    }
  }

  /** Writes `text` (what the app refused) as the rejected copy. */
  writeRejected(text: string): void {
    writeAtomic(rejectedPath(this.file), text, this.options.writes);
  }

  /** The quiet notice now (undefined: none). */
  get notice(): TextNotice<P> | undefined {
    return this.notices.current;
  }

  setNotice(problem: P | undefined, detail?: string): boolean {
    return this.notices.set(problem, detail);
  }

  /** Drops the read cache and the own-write signature (the notice stays). */
  forget(): void {
    this.last = undefined;
    this.statSig = undefined;
    this.own = undefined;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function isLink(file: string): boolean {
  try { return lstatSync(file).isSymbolicLink(); } catch { return false; }
}
