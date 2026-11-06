// The workspace's tabs, in spaces: 'global' (the person's own pane at the frame's right), one per chat (its area above
// the messages, shared by everyone in it) and one per agent (its own area on its agent page). Each surface (WorkspacePane.tsx with that space) shows one; a space has one
// list (a blank tab too) and a shown tab. Every command names its space, and a part inside a surface passes its own
// (space.ts): the same app tab can be in two spaces. The ways in – openWebsite (a link), addPage (a new tab), and the
// app's own panels: openPanel (any of them, in place of a blank tab when asked from the new-tab page), openNotes,
// openMedia, openVideo, openScreen, openAgentBrowser – each also opens its surface. Named by no space, they land where
// the frame says (setOpener: global, or the open chat's area where the frame has no global pane); asked from a tab
// alone, where that tab is shown. A blank tab exists only here until an address is opened in
// it. On the desktop main owns the spaces (<data>/side-tabs.json, workspace-tabs.ts): this file sends it the panels,
// order and shown tabs, hears what an AI changes there, and main reports every website tab, so one an agent opens or
// closes shows up like the person's own; a page an agent shows (browser.show) is its space's shown tab and asks its
// surface to open (the frame opens the global pane or the open chat's area). A phone has no main: its spaces are its
// PC's (B-076, phone-tabs.ts links them) – the PC's websites are 'remote' tabs, an address typed into a blank tab opens
// one on the PC; a phone that reads no PC's pane keeps its app tabs and chosen tab on the device, over a restart. A
// finished download ends with a toast. Ctrl+F opens the find field (findOpen) of a shown website tab.
// Owns: the spaces, the tab lists, the shown tabs and these commands. Never: page content or agent browser sessions.

import { effect, signal, type Signal } from '@preact/signals';
import { newId } from '../../shared/ids.ts';
import { GLOBAL_SPACE, isSpace, omniboxUrl, remoteTabId, type SideSpaces, type WorkspaceBrowserCommand, type WorkspaceBrowserPage } from '../../shared/api/workspace-browser.ts';
import { bridge, openExternal } from '../lib/platform.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { appTabId, appTabsOf, chosenAfterClose, fromSideSpace, isAppTab, shownId, toSideSpace, type AppTab, type TabEntry } from './browser-model.ts';

const CHOSEN_KEY = 'wf.workspaceTab';
const APP_TABS_KEY = 'wf.workspaceAppTabs';

interface SpaceTabs { tabs: TabEntry[]; shown: string }

/** App tabs this device keeps: a phone without its PC's pane, or a desktop before main owned the spaces (one list – global's – before chats had areas). */
function readDeviceSpaces(): Record<string, SpaceTabs> {
  let kept: unknown = [];
  try { kept = JSON.parse(localStorage.getItem(APP_TABS_KEY) ?? '[]'); } catch { /* storage may be blocked */ }
  const lists = Array.isArray(kept) ? { [GLOBAL_SPACE]: kept } : kept && typeof kept === 'object' ? kept as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(lists).filter(([key]) => isSpace(key)).map(([key, tabs]) => [key, { tabs: appTabsOf(tabs), shown: key === GLOBAL_SPACE ? readChosen() : '' }]));
}

const spaces = signal<Record<string, SpaceTabs>>(bridge?.workspaceBrowser ? {} : readDeviceSpaces());
/** A space's tabs and the tab it shows (read in a render, they follow). */
export const tabsOf = (space: string): TabEntry[] => spaces.value[space]?.tabs ?? [];
export const shownOf = (space: string): string => spaces.value[space]?.shown ?? '';
const tabsNow = (space: string): TabEntry[] => spaces.peek()[space]?.tabs ?? [];
export const browserPages = signal<WorkspaceBrowserPage[]>([]);
/** True once main's first list arrived (until then an empty list says nothing). */
export const pagesListed = signal(false);
/** A request to one space's surface; `ask` counts them all, so each is acted on once. */
export interface SpaceAsk { space: string; ask: number }
/** Focus the address field (a new tab, Ctrl+L), the path field of a file or folder tab (Ctrl+L), open the history (Ctrl+H). */
export const addressFocus = signal<SpaceAsk>({ space: GLOBAL_SPACE, ask: 0 });
export const pathFocus = signal<SpaceAsk>({ space: GLOBAL_SPACE, ask: 0 });
export const historyAsk = signal<SpaceAsk>({ space: GLOBAL_SPACE, ask: 0 });
/** The last failure to open an address, for the tab it concerns. */
export const openError = signal<{ id: string; message: string } | null>(null);
/** The website tab whose header shows the find field; `ask` counts the requests to focus it. */
export const findOpen = signal<{ id: string; ask: number } | null>(null);

