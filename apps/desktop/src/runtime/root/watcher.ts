// The one watcher on the open data folder (B-044 Phase 1, contract §5; the logic moved here from
// agent-core/watch.ts): change detection by operating-system events, never by polling. Where the system watches a
// whole tree with one native handle (Windows, macOS) that is ONE recursive fs.watch on <data>. Elsewhere (Linux)
// Node would walk the tree and watch every file in it – Chromium's caches, blobs, CLI homes, browser profiles – so
// there it is one watch on <data> itself (its entries) plus one recursive watch per owned folder, armed when the
// folder appears. An event goes by its first path segment to the owner registered for that entry (register →
// unregister; agents → AgentCore, settings.json → the settings store …). Events of app-managed entries (layout.ts
// EXCLUDED – they can have no owner), of entries without an owner (Chromium's caches, the database journal), of
// temporary files of atomic writes (*.tmp) and of rejected copies (<name>.rejected.<ext>) are dropped at once.
// Events gather per path for DEBOUNCE_MS (one unref'd timer per path, re-armed by each event, at the latest
// MAX_WAIT_MS after the first); then the owner hears the path once. A path the app wrote itself (TextDoc →
// wrote(); marks.ts: size + content hash) that still holds exactly that content is no outside edit and is not
// handed over. An event without a file name (the system lost track – its buffer overflowed) tells every owner
// "unknown – check everything". A tap (devices/sync) hears every handed-over path, the app's own writes too.
// nudge() queues an owner's own finding (a turn-time stat) into the same debounce, so an editor's save in
// progress is never taken over half-way. After an error the watcher closes and says so; ensure() – called by
// the owners on their next use and by every own write, never by a timer – arms it again at most every
// REARM_MS (creating <data> again when it was removed), and every owner then hears "unknown" once.
// Owns: the watch handles, the owners and the debounce. Never: reads an owner's files beyond the hash of a
// marked path, decides what a change means (the owners do), or polls.

import { lstatSync, mkdirSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Clock, Logger } from '../contracts.ts';
import { entryKey, isExcluded, splitRel } from './layout.ts';
import { OwnMarks } from './marks.ts';
import { isRejectedName, type OwnWrites } from './text-doc.ts';

export const DEBOUNCE_MS = 300;
export const MAX_WAIT_MS = 5000;
/** A watcher stopped by an error is armed again on the next use, at most this often. */
export const REARM_MS = 60_000;
/** Systems whose fs.watch watches a whole tree with one native handle. */
const NATIVE_RECURSIVE: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

