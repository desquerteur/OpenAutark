// The person's browser: native website tabs (WebContentsView) in one separate persistent session, sandboxed renderers,
// no preload, no Node, non-web navigation refused. Tabs live in spaces – global (the person's pane), one per chat (its
// area above the messages) and one per agent (its area on the agent page) – all in this one session, so a login the person makes in one tab holds in every space. Each
// space shows one tab on its slot (workspace-shown.ts): the pane and a chat's area show pages at the same time.
// <data>/side-tabs.json keeps the spaces; main owns it and re-reads it when an AI or an editor changes it (workspace-tabs.ts).
// Memory: a page hidden 20 min goes (workspace-discard.ts), at most MAX_LIVE stay loaded (least recently used first), a
// tab not loaded loads when shown or used; a page an agent uses unseen lives on the host (workspace-host.ts), and so does
// one the person watches from another PC or a phone (B-076) – also when its slot's window is minimized or hidden – until
// that watch ends (sideRelease). A site's prefers-color-scheme follows the app's theme (workspace-chrome.ts colorScheme).
// Find, sound, zoom, history, DevTools, focus and page shortcuts: workspace-chrome.ts; permissions and downloads:
// workspace-session.ts; the page menu: workspace-page-menu.ts; closed tabs: workspace-tab-memory.ts. Agents work here
// through main/side-driver (sideTabs, sideContents, sideOpen, sideKeep, sideClose, sideRelease); a tab an agent opens carries the agent
// and the chat (`opener`), and so do the pages it opens; an agent's page is its preview tab in that space until the person
// uses it or keeps it (workspace-marks.ts).
// Owns: tab lifetime, events, viewport and trusted IPC. Never: reads page content (except a picture for Send page to
// chat), cookies or tokens, or grants runtime ports.