export function askFor(target: Signal<SpaceAsk>, space: string): void {
  target.value = { space, ask: target.peek().ask + 1 };
}

function setTabs(space: string, tabs: TabEntry[]): void {
  spaces.value = { ...spaces.peek(), [space]: { shown: spaces.peek()[space]?.shown ?? '', tabs } };
}

/** The space that holds tab `id` – the one showing it first (an app tab's id is what it shows) – global when none does. */
function spaceOf(id: string): string {
  const holding = Object.entries(spaces.peek()).filter(([, space]) => space.tabs.some((tab) => tab.id === id));
  return (holding.find(([, space]) => shownId(space.tabs.map((tab) => tab.id), space.shown) === id) ?? holding[0])?.[0] ?? GLOBAL_SPACE;
}

/** Main's layout arrived (nothing goes back before that), and the last one it knows of. */
let layoutReady = false;
let sentLayout = '';
const layoutOf = (from: Record<string, SpaceTabs>): SideSpaces => Object.fromEntries(Object.entries(from).map(([key, space]) => [key, toSideSpace(space.tabs, space.shown)]));

function sendLayout(from = spaces.peek()): void {
  const native = bridge?.workspaceBrowser;
  if (!native || !layoutReady) return;
  const layout = layoutOf(from);
  const json = JSON.stringify(layout);
  if (json === sentLayout) return;
  sentLayout = json;
  void native.command({ action: 'layout', spaces: layout }).catch(() => undefined);
}

/** The phone's PC (phone-tabs.ts): its id names the PC's websites here, and what changes here goes to it. */
export interface PhoneLink { device: string; send(layout: SideSpaces): void }
let phone: PhoneLink | undefined;

export function linkPhone(link: PhoneLink): void {
  if (!phone) forgetDeviceTabs(); // the PC's spaces are this pane's now
  phone = link;
}

let keptApps = '';
effect(() => { // the desktop: main keeps them in its file; the phone: its PC does, else this device
  const now = spaces.value;
  if (bridge?.workspaceBrowser) { sendLayout(now); return; }
  if (phone) { phone.send(layoutOf(now)); return; }
  const json = JSON.stringify(Object.fromEntries(Object.entries(now).map(([key, space]) => [key, space.tabs.filter(isAppTab)])));
  if (json === keptApps) return;
  keptApps = json;
  try { localStorage.setItem(APP_TABS_KEY, json); } catch { /* storage may be blocked */ }
});

function readChosen(): string {
  try { return localStorage.getItem(CHOSEN_KEY) ?? ''; } catch { return ''; }
}

/** Tabs an address is being opened in (main does not list them yet). */
const opening = new Set<string>();
const newTabId = () => `web-${newId('req').slice(4)}`;

/** The personal browser exists here (the desktop app). */
export function hasPersonalBrowser(): boolean {
  return Boolean(bridge?.workspaceBrowser);
}

/** Websites can be opened from this pane: the desktop's own browser, or the phone's PC. */
export function hasPane(): boolean {
  return hasPersonalBrowser() || phone !== undefined;
}

function showIn(space: string, id: string): void {
  if (!hasPersonalBrowser() && !phone && space === GLOBAL_SPACE) try { localStorage.setItem(CHOSEN_KEY, id); } catch { /* storage may be blocked */ }
  spaces.value = { ...spaces.peek(), [space]: { tabs: tabsNow(space), shown: id } };
}

export function selectPage(id: string, space = GLOBAL_SPACE): void {
  showIn(space, id);
  const other = (tab: string) => tab !== id && tabsNow(space).some((entry) => entry.id === tab); // another tab of this space
  if (openError.value && other(openError.value.id)) openError.value = null;
  if (findOpen.value && other(findOpen.value.id)) findOpen.value = null;
}

let opener: (space: string) => void = () => undefined;
let home: () => string = () => GLOBAL_SPACE;

/** The frame says how a shut surface opens – the global pane, a chat's area – and where a way in naming no space lands (attention.ts). */
export function setOpener(open: (space: string) => void, frameSpace: () => string = () => GLOBAL_SPACE): void {
  opener = open;
  home = frameSpace;
}

