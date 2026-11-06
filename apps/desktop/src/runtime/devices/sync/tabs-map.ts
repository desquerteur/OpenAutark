// How the side pane travels (B-076, owner 05.11.2026: on the other PC "ziemlich das exakt dasselbe") – pure rules over
// the spaces of <data>/side-tabs.json. On its way to a linked CEO PC a space takes its shared form: this PC's websites
// become 'remote' panels {id: remote:<this PC>:<web id>, panel, device, tab, url, by?}, its file, folder and
// media-by-path panels name this PC in `device` (id 'file@<PC>:<path>'); on arrival it takes the local form again –
// what names this PC is its own (its websites by their id, its paths without device), what names another PC stays a
// panel of that PC. A phone sees its PC's spaces with the websites as 'remote' panels of that PC and the PC's own paths
// as they are (phoneSpaces). This PC is the only authority over its own websites: a copy from elsewhere orders them and
// closes one only by naming it in `closed`; it never opens one or changes its address – this PC's phone may open one
// (mergeSpace's `create`). A panel whose shared form main would refuse (a path so long that the PC's name in its id
// passes main's limit) stays on this PC only, kept by a copy from elsewhere like its websites.
// Owns: these mappings and the merge. Never: reads or writes the file, or sends anything.

import { isSpace, keptAddress, pathTabId, remoteTabId, type SideEntry, type SideSpace, type SideSpaces } from '../../../shared/api/workspace-browser.ts';

const WEB_ID = /^web-[a-zA-Z0-9-]{1,80}$/;
/** A stored file's id (sha256): a media tab by id shows the same on every PC. */
const STORED_ID = /^[a-f0-9]{64}$/;
const PATH_KINDS = ['file', 'folder', 'media'] as const;
/** main/workspace-tabs.ts readEntry's limits for a panel. */
const ID_MAX = 600;
const ENTRY_MAX = 2000;
const URL_MAX = 1500;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const isWeb = (entry: SideEntry): boolean => entry.panel === undefined;

/** The path a file, folder or media-by-path panel shows on its PC; undefined for every other entry. */
export function pathOf(entry: SideEntry): string | undefined {
  if (entry.panel !== 'file' && entry.panel !== 'folder' && entry.panel !== 'media') return undefined;
  if (entry.panel === 'media' && entry.fileId !== undefined) return undefined;
  return typeof entry.path === 'string' ? entry.path : undefined;
}

/** A remote panel's address: the page lives on its PC, so a very long one is shortened to its site (the panel stays within main's limit). */
function shortAddress(url: string): string {
  if (url.length <= URL_MAX) return url;
  try { return `${new URL(url).origin}/`; } catch { return ''; }
}

/** One entry of this PC's file as it travels. */
export function sharedEntry(entry: SideEntry, self: string): SideEntry {
  if (isWeb(entry)) return { id: remoteTabId(self, entry.id), panel: 'remote', device: self, tab: entry.id, url: shortAddress(entry.url ?? ''), ...(entry.by ? { by: entry.by } : {}) };
  const at = pathOf(entry);
  return at !== undefined && entry.device === undefined ? { ...entry, id: pathTabId(entry.panel!, at, self), device: self } : entry;
}

/** A panel that came from elsewhere as this PC's file holds it: a path of this PC without device (its websites: mergeSpace). */
export function localEntry(entry: SideEntry, self: string): SideEntry {
  const at = pathOf(entry);
  if (at === undefined || entry.device !== self) return entry;
  const { device: _device, ...rest } = entry;
  return { ...rest, id: pathTabId(entry.panel!, at) };
}

/** A tab's id as it travels (a view position names its tab by it). */
export function sharedId(id: string, self: string): string {
  if (WEB_ID.test(id)) return remoteTabId(self, id);
  const at = id.indexOf(':');
  const kind = id.slice(0, at);
  const rest = id.slice(at + 1);
  if (kind === 'file' || kind === 'folder' || (kind === 'media' && !STORED_ID.test(rest))) return pathTabId(kind, rest, self);
  return id;
}

/** A travelling tab id as this PC names that tab. */
export function localId(id: string, self: string): string {
  const web = remoteTabId(self, '');
  if (id.startsWith(web)) return id.slice(web.length);
  for (const kind of PATH_KINDS) {
    const prefix = pathTabId(kind, '', self);
    if (id.startsWith(prefix)) return pathTabId(kind, id.slice(prefix.length));
  }
  return id;
}

/** A panel of this PC that cannot travel: its shared form passes main's limits (a very long path), so it stays here only. */
const staysHere = (entry: SideEntry, self: string): boolean => !isWeb(entry) && !panelOf(sharedEntry(entry, self));

/** A space as it travels: its tabs and its shown tab in the shared form (a shown tab it does not list – a blank one – is left out). */
export function sharedSpace(space: SideSpace | undefined, self: string): SideSpace {
  const tabs = (space?.tabs ?? []).filter((entry) => !staysHere(entry, self)).map((entry) => sharedEntry(entry, self));
  const shown = space?.shown === undefined ? undefined : sharedId(space.shown, self);
  return { ...(shown !== undefined && tabs.some((tab) => tab.id === shown) ? { shown } : {}), tabs };
}

