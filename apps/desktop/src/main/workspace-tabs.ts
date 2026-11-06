// <data>/side-tabs.json: the tabs in spaces – 'global' (the person's pane), 'chat:<id>' (that chat's area above its
// messages, shared by everyone in it) and 'agent:<id>' (that agent's area on its agent page, which the agent keeps) –
// each with its shown tab and its tabs in order: a website {id, url, by?} (by: the agent that
// opened it) or one of the app's panels {id, panel, …}. Main owns the file and takes over what an AI or an editor writes
// there (reload). It replaces workspace-tabs.json (one flat list, moved over once). A website tab that is not loaded is
// only an entry until it is shown or used: its page loads then (no eight renderers at start). The address is kept
// without user name/password, and without query and fragment when they look like a token, code, key, session or
// password; a path with a credential step or a token in it is kept as its site only; only http(s) (keptAddress in
// shared/api/workspace-browser.ts). No title, page content, cookies or form data here (those stay in the browser
// session). Up to 30 websites per space (the memory saver discards hidden ones – workspace-discard.ts); a discarded tab
// is an entry again with its whole address in memory (discard) – the file still keeps only the kept address.
// Owns: the spaces, the not-yet-loaded entries and the saved file. Never: imports electron, reads pages, or writes when
// nothing changed.

import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GLOBAL_SPACE, isSpace, keptAddress as savedUrl, type SideEntry, type SideSpaces } from '../shared/api/workspace-browser.ts';

export const MAX_TABS = 30;
const ID = /^web-[a-zA-Z0-9-]{1,80}$/;
const PANEL_MAX = 2000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWeb = (entry: SideEntry) => entry.panel === undefined;

/** One entry as the file may hold it (anything else is left out). */
function readEntry(item: unknown): SideEntry | undefined {
  if (!isObject(item) || typeof item.id !== 'string') return undefined;
  if (typeof item.panel === 'string') return item.panel !== 'new' && item.id.length <= 600 && JSON.stringify(item).length <= PANEL_MAX ? item as SideEntry : undefined;
  const url = typeof item.url === 'string' ? savedUrl(item.url) : undefined;
  if (!ID.test(item.id) || !url) return undefined;
  return { id: item.id, url, ...(typeof item.by === 'string' && item.by.length <= 120 ? { by: item.by } : {}) };
}

/** A saved file as spaces, checked one by one (anything unreadable is left out); undefined when it is no tab file at all. */
export function readSpaces(text: string | undefined): SideSpaces | undefined {
  if (!text) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isObject(value)) return undefined;
  const raw = isObject(value.spaces) ? value.spaces : Array.isArray(value.tabs) ? { [GLOBAL_SPACE]: { tabs: value.tabs } } : undefined;
  if (!raw) return undefined;
  const seen = new Set<string>();
  const out: SideSpaces = {};
  for (const [key, space] of Object.entries(raw)) {
    if (!isSpace(key) || !isObject(space) || !Array.isArray(space.tabs)) continue;
    const tabs: SideEntry[] = [];
    for (const item of space.tabs) {
      const entry = readEntry(item);
      if (!entry || tabs.some((tab) => tab.id === entry.id) || (isWeb(entry) && seen.has(entry.id))) continue;
      if (isWeb(entry)) { if (tabs.filter(isWeb).length >= MAX_TABS) break; seen.add(entry.id); }
      tabs.push(entry);
    }
    if (tabs.length) out[key] = { ...(typeof space.shown === 'string' ? { shown: space.shown } : {}), tabs };
  }
  return out;
}

export interface TabFiles { read(file: string): string | undefined; write(file: string, text: string): void; remove?(file: string): void }

/** Disk access: read, and an atomic write (temp file + rename). */
export const NODE_FILES: TabFiles = {
  read: (file) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } },
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, file);
  },
  remove: (file) => { try { rmSync(file, { force: true }); } catch { /* stays beside the new one, unused */ } },
};

/** Calls `run` shortly after `file` changed (its folder is watched: an atomic save replaces the file itself). */
export function watchTabsFile(file: string, run: () => void): () => void {
  const name = path.basename(file);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(path.dirname(file), (_event, changed) => {
      if (changed && changed !== name) return;
      clearTimeout(timer);
      timer = setTimeout(run, 150);
    });
    watcher.on('error', () => { /* the folder went: tabs still save, outside edits wait for the next start */ });
    return () => { clearTimeout(timer); watcher.close(); };
  } catch { return () => {}; }
}