function blankPage(space: string, focus: boolean): void {
  if (focus) askFor(addressFocus, space);
  const blank = tabsNow(space).find((page) => page.kind === 'new');
  if (blank) { selectPage(blank.id, space); return; }
  const id = newTabId();
  setTabs(space, [...tabsNow(space), { id, kind: 'new' }]);
  selectPage(id, space);
}

/** A new, blank tab with its address field focused. */
export function addPage(space = GLOBAL_SPACE): void {
  blankPage(space, true);
}

/** A surface never has no tab: once main's list is in, an empty space gets a blank one. */
export function ensureTab(space = GLOBAL_SPACE): void {
  if (pagesListed.value && !tabsNow(space).length) blankPage(space, false);
}

/** The tab a space shows now (its entry), if any. */
export function shownEntry(space = GLOBAL_SPACE): TabEntry | undefined {
  const entries = tabsNow(space);
  const id = shownId(entries.map((page) => page.id), spaces.peek()[space]?.shown ?? '');
  return entries.find((page) => page.id === id);
}

/**
 * Opens (or shows again, with what `tab` now says) one of the app's own panels in `space` and opens its surface.
 * `inPlaceOf`: the blank tab the new-tab page asked from – the panel takes its place, or the blank goes when the panel is
 * open already; without a space the panel opens where that tab is shown, else where the frame says.
 */
export function openPanel(tab: AppTab, inPlaceOf?: string, space = inPlaceOf ? spaceOf(inPlaceOf) : home()): void {
  const id = appTabId(tab);
  const entry = { id, ...tab } as TabEntry;
  const current = tabsNow(space);
  if (current.some((page) => page.id === id)) setTabs(space, current.filter((page) => page.id === id || page.id !== inPlaceOf).map((page) => page.id === id ? entry : page));
  else if (inPlaceOf && current.some((page) => page.id === inPlaceOf)) setTabs(space, current.map((page) => page.id === inPlaceOf ? entry : page));
  else setTabs(space, [...current, entry]);
  selectPage(id, space);
  opener(space);
}

/** An agent's own browser, live, as a tab (it watches only while it is shown – BrowserLive.tsx). */
export function openAgentBrowser(agentId: string, space?: string): void {
  openPanel({ kind: 'agent', agentId }, undefined, space);
}

/** A chat's shared notes as a tab. */
export function openNotes(conversationId: string, space?: string): void {
  openPanel({ kind: 'notes', conversationId }, undefined, space);
}

/** A stored file (media library row or chat file, by its id) or a file on this PC (`path`; on linked PC `device`) as a tab. */
export function openMedia(ref: { fileId?: string; path?: string; name?: string; device?: string }, space?: string): void {
  if (!ref.fileId && !ref.path) return;
  openPanel({ kind: 'media', ...(ref.fileId ? { fileId: ref.fileId } : { path: ref.path!, ...(ref.device ? { device: ref.device } : {}) }), ...(ref.name ? { name: ref.name } : {}) }, undefined, space);
}

/** A chat's video work as a tab: its newest render, or `fileId` when given. */
export function openVideo(ref: { conversationId: string; fileId?: string }, space?: string): void {
  openPanel({ kind: 'video', conversationId: ref.conversationId, ...(ref.fileId ? { fileId: ref.fileId } : {}) }, undefined, space);
}

/** This PC's screen, live, as a tab. */
export function openScreen(space?: string): void {
  openPanel({ kind: 'screen' }, undefined, space);
}

/** A media tab learned its file's name (shown in the header and the tab list). */
export function nameTab(id: string, name: string, space = GLOBAL_SPACE): void {
  const current = tabsNow(space);
  const entry = current.find((page) => page.id === id);
  if (entry?.kind !== 'media' || entry.name === name) return;
  setTabs(space, current.map((page) => page.id === id ? { ...entry, name } : page));
}

/** Ctrl+F: the find field of the space's shown website tab (false when no website tab is shown). */
export function openFind(space = GLOBAL_SPACE): boolean {
  const entry = shownEntry(space);
  if (entry?.kind !== 'website') return false;
  findOpen.value = { id: entry.id, ask: (findOpen.peek()?.ask ?? 0) + 1 };
  return true;
}

export function closeFind(): void {
  findOpen.value = null;
}

