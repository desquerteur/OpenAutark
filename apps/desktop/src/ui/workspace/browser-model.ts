// Pure rules of the side pane: the tab kinds (a blank or website tab, and the app's own panels – My day,
// Work, Activity, a chat's Notes, a Media item or the media library, a chat's Video work, this PC's Screen, an agent's own browser, a file or folder by its path), how a
// tab is named, what the address slot shows at rest, which tab is shown and which one is chosen after a
// close or by Ctrl+Tab and Ctrl+1…9, and a space's tabs to and from side-tabs.json's form (a blank tab stays in the window).
// B-076: a tab can belong to another PC – a website running there ('remote': its PC, its tab id there, its address) or a
// file, folder or media item by path there (`device`, in its id too); on the phone the PC's own websites are 'remote'.
// Owns: these rules. Never: signals, the DOM or the native bridge.

import { pathTabId, remoteTabId, type BrowserKeyAction, type PageOpener, type SideEntry, type SideSpace, type TabDownload, type WorkspaceBrowserPage } from '../../shared/api/workspace-browser.ts';

/** The app's own tabs (no website): what each one shows. */
export type AppTab =
  | { kind: 'day' }
  | { kind: 'work' }
  | { kind: 'activity' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'notes'; conversationId: string }
  | { kind: 'media'; fileId?: string; path?: string; name?: string; device?: string }
  | { kind: 'video'; conversationId: string; fileId?: string }
  | { kind: 'screen' }
  | { kind: 'file'; path: string; device?: string }
  | { kind: 'folder'; path: string; device?: string }
  | { kind: 'page'; name: string }
  | { kind: 'remote'; device: string; tab: string; url: string; title?: string };
export type AppEntry = { id: string } & AppTab;

/** The tab entries the pane keeps: a blank tab and the app's tabs exist only here, a website tab also in main. */
export type TabEntry = { id: string; kind: 'new' | 'website' } | AppEntry;
export type TabKind = TabEntry['kind'];

/** A tab as the strip and the tab list show it (an app tab: `host` is its kind's word, `title` what it shows; `transient`: an agent's preview tab; `device`: the PC it belongs to, when that is named). */
export interface TabInfo { id: string; kind: TabKind; blank: boolean; url: string; host: string; title: string; loading?: boolean; favicon?: string; download?: TabDownload; opener?: PageOpener; agentId?: string; audible?: boolean; muted?: boolean; transient?: true; device?: string }

export const APP_KIND_LABEL: Record<AppTab['kind'], string> = { day: 'My day', work: 'Work', activity: 'Activity', agent: 'Browser', notes: 'Notes', media: 'Media', video: 'Video', screen: 'Screen', file: 'File', folder: 'Folder', page: 'Page', remote: 'Website' };

export function isAppTab(entry: TabEntry | undefined): entry is AppEntry {
  return entry !== undefined && entry.kind !== 'new' && entry.kind !== 'website';
}

/** One tab per thing shown: My day, Work, Activity, an agent's browser, a chat's notes, a file (of this PC or another), the media library, a chat's video work, the screen, another PC's website. */
export function appTabId(tab: AppTab): string {
  if (tab.kind === 'day' || tab.kind === 'work' || tab.kind === 'activity') return tab.kind;
  if (tab.kind === 'agent') return `agent:${tab.agentId}`;
  if (tab.kind === 'notes') return `notes:${tab.conversationId}`;
  if (tab.kind === 'video') return `video:${tab.conversationId}`;
  if (tab.kind === 'media') return tab.fileId ? `media:${tab.fileId}` : tab.path ? pathTabId('media', tab.path, tab.device) : 'media';
  if (tab.kind === 'file' || tab.kind === 'folder') return pathTabId(tab.kind, tab.path, tab.device);
  if (tab.kind === 'page') return `page:${tab.name}`;
  if (tab.kind === 'remote') return remoteTabId(tab.device, tab.tab);
  return 'screen';
}

/** App tabs read back from storage: only well-formed ones count. */
export function appTabsOf(value: unknown): AppEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AppEntry => {
    const tab = item as Record<string, unknown> | null;
    if (!tab || typeof tab.id !== 'string') return false;
    const id = () => tab.id === appTabId(tab as unknown as AppTab);
    if (tab.device !== undefined && typeof tab.device !== 'string') return false;
    if (tab.kind === 'notes' || tab.kind === 'video') return typeof tab.conversationId === 'string' && id();
    if (tab.kind === 'media') return id();
    if (tab.kind === 'remote') return typeof tab.device === 'string' && typeof tab.tab === 'string' && typeof tab.url === 'string' && id();
    if (tab.kind === 'agent') return typeof tab.agentId === 'string' && id();
    if (tab.kind === 'file' || tab.kind === 'folder') return typeof tab.path === 'string' && id();
    if (tab.kind === 'page') return typeof tab.name === 'string' && id();
    return (tab.kind === 'screen' || tab.kind === 'day' || tab.kind === 'work' || tab.kind === 'activity') && id();
  });
}