/** What a changed file asks of the live tabs. */
export interface TabsReload { closed: string[]; navigate: Array<{ id: string; url: string }> }

/**
 * The spaces and their not-yet-loaded entries. The browser reports its live tabs (id → current address) with save();
 * shown() turns an entry into a live tab.
 */
export class PersonalTabs {
  private spaces: SideSpaces = {};
  private readonly restored = new Map<string, string>();
  /** The last address saved per tab: kept while a tab shows no web address yet (a page still starting to load). */
  private readonly known = new Map<string, string>();
  private lastSaved = '';
  /** The file's text as last read or written here: anything else on disk is an outside edit. */
  private seen: string | undefined;
  private readonly file: string | undefined;
  private readonly files: TabFiles;

  constructor(options: { file?: string; oldFile?: string; files?: TabFiles } = {}) {
    this.file = options.file;
    this.files = options.files ?? NODE_FILES;
    let text = this.file ? this.files.read(this.file) : undefined;
    this.seen = text;
    const moving = !text && options.oldFile ? this.files.read(options.oldFile) : undefined;
    if (moving) text = moving;
    this.spaces = readSpaces(text) ?? {};
    for (const tab of this.webs()) { this.restored.set(tab.id, tab.url!); this.known.set(tab.id, tab.url!); }
    this.lastSaved = this.serialize(this.spaces);
    if (moving && this.file) {
      try { this.files.write(this.file, this.lastSaved); this.seen = this.lastSaved; this.files.remove?.(options.oldFile!); } catch { /* read-only: the old file is read again next time */ }
    }
  }

  private webs(): SideEntry[] {
    return Object.values(this.spaces).flatMap((space) => space.tabs.filter(isWeb));
  }

  /** The address of a tab that was saved but is not loaded yet. */
  restoredUrl(id: string): string | undefined {
    return this.restored.get(id);
  }

  /** Every website tab's id in order (live and not yet loaded), all spaces. */
  ids(): string[] {
    return this.webs().map((tab) => tab.id);
  }

  /** The space a website tab lives in. */
  spaceOf(id: string): string {
    for (const [key, space] of Object.entries(this.spaces)) if (space.tabs.some((tab) => tab.id === id && isWeb(tab))) return key;
    return GLOBAL_SPACE;
  }

  /** The agent that opened a website tab. */
  byOf(id: string): string | undefined {
    return this.webs().find((tab) => tab.id === id)?.by;
  }

  /** The tab a space shows. */
  shownOf(space: string): string | undefined {
    return this.spaces[space]?.shown;
  }

  /** A tab became live (opened or shown): it keeps its place, or goes to the end of `space` when new. */
  shown(id: string, space: string = GLOBAL_SPACE, by?: string): void {
    this.restored.delete(id);
    if (this.webs().some((tab) => tab.id === id)) return;
    const target = (this.spaces[space] ??= { tabs: [] });
    target.tabs.push({ id, ...(by ? { by } : {}) });
  }

  /** B-055: a live tab gave its page up (memory saver): an entry again at `url`, loaded when shown. */
  discard(id: string, url: string): void {
    if (url && this.webs().some((tab) => tab.id === id)) this.restored.set(id, url);
  }

  /** A tab was closed (live or not). */
  closed(id: string): void {
    this.restored.delete(id);
    this.known.delete(id);
    for (const [key, space] of Object.entries(this.spaces)) {
      space.tabs = space.tabs.filter((tab) => tab.id !== id || !isWeb(tab));
      if (!space.tabs.length) delete this.spaces[key];
    }
  }

  /** How many website tabs a space has (live and not yet loaded). */
  sizeOf(space: string): number {
    return this.spaces[space]?.tabs.filter(isWeb).length ?? 0;
  }

  /** The window's view of the spaces (no live addresses needed: it knows those from the page list). */
  layout(): SideSpaces {
    return this.built(new Map());
  }