/** Loads `url` in tab `id` of `space`, known to the list before main's change event arrives. */
async function load(space: string, id: string, url: string): Promise<void> {
  const native = bridge?.workspaceBrowser;
  if (!native) throw new Error('The browser is only available in the desktop app.');
  const before = tabsNow(space);
  const page: TabEntry = { id, kind: 'website' };
  opening.add(id);
  setTabs(space, before.some((item) => item.id === id) ? before.map((item) => item.id === id ? page : item) : [...before, page]);
  try { browserPages.value = await native.command({ action: 'open', id, url, space }); } catch (error) {
    setTabs(space, before); // nothing opened (a blank tab stays blank)
    throw error;
  } finally { opening.delete(id); }
  sentLayout = ''; // main knows this tab now: its place in the order goes over again
  sendLayout();
}

/** The phone: tab `id` of `space` becomes a website on its PC (the PC opens it, its picture shows here). */
function openOnPc(link: PhoneLink, space: string, id: string, url: string): void {
  const entry: TabEntry = { id: remoteTabId(link.device, id), kind: 'remote', device: link.device, tab: id, url };
  const current = tabsNow(space);
  setTabs(space, current.some((page) => page.id === id) ? current.map((page) => (page.id === id ? entry : page)) : [...current, entry]);
  selectPage(entry.id, space);
}

/** Opens what the address field holds (an address or a search) in tab `id`; a failure shows in the page area. */
export async function goTo(id: string, text: string, space = GLOBAL_SPACE): Promise<void> {
  try {
    const url = omniboxUrl(text);
    if (!hasPersonalBrowser()) { if (phone) openOnPc(phone, space, id, url); else openExternal(url); return; }
    await load(space, id, url);
    openError.value = null;
  } catch (error) { openError.value = { id, message: error instanceof Error ? error.message : 'Could not open the page.' }; }
}

/**
 * Opens `url` in a tab of `space` (the blank one, else a new one; a tab showing exactly that address
 * is only shown), opens its surface and shows the tab unless `select` is false. Returns its id; without
 * the desktop browser the link opens in the system browser.
 */
export async function openWebsite(url: string, options: { select?: boolean; space?: string } = {}): Promise<string | undefined> {
  if (!hasPersonalBrowser()) { openExternal(url); return undefined; }
  const space = options.space ?? home();
  const same =browserPages.value.find((page) => page.url === url && page.space === space)?.id;
  const id = same ?? tabsNow(space).find((page) => page.kind === 'new')?.id ?? newTabId();
  if (!same) await load(space, id, url);
  if (options.select !== false) { selectPage(id, space); opener(space); }
  return id;
}

/** Runs a command of the person's browser on its tab (back, reload, reveal …); a failure is a toast. */
export async function command(action: WorkspaceBrowserCommand): Promise<void> {
  const native = bridge?.workspaceBrowser;
  if (!native) return;
  try { browserPages.value = await native.command(action); } catch (error) { toastError(error); }
}

/** The tab closed last in `space` opens again and is shown. */
export function reopenTab(space = GLOBAL_SPACE): Promise<void> {
  return command({ action: 'reopen', space });
}

/** Shows a website tab of any space on its own surface (the address field's "switch to this tab"). */
export function switchToTab(id: string): void {
  const space = browserPages.peek().find((page) => page.id === id)?.space ?? GLOBAL_SPACE;
  selectPage(id, space);
  opener(space);
}

/** Closes a tab of `space`; the shown one hands over to the next, and the last tab leaves a blank one. */
export async function closePage(id: string, space = GLOBAL_SPACE): Promise<void> {
  const entries = tabsNow(space);
  const entry = entries.find((page) => page.id === id);
  if (!entry) return;
  if (entry.kind === 'website') await command({ action: 'close', id });
  const ids = entries.map((page) => page.id);
  const next = chosenAfterClose(ids, id, shownId(ids, spaces.peek()[space]?.shown ?? ''));
  setTabs(space, tabsNow(space).filter((page) => page.id !== id));
  if (next) selectPage(next, space); else if (hasPane()) blankPage(space, true); // without a browser an empty surface says so
}

/** Closes every tab of `space` but `keep`. */
export async function closeOthers(keep: string, space = GLOBAL_SPACE): Promise<void> {
  for (const page of tabsNow(space)) if (page.id !== keep && page.kind === 'website') await command({ action: 'close', id: page.id });
  setTabs(space, tabsNow(space).filter((page) => page.id === keep));
  showIn(space, keep);
}

/** The last finished download announced per tab (so one ends with one toast). */
const announced = new Map<string, string>();