/** The spaces as this PC's phone shows them: the websites as 'remote' panels of this PC, everything else as it is. */
export function phoneSpaces(spaces: SideSpaces, self: string): SideSpaces {
  return Object.fromEntries(Object.entries(spaces).map(([key, space]) => {
    const shown = space.shown !== undefined && WEB_ID.test(space.shown) ? remoteTabId(self, space.shown) : space.shown;
    return [key, { ...(shown !== undefined ? { shown } : {}), tabs: space.tabs.map((entry) => (isWeb(entry) ? sharedEntry(entry, self) : entry)) }];
  }));
}

/** An incoming panel as side-tabs.json may hold it (main's rule; a remote panel with its PC, its tab there and an address), else undefined. */
export function panelOf(item: unknown): SideEntry | undefined {
  if (!plain(item) || typeof item.id !== 'string' || typeof item.panel !== 'string' || item.panel === 'new' || item.id.length > ID_MAX) return undefined;
  if (item.device !== undefined && typeof item.device !== 'string') return undefined;
  if (item.panel === 'remote' && (typeof item.device !== 'string' || typeof item.tab !== 'string' || !WEB_ID.test(item.tab) || typeof item.url !== 'string')) return undefined;
  return JSON.stringify(item).length <= ENTRY_MAX ? item as SideEntry : undefined;
}

/**
 * `mine` (this PC's space) after `incoming` (a shared copy from a linked PC, or the phone's space): the copy's tabs in
 * its order, in their local form. This PC's own websites stay its own – one the copy names keeps its own entry (address,
 * opener) at the copy's place; one it does not name stays, at the end, unless `closed` names it; one it names that this
 * PC does not have is left out, unless `create` (this PC's phone opened it) gives it an address worth keeping. A panel
 * that stays here (staysHere) stays at the end too, unless the copy is the phone's (it sees that panel and lists it).
 */
export function mergeSpace(mine: SideSpace | undefined, incoming: { tabs?: unknown; shown?: unknown }, self: string, closed: ReadonlySet<string>, create = false): SideSpace {
  const own = new Map((mine?.tabs ?? []).filter((tab) => isWeb(tab) || (!create && staysHere(tab, self))).map((tab) => [tab.id, tab]));
  const tabs: SideEntry[] = [];
  const placed = new Set<string>();
  const add = (entry: SideEntry) => { if (!placed.has(entry.id)) { placed.add(entry.id); tabs.push(entry); } };
  for (const item of Array.isArray(incoming.tabs) ? incoming.tabs : []) {
    const entry = panelOf(item);
    if (!entry) continue;
    if (entry.panel !== 'remote' || entry.device !== self) { add(localEntry(entry, self)); continue; }
    const kept = own.get(entry.tab as string);
    const url = !kept && create && !closed.has(entry.id) ? keptAddress(entry.url as string) : undefined;
    if (kept) add(kept);
    else if (url) add({ id: entry.tab as string, url });
  }
  for (const tab of own.values()) if (!placed.has(tab.id) && !closed.has(remoteTabId(self, tab.id))) add(tab);
  const shown = typeof incoming.shown === 'string' ? localId(incoming.shown, self) : undefined;
  return { ...(shown !== undefined && placed.has(shown) ? { shown } : {}), tabs };
}

/** Every space without this PC's websites that `closed` names (a linked PC or the phone closed them). */
export function withoutClosed(spaces: SideSpaces, closed: ReadonlySet<string>, self: string): SideSpaces {
  if (![...closed].some((id) => id.startsWith(remoteTabId(self, '')))) return spaces;
  const out: SideSpaces = {};
  for (const [key, space] of Object.entries(spaces)) {
    const tabs = space.tabs.filter((tab) => !isWeb(tab) || !closed.has(remoteTabId(self, tab.id)));
    if (tabs.length) out[key] = { ...(space.shown !== undefined && tabs.some((tab) => tab.id === space.shown) ? { shown: space.shown } : {}), tabs };
  }
  return out;
}

/** `space` without the tabs `ids` names (other PCs' websites closed here: a copy from before the close does not bring them back). */
export function withoutIds(space: SideSpace, ids: readonly string[]): SideSpace {
  if (!ids.length) return space;
  const gone = new Set(ids);
  const tabs = space.tabs.filter((tab) => !gone.has(tab.id));
  return { ...(space.shown !== undefined && !gone.has(space.shown) ? { shown: space.shown } : {}), tabs };
}

/** The websites of other PCs `before` showed and `after` does not: closed here, so their own PC closes them. */
export function closedBetween(before: SideSpace | undefined, after: SideSpace, self: string): string[] {
  const now = new Set(after.tabs.map((tab) => tab.id));
  return (before?.tabs ?? []).filter((tab) => tab.panel === 'remote' && tab.device !== self && !now.has(tab.id)).map((tab) => tab.id);
}

/** This PC's spaces after its phone's `spaces` (each one it names is replaced by the merge; `closed`: the tabs it closed). */
export function applyPhone(current: SideSpaces, spaces: Plain, closed: ReadonlySet<string>, self: string): SideSpaces {
  const next: SideSpaces = { ...current };
  for (const [key, space] of Object.entries(spaces)) {
    if (!isSpace(key) || !plain(space)) continue;
    const merged = mergeSpace(current[key], space, self, closed, true);
    if (merged.tabs.length) next[key] = merged;
    else delete next[key];
  }
  return withoutClosed(next, closed, self);
}