  /**
   * The window's panels, order and shown tabs. A website stays what it is here (the window never opens or closes one
   * this way) and goes where the window lists it; one the window does not know of yet stays at its space's end.
   */
  setLayout(next: SideSpaces): void {
    const webs = new Map(Object.entries(this.spaces).flatMap(([key, space]) => space.tabs.filter(isWeb).map((tab) => [tab.id, { key, tab }] as const)));
    const placed = new Set<string>();
    const out: SideSpaces = {};
    for (const [key, space] of Object.entries(next)) {
      if (!isSpace(key) || !Array.isArray(space?.tabs)) continue;
      const tabs: SideEntry[] = [];
      for (const item of space.tabs) {
        const web = webs.get(item?.id);
        if (web && item.panel === undefined) { if (!placed.has(item.id)) { placed.add(item.id); tabs.push(web.tab); } continue; }
        const panel = typeof item?.panel === 'string' ? readEntry(item) : undefined;
        if (panel && !tabs.some((tab) => tab.id === panel.id)) tabs.push(panel);
      }
      out[key] = { ...(typeof space.shown === 'string' ? { shown: space.shown } : {}), tabs };
    }
    for (const [id, { key, tab }] of webs) if (!placed.has(id)) (out[key] ??= { tabs: [] }).tabs.push(tab);
    for (const [key, space] of Object.entries(out)) if (!space.tabs.length) delete out[key];
    this.spaces = out;
  }

  /** The browser's live tabs (id → address) changed: saves the spaces when they differ from the file. */
  save(live: ReadonlyMap<string, string>): void {
    const built = this.built(live);
    for (const tab of Object.values(built).flatMap((space) => space.tabs.filter(isWeb))) this.known.set(tab.id, tab.url!);
    const text = this.serialize(built);
    if (!this.file || text === this.lastSaved) return;
    const disk = this.files.read(this.file);
    if (disk && disk !== this.seen && readSpaces(disk)) return; // an outside edit not taken over yet (reload, within moments): it counts, this save never writes over it
    try {
      this.files.write(this.file, text);
      this.lastSaved = text;
      this.seen = text;
    } catch { /* the profile is read-only or gone: the tabs simply are not restored */ }
  }

  /** The window went: live tabs in `live` become entries again (from their last addresses), so a new window shows them. */
  park(live: ReadonlyMap<string, string>, keep: ReadonlySet<string> = new Set()): void {
    for (const id of this.ids()) {
      if (keep.has(id)) continue;
      const url = savedUrl(live.get(id) ?? '') ?? this.restored.get(id) ?? this.known.get(id);
      if (url) this.restored.set(id, url);
      else this.closed(id);
    }
  }

  /** The file changed on disk: its content is taken over; what that means for live tabs comes back. Undefined: nothing new, or unreadable. */
  reload(): TabsReload | undefined {
    if (!this.file) return undefined;
    const text = this.files.read(this.file);
    if (!text) return undefined;
    if (text === this.lastSaved) { this.seen = text; return undefined; } // what this holds already, so no edit waiting: a save goes on
    const next = readSpaces(text);
    if (!next) return undefined;
    const before = new Set(this.ids());
    const navigate: TabsReload['navigate'] = [];
    this.spaces = next;
    for (const tab of this.webs()) {
      const url = tab.url!;
      if (!before.has(tab.id) || this.restored.has(tab.id)) this.restored.set(tab.id, url);
      else if (this.known.get(tab.id) !== url) navigate.push({ id: tab.id, url });
      this.known.set(tab.id, url);
      before.delete(tab.id);
    }
    const closed = [...before];
    for (const id of closed) { this.restored.delete(id); this.known.delete(id); }
    this.lastSaved = text;
    this.seen = text;
    return { closed, navigate };
  }

  private built(live: ReadonlyMap<string, string>): SideSpaces {
    const out: SideSpaces = {};
    for (const [key, space] of Object.entries(this.spaces)) {
      const tabs: SideEntry[] = [];
      for (const tab of space.tabs) {
        if (!isWeb(tab)) { tabs.push(tab); continue; }
        const url = savedUrl(live.get(tab.id) ?? '') ?? savedUrl(this.restored.get(tab.id) ?? '') ?? this.known.get(tab.id);
        if (url) tabs.push({ id: tab.id, url, ...(tab.by ? { by: tab.by } : {}) });
      }
      if (tabs.length) out[key] = { ...(space.shown ? { shown: space.shown } : {}), tabs };
    }
    return out;
  }

  private serialize(spaces: SideSpaces): string {
    return `${JSON.stringify({ version: 2, spaces }, null, 1)}\n`;
  }
}