function announceDownloads(pages: readonly WorkspaceBrowserPage[], quiet: boolean): void {
  for (const page of pages) {
    const download = page.download;
    if (!download || download.state === 'saving') continue;
    const key = `${download.name}:${download.state}`;
    if (announced.get(page.id) === key) continue;
    announced.set(page.id, key);
    if (quiet) continue;
    if (download.state === 'saved') pushToast({ title: 'Saved to downloads/personal', body: download.name, tone: 'info' });
    else if (download.state === 'failed') pushToast({ title: 'Download failed', body: download.name, tone: 'error' });
  }
}

/** What side-tabs.json says now (main's, or the phone's PC's); a blank tab stays where it is, it never goes there. */
export function acceptLayout(layout: SideSpaces): void {
  const before = spaces.peek();
  const next: Record<string, SpaceTabs> = {};
  for (const key of new Set([...Object.keys(layout), ...Object.keys(before)])) {
    const blank = before[key]?.tabs.filter((tab) => tab.kind === 'new' || opening.has(tab.id)) ?? [];
    const listed = layout[key] ? fromSideSpace(layout[key]) : [];
    const tabs = [...listed, ...blank.filter((tab) => !listed.some((item) => item.id === tab.id))];
    if (tabs.length) next[key] = { tabs, shown: layout[key]?.shown ?? before[key]?.shown ?? '' };
  }
  layoutReady = true;
  sentLayout = JSON.stringify(layoutOf(next));
  spaces.value = next;
}

function forgetDeviceTabs(): void {
  try {
    localStorage.removeItem(APP_TABS_KEY);
    localStorage.removeItem(CHOSEN_KEY);
  } catch { /* storage may be blocked */ }
}

/** Once: what this device kept in localStorage before main owned the spaces goes into the global space. */
function takeOverDeviceTabs(): void {
  const kept = readDeviceSpaces()[GLOBAL_SPACE] ?? { tabs: [], shown: '' };
  forgetDeviceTabs();
  const global = spaces.peek()[GLOBAL_SPACE] ?? { tabs: [], shown: '' };
  const added = kept.tabs.filter((tab) => !global.tabs.some((item) => item.id === tab.id));
  if (added.length || (kept.shown && !global.shown)) spaces.value = { ...spaces.peek(), [GLOBAL_SPACE]: { tabs: [...global.tabs, ...added], shown: global.shown || kept.shown } };
}

let started = false;

/** Keeps the spaces in step with main (idempotent; desktop only). */
export function watchPersonalBrowser(): void {
  const native = bridge?.workspaceBrowser;
  if (started || !native) return;
  started = true;
  let first = true;
  const accept = (pages: WorkspaceBrowserPage[], initial: boolean) => {
    browserPages.value = pages;
    const listed = new Set(pages.map((page) => page.id));
    const known = new Set(Object.values(spaces.peek()).flatMap((space) => space.tabs.map((page) => page.id)));
    const added = pages.filter((page) => !known.has(page.id));
    const next = { ...spaces.peek() };
    for (const [key, space] of Object.entries(next)) {
      const kept = space.tabs.filter((page) => page.kind !== 'website' || listed.has(page.id) || opening.has(page.id)); // a tab main closed is gone here too
      if (kept.length !== space.tabs.length) next[key] = { ...space, tabs: kept };
    }
    // a page a site or an agent's browser.show opened takes its space's selection (a Ctrl / middle click's and an agent's other pages stay in the background)
    const taken = initial ? [] : added.filter((page) => !page.restored && !page.background);
    for (const page of added) {
      const space = next[page.space] ?? { tabs: [], shown: '' };
      next[page.space] = { tabs: [...space.tabs, { id: page.id, kind: 'website' }], shown: taken.includes(page) ? page.id : space.shown };
    }
    if (added.length || Object.keys(next).some((key) => next[key] !== spaces.peek()[key])) spaces.value = next;
    for (const page of taken) if (page.opener) opener(page.space); // an agent showed it: its surface opens (if it is on screen)
    announceDownloads(pages, initial);
  };
  native.onChanged((pages) => { if (!first) accept(pages, false); });
  native.onLayout(acceptLayout);
  Promise.all([native.layout(), native.command({ action: 'list' })]).then(([layout, pages]) => {
    acceptLayout(layout);
    takeOverDeviceTabs();
    accept(pages, true);
    first = false;
    pagesListed.value = true;
    sendLayout();
  }).catch((error) => { first = false; layoutReady = true; pagesListed.value = true; toastError(error); });
}