import { Menu, clipboard, ipcMain, nativeTheme, session, shell, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { GLOBAL_SPACE, WORKSPACE_BROWSER, browserUrl, type BrowserBounds, type PageOpener, type WorkspaceBrowserCommand, type WorkspaceBrowserPage } from '../shared/api/workspace-browser.ts';
import { trusted } from './ipc.ts';
import { captureTab } from './workspace-capture.ts';
import { PageHost } from './workspace-host.ts';
import { MAX_TABS, PersonalTabs, watchTabsFile } from './workspace-tabs.ts';
import { WorkspaceSession } from './workspace-session.ts';
import { CHROME_ACTIONS, TabChrome, colorScheme, type ChromeCommand } from './workspace-chrome.ts';
import { browserCommand, tabId } from './workspace-commands.ts';
import { DiscardTimer, discardAfter } from './workspace-discard.ts';
import { faviconData } from './workspace-favicon.ts';
import { attachPageMenu } from './workspace-page-menu.ts';
import { ClosedTabs } from './workspace-tab-memory.ts';
import { ShownTabs, fit } from './workspace-shown.ts';
import { TabMarks } from './workspace-marks.ts';

interface Tab { view: WebContentsView; error?: string; favicon?: string; iconAsk: number }

/** Loaded pages across all spaces; the least recently used goes first (it loads again when shown or used). */
export const MAX_LIVE = 5;

export interface WorkspaceBrowserOptions {
  /** <data>/side-tabs.json */
  tabsFile?: string;
  /** The flat list it replaces, moved over once. */
  oldTabsFile?: string;
  /** <data>/browser-history.json and <data>/workspace-zoom.json (without them both last until the app closes). */
  historyFile?: string;
  zoomFile?: string;
  /** <workspace>/downloads/personal (without it downloads are refused). */
  downloadsDir?: string;
  /** How long a hidden tab keeps its page (memory saver). */
  discardMs?: number;
  /** A tab's page was made (its contents) or is gone (null) – main/side-driver watches it for agents. */
  onTab?(id: string, contents: WebContents | null): void;
  keep?(id: string): boolean; // B-076: someone watches the page from another PC or a phone – it stays loaded
}

export class WorkspaceBrowser {
  private tabs = new Map<string, Tab>();
  private readonly slots = new ShownTabs();
  private owner: BrowserWindow | null = null;
  private readonly host = new PageHost((id) => { if (!this.watched?.(id)) this.fromHost(id); }); // a watched page stays until its watch ends (sideRelease)
  private ended = false;
  /** Live tabs, least recently used first. */
  private readonly recent = new Set<string>();
  private getWindow: () => BrowserWindow | null;
  private browserSession = session.fromPartition('persist:workspace-browser');
  private readonly saved: PersonalTabs;
  private readonly rules: WorkspaceSession;
  private readonly chrome: TabChrome;
  private readonly discards: DiscardTimer;
  /** A discarded tab's title (shown until it loads again). */
  private readonly parked = new Map<string, string>();
  /** Background tabs, openers and agents' preview tabs. */
  private readonly marks = new TabMarks();
  private readonly closedTabs = new ClosedTabs();
  /** The space whose next shown tab gets the keyboard (the page there that had it went). */
  private focusNext: string | null = null;
  private readonly onTab: WorkspaceBrowserOptions['onTab'];
  private readonly watched: WorkspaceBrowserOptions['keep'];

  constructor(getWindow: () => BrowserWindow | null, options: WorkspaceBrowserOptions = {}) {
    this.getWindow = getWindow;
    this.onTab = options.onTab; this.watched = options.keep;
    this.saved = new PersonalTabs({ file: options.tabsFile, oldFile: options.oldTabsFile });
    if (options.tabsFile) watchTabsFile(options.tabsFile, () => this.fileChanged());
    this.rules = new WorkspaceSession(this.browserSession, { tabOf: (contents) => this.idOf(contents), changed: () => this.publish() }, {
      downloadsDir: options.downloadsDir, reveal: (file) => shell.showItemInFolder(file),
    });
    this.chrome = new TabChrome({
      window: () => this.getWindow(), publish: () => this.publish(),
      mainKey: (id, action) => { try { this.command(action === 'reopen' ? { action, space: this.saved.spaceOf(id) } : { action, id }); } catch { /* the tab went meanwhile */ } },
      agentTab: (id) => Boolean(this.marks.opener(id) ?? this.saved.byOf(id)),
    }, { historyFile: options.historyFile, zoomFile: options.zoomFile });
    this.discards = new DiscardTimer({
      after: discardAfter(options.discardMs), now: Date.now, set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      keep: (id) => this.keepLoaded(id), discard: (id) => this.discard(id),
    });
    this.browserSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'file://*/*', 'app://*/*', 'wf-sandbox://*/*'] }, (details, callback) => {
      callback({ cancel: !/^https?:\/\//i.test(details.url) });
    });
    const handle = <T>(channel: string, run: (...args: unknown[]) => T | Promise<T>) => ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!trusted(event, this.getWindow()?.webContents.id ?? null)) return { ok: false, error: { code: 'forbidden', message: 'Untrusted request.' } };
      try { return { ok: true, value: await run(...args) }; }
      catch (error) { return { ok: false, error: { code: 'bad_request', message: error instanceof Error ? error.message : 'Could not update the browser.' } }; }
    });
    nativeTheme.on('updated', () => { for (const tab of this.tabs.values()) this.scheme(tab.view.webContents); });
    handle(WORKSPACE_BROWSER.command, (value) => this.command(browserCommand(value)));
    handle(WORKSPACE_BROWSER.capture, (id) => captureTab(tabId(id), this.tabs.get(tabId(id))));
    handle(WORKSPACE_BROWSER.layout, () => this.saved.layout());
    handle(WORKSPACE_BROWSER.history, (request) => this.chrome.historyRequest(request));
  }

  /** Tabs the memory saver leaves loaded: shown (or last, workspace-shown.ts), playing sound, muted (a new page would forget it), DevTools open, downloading, or watched (B-076). */
  private keepLoaded(id: string): boolean {
    const contents = this.tabs.get(id)?.view.webContents;
    if (!contents || contents.isDestroyed()) return false;
    return this.slots.kept(id) || contents.isCurrentlyAudible() || contents.isAudioMuted() || contents.isDevToolsOpened() || this.rules.busy(id) || Boolean(this.watched?.(id));
  }

  /** The memory saver: the page goes, its address and title stay; it loads when shown. */
  private discard(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed() || !/^https?:\/\//i.test(tab.view.webContents.getURL())) return;
    const contents = tab.view.webContents;
    this.parked.set(id, contents.getTitle());
    this.saved.discard(id, contents.getURL());
    this.chrome.closed(id);
    this.drop(id, tab);
    this.publish();
  }

  /** A tab's view leaves its window and its page closes. */
  private drop(id: string, tab: Tab): void {
    if (!this.host.has(id)) this.owner?.contentView.removeChildView(tab.view);
    this.host.forget(id, tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs.delete(id); this.recent.delete(id);
  }

  /** The page leaves the host: into the app window when there is one. */
  private fromHost(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) this.host.release(id, tab.view, this.getWindow() ? this.attachWindow() : null);
  }

  /** This tab was just used; the pages over the cap go, least recently used first. */
  private used(id: string): void {
    this.recent.delete(id); this.recent.add(id);
    for (const old of [...this.recent]) {
      if (this.tabs.size <= MAX_LIVE) return;
      if (old !== id && !this.keepLoaded(old)) this.discard(old);
    }
  }

  /** side-tabs.json changed from outside: its tabs and panels are what counts now. */
  private fileChanged(): void {
    const changes = this.saved.reload();
    if (!changes) return;
    this.getWindow()?.webContents.send(WORKSPACE_BROWSER.layoutChanged, this.saved.layout()); // first: a page list hearing of the closes below would make the window send its old layout back
    for (const id of changes.closed) try { this.command({ action: 'close', id }); } catch { /* it went meanwhile */ }
    for (const { id, url } of changes.navigate) void this.tabs.get(id)?.view.webContents.loadURL(url).catch(() => {});
    this.publish();
  }

  /** The page's prefers-color-scheme as the app's theme (workspace-chrome.ts). */
  private scheme(contents: WebContents): void { colorScheme(contents, nativeTheme.shouldUseDarkColors); }

  private idOf(contents: WebContents | null | undefined): string | undefined {
    return contents ? [...this.tabs].find(([, tab]) => tab.view.webContents === contents)?.[0] : undefined;
  }

  private list(): WorkspaceBrowserPage[] {
    const pages: WorkspaceBrowserPage[] = [];
    for (const id of this.saved.ids()) {
      const space = this.saved.spaceOf(id);
      const opener = this.openerOf(id, space);
      const tab = this.tabs.get(id);
      if (!tab) {
        const url = this.saved.restoredUrl(id);
        if (url) pages.push({ id, space, url, title: this.parked.get(id) ?? '', loading: false, back: false, forward: false, restored: true, ...this.marks.page(id), ...(opener ? { opener } : {}) });
        continue;
      }
      if (tab.view.webContents.isDestroyed()) continue;
      const contents = tab.view.webContents;
      pages.push({
        id, space, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(), back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(),
        ...(tab.error ? { error: tab.error } : {}), ...(tab.favicon ? { favicon: tab.favicon } : {}), ...this.rules.extras(id), ...this.chrome.extras(id, contents),
        ...this.marks.page(id), ...(opener ? { opener } : {}),
      });
    }
    return pages;
  }

  /** Who opened a tab: known while the app runs; after a restart the file's `by` and its space say it. */
  private openerOf(id: string, space: string): PageOpener | undefined {
    const known = this.marks.opener(id);
    if (known) return known;
    const by = this.saved.byOf(id);
    return by ? { agentId: by, agentName: '', ...(space.startsWith('chat:') ? { chatId: space.slice(5) } : {}) } : undefined;
  }

  /** Live tabs' current addresses (for saving). */
  private addresses(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, tab] of this.tabs) if (!tab.view.webContents.isDestroyed()) out.set(id, tab.view.webContents.getURL());
    return out;
  }

  private publish(): void {
    if (this.ended) return; // the pages closed for the quit: the window keeps its list and the file what dispose saved
    this.saved.save(this.addresses()); // only when order or addresses changed (workspace-tabs.ts)
    this.getWindow()?.webContents.send(WORKSPACE_BROWSER.changed, this.list());
  }

  private attachWindow(): BrowserWindow {
    const window = this.getWindow();
    if (!window) throw new Error('The window is closed.');
    if (this.owner !== window) {
      this.owner = window;
      for (const [id, tab] of this.tabs) if (!this.host.has(id) && !tab.view.webContents.isDestroyed()) { window.contentView.addChildView(tab.view); tab.view.setVisible(false); } // pages that waited without a window
      window.once('closed', () => this.windowGone());
      window.on('restore', () => this.backFromHost()); window.on('show', () => this.backFromHost()); // B-076: on screen again
      // Hide before resize/reload so native content never covers newly positioned UI.
      window.on('resize', () => this.hide());
      window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => { if (main && !inPlace) this.hide(); });
    }
    return window;
  }

  /** The page's icon, read through the tab's own session; an older answer never overwrites a newer one. */
  private async icon(tab: Tab, urls: string[]): Promise<void> {
    const ask = ++tab.iconAsk;
    const data = await faviconData(this.browserSession, urls);
    if (ask === tab.iconAsk && !tab.view.webContents.isDestroyed() && data !== tab.favicon) { tab.favicon = data; this.publish(); }
  }

  private create(id: string, space: string = this.saved.spaceOf(id), by?: string): Tab {
    if (!this.saved.ids().includes(id) && this.saved.sizeOf(space) >= MAX_TABS) throw new Error('Close a browser tab before opening another.');
    const view = new WebContentsView({ webPreferences: {
      session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, safeDialogs: true,
      navigateOnDragDrop: false, backgroundThrottling: true,
    } });
    const tab: Tab = { view, iconAsk: 0 };
    this.tabs.set(id, tab);
    this.saved.shown(id, space, by);
    if (this.getWindow()) this.attachWindow().contentView.addChildView(view); // without a window an agent asked for it: it goes to the host at its first use
    view.setBounds(this.slots.boundsFor(space));
    view.setVisible(false);
    const contents = view.webContents;
    this.scheme(contents);
    this.chrome.attach(id, contents); // before the listeners below, so their publish carries its state
    this.onTab?.(id, contents); contents.once('destroyed', () => this.onTab?.(id, null));
    this.parked.delete(id);
    const allow = (url: string) => { try { return /^https?:\/\//i.test(url) && Boolean(new URL(browserUrl(url)).host); } catch { return false; } };
    contents.on('will-navigate', (event, url) => { if (!allow(url)) event.preventDefault(); });
    contents.on('will-frame-navigate', event => { if (!allow(event.url) && event.url !== 'about:blank') event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!allow(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // in the background on a Ctrl / middle click or from a page the person does not look at; an agent's page passes its opener on
      if (allow(url)) try { this.openTab(url, this.saved.spaceOf(id), disposition !== 'background-tab' && this.slots.isShown(id), this.marks.opener(id)); } catch { /* the space is full */ }
      return { action: 'deny' };
    });
    attachPageMenu(contents, { window: () => this.getWindow(), openLink: (url) => this.openLink(url, this.saved.spaceOf(id)), electron: { Menu, clipboard } });
    contents.on('did-start-loading', () => {
      tab.error = undefined;
      this.again(id);
      this.publish();
    });
    contents.on('did-stop-loading', () => this.publish());
    contents.on('did-navigate', () => { tab.favicon = undefined; tab.iconAsk++; this.publish(); }); // another page: its own icon follows
    contents.on('did-navigate-in-page', () => this.publish());
    contents.on('page-title-updated', () => this.publish());
    contents.on('page-favicon-updated', (_event, favicons) => { void this.icon(tab, favicons); });
    contents.on('did-fail-load', (_event, code, _description, _url, main) => {
      if (!main || code === -3) return;
      tab.error = 'This page could not be loaded. Check the address or try again.';
      if (this.slots.isShown(id)) view.setVisible(false);
      this.publish();
    });
    contents.on('render-process-gone', () => { tab.error = 'This page stopped responding. Reload to try again.'; view.setVisible(false); this.publish(); });
    if (!this.slots.isShown(id)) this.discards.hidden(id);
    this.used(id);
    return tab;
  }

  /** Takes `id` off its slot, or every tab (no id: the window resizes or reloads, so native content never covers newly placed UI). */
  private hide(id?: string): void {
    for (const off of this.slots.hide(id)) {
      const tab = this.tabs.get(off);
      if (!tab || this.host.has(off) || tab.view.webContents.isDestroyed()) continue;
      if (tab.view.webContents.isFocused()) this.focusNext = this.saved.spaceOf(off); // the tab shown next there gets the keyboard
      tab.view.setVisible(false);
    }
  }

  /** `id` on its space's slot: it takes the place of the tab that space showed, the other spaces keep theirs. */
  private place(id: string, bounds: BrowserBounds): void {
    const space = this.saved.spaceOf(id);
    const before = this.tabs.get(this.slots.shownIn(space) ?? '');
    const typing = this.focusNext === space || Boolean(before && before !== this.tabs.get(id) && !before.view.webContents.isDestroyed() && before.view.webContents.isFocused());
    const [width, height] = this.attachWindow().getContentSize();
    this.slots.show(space, id, fit(bounds, width, height));
    if (this.focusNext === space) this.focusNext = null;
    this.used(id);
    this.fromHost(id); // shown: back in the window
    if (this.marks.shown(id)) this.publish(); // shown: no background tab any more
    const live = [...this.tabs].filter(([key, tab]) => !tab.view.webContents.isDestroyed() && !this.host.has(key));
    this.slots.arrange(live, (key, shown) => { if (shown) this.discards.shown(key); else this.discards.hidden(key); });
    const shown = this.tabs.get(id);
    if (typing && shown && !shown.error && !shown.view.webContents.isDestroyed()) shown.view.webContents.focus(); // keyboard tab switches keep typing in pages
  }

  /** A shown tab back on its slot (its page started loading again, or was reloaded after a failure). */
  private again(id: string): void { if (this.slots.isShown(id)) this.place(id, this.slots.boundsFor(this.saved.spaceOf(id))); }
  /** The window is on screen again: a shown tab a watcher woke on the host while it was minimized or hidden comes back. */
  private backFromHost(): void { for (const id of [...this.tabs.keys()]) if (this.slots.isShown(id) && this.host.has(id)) this.again(id); }

  /** A restored or discarded tab is loaded the first time it is shown or used. */
  private wake(id: string): Tab | undefined {
    const live = this.tabs.get(id);
    if (live) return live;
    const url = this.saved.restoredUrl(id);
    if (!url) return undefined;
    const tab = this.create(id);
    void tab.view.webContents.loadURL(url).catch(() => {}); // did-fail-load publishes the visible failure
    return tab;
  }

  private command(command: WorkspaceBrowserCommand): WorkspaceBrowserPage[] {
    if (this.getWindow()) this.attachWindow();
    if (command.action === 'list') return this.list();
    if (command.action === 'layout') { this.saved.setLayout(command.spaces); this.saved.save(this.addresses()); return this.list(); }
    if (command.action === 'show') { if (this.wake(command.id)) this.place(command.id, command.bounds); return this.list(); }
    if (command.action === 'hide') { this.hide(command.id); return this.list(); }
    if (command.action === 'keep') { if (this.marks.keep(command.id)) this.publish(); return this.list(); }
    if (command.action === 'reveal') { this.rules.reveal(command.id); return this.list(); }
    if (command.action === 'open') {
      const url = new URL(browserUrl(command.url)).href;
      if (this.saved.ids().includes(command.id)) this.marks.keep(command.id); // the person's own address in a preview tab: it stays
      this.load(command.id, url, command.space ?? this.saved.spaceOf(command.id));
      return this.list();
    }
    if (command.action === 'reopen') {
      const last = this.closedTabs.pop(command.space);
      if (last) this.command({ action: 'open', id: `web-${crypto.randomUUID()}`, url: last.url, space: last.space }); // a new tab that takes the selection
      return this.list();
    }
    if (command.action === 'close') {
      const live = this.tabs.get(command.id)?.view.webContents;
      const address = live && !live.isDestroyed() ? live.getURL() : this.saved.restoredUrl(command.id);
      if (address) this.closedTabs.push({ url: address, space: this.saved.spaceOf(command.id) });
      if (live && !live.isDestroyed() && live.isFocused()) this.focusNext = this.saved.spaceOf(command.id); // the tab shown next there gets the keyboard
      this.parked.delete(command.id); this.marks.closed(command.id);
      this.discards.shown(command.id); this.chrome.closed(command.id); this.rules.closed(command.id);
      const tab = this.tabs.get(command.id);
      if (tab) this.drop(command.id, tab);
      this.saved.closed(command.id);
      this.slots.hide(command.id);
      this.publish();
      return this.list();
    }
    const tab = this.wake(command.id);
    if (!tab) return this.list();
    const contents = tab.view.webContents;
    if (command.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command.action === 'reload') {
      tab.error = undefined;
      contents.reload();
      this.again(command.id);
    } else if (command.action === 'stop') contents.stop();
    else if (CHROME_ACTIONS.has(command.action)) this.chrome.command(command.id, contents, command as ChromeCommand);
    this.publish();
    return this.list();
  }

  // Agents reach these tabs only through main/side-driver (driver.ts SideTabsLike): the tab list with the space's shown
  // tab now (`active`) and the one side-tabs.json names (`last`), a tab's page (a restored one loads; an agent's use
  // restarts the memory saver's time), a page opened as an agent's tab in a space (in the background unless `show`; its
  // preview tab there unless `newTab`), the person's use of a tab (it stays), closing.
  sideTabs(space: string = GLOBAL_SPACE): { pages: WorkspaceBrowserPage[]; active: string | null; last: string | null } { return { pages: this.list(), active: this.slots.shownIn(space), last: this.saved.shownOf(space) ?? null }; }
  sideContents(id: string, watcher = false): WebContents | undefined {
    if (this.ended) return undefined;
    const tab = this.wake(id);
    if (!tab || tab.view.webContents.isDestroyed()) return undefined;
    if (!this.slots.painted(id, this.owner)) { this.discards.shown(id); this.discards.hidden(id); this.host.take(id, tab.view); } // place() brings it back
    if (!watcher) this.host.touch(id); // an agent's use; a watcher's page goes back when the watch ends (sideRelease)
    this.used(id);
    return tab.view.webContents;
  }
  /** B-076: nobody watches `id` from another PC or a phone any more: off the host, unless an agent used it lately. */
  sideRelease(id: string): void { if (this.host.has(id) && !this.host.usedLately(id)) this.fromHost(id); }
  sideOpen(url: string, opener: PageOpener, show = false, space: string = GLOBAL_SPACE, newTab = false): string {
    const preview = newTab ? undefined : this.marks.previewOf(opener.agentId, (id) => this.saved.spaceOf(id) === space);
    if (preview && (!show || this.slots.shownIn(space) === preview)) { this.load(preview, new URL(browserUrl(url)).href, space); return preview; }
    const id = this.openTab(url, space, show, opener, !newTab);
    if (preview) this.command({ action: 'close', id: preview }); // shown at once: the new tab replaces the preview
    return id;
  }
  sideKeep(id: string): void { if (this.marks.keep(id)) this.publish(); }
  sideClose(id: string): void { this.command({ action: 'close', id }); }

  /** A new tab of `space` at `url`, its id: in the background unless `show` (the tabs shown stay shown), with the agent that opened it. */
  private openTab(url: string, space: string, show: boolean, opener?: PageOpener, preview = false): string {
    const id = `web-${crypto.randomUUID()}`;
    this.marks.opened(id, show, opener, preview);
    try { this.command({ action: 'open', id, url, space }); } catch (error) { this.marks.closed(id); throw error; }
    return id;
  }

  /** Loads `url` (a checked address) in tab `id` of `space`; a tab without a page gets one. */
  private load(id: string, url: string, space: string): void {
    const tab = this.tabs.get(id) ?? this.create(id, space, this.marks.opener(id)?.agentId);
    tab.error = undefined;
    void tab.view.webContents.loadURL(url).catch(() => {}); // did-fail-load publishes the visible failure
    this.publish();
  }

  /** The page menu's Open link in new tab: a background tab (it takes no selection). */
  private openLink(url: string, space: string): void { try { this.openTab(url, space, false); } catch { /* the space is full */ } }

  /** The app quits: every page closes, so no host window keeps the quit from ending; the file keeps what it holds. */
  dispose(): void {
    this.ended = true;
    this.chrome.history.flush();
    this.saved.save(this.addresses());
    for (const [id, tab] of [...this.tabs]) { this.discards.shown(id); this.chrome.closed(id); this.rules.closed(id); this.drop(id, tab); }
  }

  /** The window went: the pages agents use stay on the host; the others wait as entries (a new window shows them, they load when shown or used). */
  private windowGone(): void {
    const working = new Set([...this.tabs.keys()].filter((id) => this.host.working(id) || Boolean(this.watched?.(id)))); // a watched page keeps its state
    this.saved.park(this.addresses(), working);
    this.owner = null; this.slots.clear();
    for (const [id, tab] of [...this.tabs]) {
      if (working.has(id) && !tab.view.webContents.isDestroyed()) {
        this.host.take(id, tab.view); // the tab the person looked at, too, when an agent was using it
        this.discards.hidden(id); // out of sight now: the memory saver's time runs
        continue;
      }
      this.rules.closed(id); this.chrome.closed(id); this.discards.shown(id);
      this.drop(id, tab);
    }
  }
}
