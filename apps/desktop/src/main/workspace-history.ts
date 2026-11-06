// The person's browsing history (like Chrome's): every page a personal tab showed, newest
// first, at most MAX_HISTORY addresses in <data>/browser-history.json. An address with a credential
// or a token in it is never kept – one that keptAddress (shared/api/workspace-browser.ts, the rule
// of the saved tabs) would change: user info, a token-like query or fragment, a reset / magic /
// verify / invite / OAuth link, a JWT or a long opaque path segment; only http(s). One entry per
// address (its newest title, last visit, visit count). Writes are bundled – one trailing timer
// after a change (a page that navigates often writes once) – and happen at once on Clear history
// and when the browser goes (flush).
// Owns: the entries, their search and the file. Never: imports electron, reads pages, or keeps
// anything of an address it skipped.

import { keptAddress, type HistoryEntry } from '../shared/api/workspace-browser.ts';
import { NODE_FILES, type TabFiles } from './workspace-tabs.ts';

export const MAX_HISTORY = 5000;
const SAVE_DELAY_MS = 2000;
const TITLE_MAX = 300;
const SEARCH_MAX = 200;

/** The address as history keeps it, or undefined when it may not be kept (see the header). */
export function historyAddress(raw: string): string | undefined {
  let href: string;
  try { href = new URL(raw).href; } catch { return undefined; }
  return keptAddress(href) === href ? href : undefined;
}

/** A saved file's entries, oldest first, checked one by one (anything unreadable or not keepable is left out). */
export function readHistory(text: string | undefined): HistoryEntry[] {
  if (!text) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  const list = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  const out = new Map<string, HistoryEntry>();
  for (const item of list) {
    const { url, title, at, visits } = (item ?? {}) as Record<string, unknown>;
    const address = typeof url === 'string' ? historyAddress(url) : undefined;
    if (!address || typeof at !== 'number' || !Number.isFinite(at)) continue;
    out.delete(address);
    out.set(address, { url: address, title: typeof title === 'string' ? title.slice(0, TITLE_MAX) : '', at, visits: typeof visits === 'number' && visits >= 1 ? Math.floor(visits) : 1 });
  }
  return [...out.values()].sort((a, b) => a.at - b.at).slice(-MAX_HISTORY);
}

export interface HistoryTimers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
const NODE_TIMERS: HistoryTimers = {
  set: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class BrowserHistory {
  /** Oldest first (Map order): a visit moves its address to the end. */
  private readonly entries = new Map<string, HistoryEntry>();
  private readonly file: string | undefined;
  private readonly files: TabFiles;
  private readonly timers: HistoryTimers;
  private readonly now: () => number;
  private pending: unknown = null;

  constructor(options: { file?: string; files?: TabFiles; timers?: HistoryTimers; now?: () => number } = {}) {
    this.file = options.file;
    this.files = options.files ?? NODE_FILES;
    this.timers = options.timers ?? NODE_TIMERS;
    this.now = options.now ?? Date.now;
    for (const entry of this.file ? readHistory(this.files.read(this.file)) : []) this.entries.set(entry.url, entry);
  }

  get size(): number { return this.entries.size; }

  /** A tab showed `url` (a load, a reload or a move inside the page). */
  visit(url: string, title = ''): void {
    const address = historyAddress(url);
    if (!address) return;
    const known = this.entries.get(address);
    this.entries.delete(address);
    this.entries.set(address, { url: address, title: (title || known?.title || '').slice(0, TITLE_MAX), at: this.now(), visits: (known?.visits ?? 0) + 1 });
    while (this.entries.size > MAX_HISTORY) this.entries.delete(this.entries.keys().next().value!);
    this.later();
  }

  /** The page's title arrived (after its visit). */
  title(url: string, title: string): void {
    const address = historyAddress(url);
    const entry = address ? this.entries.get(address) : undefined;
    const text = title.slice(0, TITLE_MAX);
    if (!entry || !text || entry.title === text) return;
    entry.title = text;
    this.later();
  }

  /** Newest first; every word of `query` must be in the title or the address. */
  search(query = '', limit = 50): HistoryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const max = Math.max(1, Math.min(SEARCH_MAX, Math.floor(limit) || 50));
    const out: HistoryEntry[] = [];
    const all = [...this.entries.values()];
    for (let index = all.length - 1; index >= 0 && out.length < max; index--) {
      const entry = all[index]!;
      const text = `${entry.title}\n${entry.url}`.toLowerCase();
      if (words.every((word) => text.includes(word))) out.push({ ...entry });
    }
    return out;
  }

  /** Clear history: every entry goes, the file is written at once. */
  clear(): void {
    this.entries.clear();
    this.write();
  }

  /** Writes a pending change now (the browser goes). */
  flush(): void {
    if (this.pending !== null) this.write();
  }

  private later(): void {
    if (this.pending !== null || !this.file) return;
    this.pending = this.timers.set(() => { this.pending = null; this.write(); }, SAVE_DELAY_MS);
  }

  private write(): void {
    if (this.pending !== null) { this.timers.clear(this.pending); this.pending = null; }
    if (!this.file) return;
    try { this.files.write(this.file, `${JSON.stringify({ version: 1, entries: [...this.entries.values()] })}\n`); }
    catch { /* the profile is read-only or gone: history holds until the app closes */ }
  }
}