/** "example.com" of an address ("" for anything that is no address). */
export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

/** What the address slot shows at rest: the address alone, without the https:// and www. every page has and a bare trailing slash. */
export function displayAddress(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/^(http:\/\/)?www\./, '$1').replace(/^((?:http:\/\/)?[^/?#]+)\/$/, '$1');
}

/** `appTitle` names what an app tab shows (a chat's title, a file's name); without it the kind's word stands alone. */
export function tabInfos(entries: readonly TabEntry[], pages: readonly WorkspaceBrowserPage[], appTitle: (entry: AppEntry) => string = () => ''): TabInfo[] {
  return entries.map((entry) => {
    if (entry.kind === 'remote') return { id: entry.id, kind: entry.kind, blank: false, url: entry.url, host: hostOf(entry.url), title: entry.title ?? '', device: entry.device };
    if (isAppTab(entry)) return { id: entry.id, kind: entry.kind, blank: false, url: '', host: APP_KIND_LABEL[entry.kind], title: appTitle(entry), ...(entry.kind === 'agent' ? { agentId: entry.agentId } : {}), ...('device' in entry && entry.device ? { device: entry.device } : {}) };
    const page = pages.find((item) => item.id === entry.id);
    const url = entry.kind === 'new' ? '' : page?.url ?? '';
    return { id: entry.id, kind: entry.kind, blank: entry.kind === 'new', url, host: hostOf(url), title: page?.title ?? '', ...(page?.loading ? { loading: true } : {}), ...(page?.favicon ? { favicon: page.favicon } : {}), ...(page?.download ? { download: page.download } : {}), ...(page?.opener ? { opener: page.opener } : {}), ...(page?.audible ? { audible: true } : {}), ...(page?.muted ? { muted: true } : {}), ...(page?.transient ? { transient: true as const } : {}) };
  });
}

/** A space's tabs as side-tabs.json holds them: a website by its id (main has its address), a panel with what it shows. */
export function toSideSpace(tabs: readonly TabEntry[], shown: string): SideSpace {
  const entries: SideEntry[] = [];
  for (const tab of tabs) {
    if (tab.kind === 'website') entries.push({ id: tab.id });
    else if (isAppTab(tab)) { const { kind, ...rest } = tab; entries.push({ ...rest, panel: kind }); }
  }
  return { ...(entries.some((entry) => entry.id === shown) ? { shown } : {}), tabs: entries };
}

/** A space's tabs from side-tabs.json (well-formed ones). */
export function fromSideSpace(space: SideSpace): TabEntry[] {
  return space.tabs.flatMap((entry): TabEntry[] => {
    if (entry.panel === undefined) return [{ id: entry.id, kind: 'website' }];
    const { panel, ...rest } = entry;
    return appTabsOf([{ ...rest, kind: panel }]);
  });
}

/** What the tab list calls a tab: its title, else its host, else "New tab". */
export function tabName(tab: Pick<TabInfo, 'title' | 'host' | 'url'>): string {
  return tab.title || tab.host || tab.url || 'New tab';
}

/** The tab shown: the chosen one while it exists, else the newest. */
export function shownId(ids: readonly string[], chosen: string): string | undefined {
  return ids.includes(chosen) ? chosen : ids.at(-1);
}

/** The tab chosen once `closing` has left `ids`: the shown one stays; a closed shown one hands over to the next, else the one before. */
export function chosenAfterClose(ids: readonly string[], closing: string, shown: string | undefined): string | undefined {
  const rest = ids.filter((id) => id !== closing);
  if (shown !== undefined && shown !== closing && rest.includes(shown)) return shown;
  const at = ids.indexOf(closing);
  return rest[Math.min(Math.max(at, 0), rest.length - 1)];
}

/** The tab Ctrl+Tab, Ctrl+Shift+Tab or Ctrl+1…9 goes to from `current` in the strip's order (Ctrl+9 the last; undefined: stay). */
export function tabFor(action: BrowserKeyAction, order: readonly string[], current: string | undefined): string | undefined {
  if (!order.length) return undefined;
  const at = current === undefined ? -1 : order.indexOf(current);
  if (action === 'next-tab') return order[at < 0 ? 0 : (at + 1) % order.length];
  if (action === 'previous-tab') return order[at < 0 ? order.length - 1 : (at - 1 + order.length) % order.length];
  const n = /^tab-(\d)$/.exec(action)?.[1];
  if (!n) return undefined;
  return n === '9' ? order.at(-1) : order[Number(n) - 1];
}