export type WatchFn = (target: string, options: { recursive: boolean; persistent: boolean }, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher;

/** What an owner hears about its entry. */
export interface RootEvent {
  /** The path below the entry ([] = the entry itself: created, removed, renamed, a file entry changed); absent = unknown, check everything. */
  parts?: readonly string[];
}

export type RootOwner = (event: RootEvent) => void;

export interface RootWatcherOptions {
  /** The data folder. */
  root: string;
  clock: Clock;
  log?: Logger;
  /** Tests inject a fake; false = no operating-system watch (nudges still go through the debounce). */
  watch?: WatchFn | false;
  debounceMs?: number;
  maxWaitMs?: number;
  rearmMs?: number;
  /** For the case rule of entry names (tests); default process.platform. */
  platform?: NodeJS.Platform;
  /** true: ONE recursive watch on <data>; false: <data> itself plus one recursive watch per owned folder. Default: true where the system watches a tree natively (Windows, macOS). */
  recursive?: boolean;
}

interface Pending { key: string; segment: string; parts?: string[]; forced: boolean; timer?: NodeJS.Timeout; deadline?: NodeJS.Timeout }
interface Owner { name: string; run: RootOwner }

export class RootWatcher implements OwnWrites {
  readonly root: string;
  private readonly options: RootWatcherOptions;
  private readonly platform: NodeJS.Platform;
  private readonly recursive: boolean;
  private watcher?: FSWatcher;
  /** Without one recursive watch on <data>: one recursive watch per owned folder (by entry key). */
  private readonly folders = new Map<string, FSWatcher>();
  private started = false;
  private retryAt = 0;
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Map<string, Pending>();
  private readonly marks = new OwnMarks();
  private readonly taps = new Set<(name: string, parts?: readonly string[]) => void>();

  constructor(options: RootWatcherOptions) {
    this.options = options;
    this.root = path.resolve(options.root);
    this.platform = options.platform ?? process.platform;
    this.recursive = options.recursive ?? NATIVE_RECURSIVE.has(this.platform);
  }

  /** Makes `run` the owner of the entry `name` of <data> (one owner per entry); returns the unregister function. */
  register(name: string, run: RootOwner): () => void {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error(`Not an entry of the data folder: ${name}`);
    if (isExcluded(name, this.platform)) throw new Error(`An app-managed entry is never watched: ${name}`);
    const key = entryKey(name, this.platform);
    if (this.owners.has(key)) throw new Error(`The data folder entry ${name} already has an owner.`);
    const owner: Owner = { name, run };
    this.owners.set(key, owner);
    this.armFolder(key);
    return () => {
      if (this.owners.get(key) !== owner) return;
      this.owners.delete(key);
      this.closeFolder(key);
      for (const entry of [...this.pending.values()]) if (entry.segment === key) this.drop(entry);
    };
  }

  /** Hears every path an owner hears – also the app's own writes – after the debounce (devices/sync/files.ts); returns the off switch. */
  tap(listener: (name: string, parts?: readonly string[]) => void): () => void {
    this.taps.add(listener);
    return () => { this.taps.delete(listener); };
  }

  /** Starts watching; false when the system refuses (the owners' start-up checks still apply; ensure() tries again). */
  start(): boolean {
    this.started = true;
    if (this.watcher) return true;
    if (this.options.watch === false) return false;
    if (this.arm()) return true;
    this.retryAt = this.now() + (this.options.rearmMs ?? REARM_MS);
    return false;
  }

  /** True while the operating system reports changes. */
  get active(): boolean {
    return this.watcher !== undefined;
  }

  /** Arms a watcher an error stopped again (on the owners' next use, at most every REARM_MS); every owner then checks once. */
  ensure(): void {
    if (!this.started || this.watcher || this.options.watch === false || this.now() < this.retryAt) return;
    this.retryAt = this.now() + (this.options.rearmMs ?? REARM_MS);
    try { mkdirSync(this.root, { recursive: true, mode: 0o700 }); } catch { return; }
    if (!this.arm()) return;
    this.options.log?.info('data folder watcher armed again');
    this.unknown(); // debounced, never inside the caller's work
  }

  /** Queues an owner's finding into the debounce (parts below its entry; absent = check everything). Never dropped as an own write. */
  nudge(name: string, parts?: readonly string[]): void {
    const key = entryKey(name, this.platform);
    if (this.owners.has(key)) this.queue(key, parts ? [...parts] : undefined, true);
  }

  /** OwnWrites: the app wrote `content` to `file` (null: removed it). Events that find exactly that are not handed over. */
  wrote(file: string, content: string | null): void {
    const rel = this.relKey(file);
    if (rel === undefined) return;
    this.marks.set(rel, content);
    this.ensure();
  }

  /** Hands over everything queued now (of one entry, or all) – tests, shutdown. */
  flush(name?: string): void {
    const key = name === undefined ? undefined : entryKey(name, this.platform);
    for (const entry of [...this.pending.values()]) if (key === undefined || entry.segment === key) this.fire(entry.key);
  }

  /** Closes the watcher and drops what is queued (the owners stay registered; nothing is armed again until start()). */
  stop(): void {
    this.started = false;
    for (const entry of this.pending.values()) clear(entry);
    this.pending.clear();
    this.marks.clear();
    this.close();
  }

  // ---------------------------------------------------------------- internals

  private arm(): boolean {
    try {
      this.watcher = this.open(this.root, this.recursive, (handle) => this.watcher === handle, (name) => this.event(name));
    } catch (error) {
      this.options.log?.warn('data folder not watched', { error: String(error) });
      return false;
    }
    for (const key of this.owners.keys()) this.armFolder(key);
    return true;
  }

  /** Without one recursive watch on <data>: watches an owned folder (none for a file entry or a folder not there yet – the watch on <data> names it when it comes). */
  private armFolder(key: string): void {
    const owner = this.owners.get(key);
    if (this.recursive || !this.watcher || !owner || this.folders.has(key)) return;
    const dir = path.join(this.root, owner.name);
    try { if (!lstatSync(dir).isDirectory()) return; } catch { return; }
    try {
      this.folders.set(key, this.open(dir, true, (handle) => this.folders.get(key) === handle, (name) => this.event(name === null ? null : `${owner.name}/${name}`)));
    } catch (error) {
      this.options.log?.warn('data folder entry not watched', { entry: owner.name, error: String(error) });
    }
  }

  /** One watch handle: it reports, and its error closes the watcher, only while `live` says it is the current one. */
  private open(target: string, recursive: boolean, live: (handle: FSWatcher) => boolean, report: (name: string | null) => void): FSWatcher {
    const watch = this.options.watch || (fsWatch as unknown as WatchFn);
    // Events while the handle is being created (Node's own walk naming what is there already) are no changes.
    let handle: FSWatcher | undefined;
    handle = watch(target, { recursive, persistent: false }, (_event, name) => {
      if (handle && live(handle)) report(name === null || name === undefined ? null : String(name));
    });
    const opened = handle;
    opened.on('error', (error) => {
      if (!live(opened)) return;
      this.options.log?.warn('data folder watcher stopped', { error: String(error) });
      this.close();
      this.retryAt = this.now() + (this.options.rearmMs ?? REARM_MS);
    });
    return opened;
  }

  private close(): void {
    for (const key of [...this.folders.keys()]) this.closeFolder(key);
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = undefined;
  }

  private closeFolder(key: string): void {
    const handle = this.folders.get(key);
    if (!handle) return;
    this.folders.delete(key);
    try { handle.close(); } catch { /* already closed */ }
  }

  private event(name: string | null): void {
    if (name === null) { this.unknown(); return; }
    const [first = '', ...parts] = splitRel(name);
    const key = entryKey(first, this.platform);
    if (!this.owners.has(key)) return; // no owner: app-managed, Chromium's, or nobody's yet
    if (!parts.length && !this.recursive) { this.closeFolder(key); this.armFolder(key); } // the entry came, went or was replaced
    const last = parts[parts.length - 1] ?? first;
    if (last.endsWith('.tmp') || isRejectedName(last)) return; // an atomic write in progress, a kept copy
    this.queue(key, parts, false);
  }

  /** Every owner: check everything (no file name, or armed again). */
  private unknown(): void {
    for (const key of this.owners.keys()) this.queue(key, undefined, false);
  }

  private queue(segment: string, parts: string[] | undefined, forced: boolean): void {
    const key = parts === undefined ? `${segment}\u0000` : entryKey([segment, ...parts].join('/'), this.platform);
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { key, segment, parts, forced };
      this.pending.set(key, entry);
      entry.deadline = unref(setTimeout(() => this.fire(key), this.options.maxWaitMs ?? MAX_WAIT_MS));
    }
    entry.forced ||= forced;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = unref(setTimeout(() => this.fire(key), this.options.debounceMs ?? DEBOUNCE_MS));
  }

  private fire(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.drop(entry);
    const owner = this.owners.get(entry.segment);
    if (!owner) return;
    for (const tap of this.taps) { try { tap(owner.name, entry.parts); } catch { /* a tap never stops an owner */ } }
    if (entry.parts && !entry.forced && this.marks.holds(entry.key, path.join(this.root, owner.name, ...entry.parts))) return;
    try {
      owner.run(entry.parts ? { parts: entry.parts } : {});
    } catch (error) {
      this.options.log?.warn('data folder change not applied', { entry: owner.name, error: String(error) });
    }
  }

  private drop(entry: Pending): void {
    this.pending.delete(entry.key);
    clear(entry);
  }

  private relKey(file: string): string | undefined {
    const rel = path.relative(this.root, path.resolve(file));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
    return entryKey(splitRel(rel).join('/'), this.platform);
  }

  private now(): number {
    return this.options.clock.now();
  }
}

function clear(entry: Pending): void {
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.deadline) clearTimeout(entry.deadline);
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
