// The Chrome-like parts of a personal tab beside its lifetime in workspace-browser.ts: its sound (audible, muted by the
// person), zoom (Chrome's steps, kept per site – workspace-tab-memory.ts SiteZoom – and put back on every page of that
// site), find in page (findInPage; the shown match and the count), DevTools in a window of their own, the keyboard back
// to the page ('focus'), the history of the pages it showed (workspace-history.ts – nothing with a credential or a token,
// and not what an agent browses in a tab of its own: this is the person's history) and the browser shortcuts pressed
// inside the page (shared/api/workspace-browser-keys.ts): main does reload, back/forward, stop, zoom, DevTools and reopen
// itself; the app's go to the app, with the keyboard where a field of the app takes it, and the app's own shortcuts are
// passed on as before. A site's prefers-color-scheme follows the app's theme (colorScheme).
// Owns: that per-tab state, these commands, the page's shortcuts and its color scheme. Never: reads page content or runs
// script in a page.

import type { BrowserWindow, Event, Input, WebContents } from 'electron';
import { WORKSPACE_BROWSER, type BrowserKeyAction, type HistoryEntry, type WorkspaceBrowserCommand, type WorkspaceBrowserPage } from '../shared/api/workspace-browser.ts';
import { pageKey, type MainKeyAction } from '../shared/api/workspace-browser-keys.ts';
import { BrowserHistory } from './workspace-history.ts';
import { SiteZoom, zoomStep } from './workspace-tab-memory.ts';

interface ChromeState { find?: { active: number; matches: number }; findText?: string }

export interface ChromeHost {
  window(): BrowserWindow | null;
  publish(): void;
  /** A shortcut main acts on with the tab's own commands. */
  mainKey(id: string, action: Extract<MainKeyAction, 'reload' | 'back' | 'forward' | 'stop' | 'reopen'>): void;
  /** An agent opened this tab (what it browses there stays out of the person's history). */
  agentTab(id: string): boolean;
}

/** The commands this part answers (the rest is the tab's lifetime). */
export type ChromeCommand = Extract<WorkspaceBrowserCommand, { action: 'focus' | 'find' | 'find-stop' | 'zoom' | 'mute' | 'devtools' }>;
export const CHROME_ACTIONS: ReadonlySet<string> = new Set(['focus', 'find', 'find-stop', 'zoom', 'mute', 'devtools']);

/** The app's fields take these, so the keyboard goes there; a tab switch or a close leaves it where it is (the next page keeps it). */
const TAKES_KEYBOARD: ReadonlySet<BrowserKeyAction> = new Set<BrowserKeyAction>(['new-tab', 'address', 'find', 'history']);

/** A title that is only the address (Electron's getTitle() of an untitled page) is no title. */
function titleOf(contents: WebContents): string {
  const title = contents.getTitle();
  const url = contents.getURL();
  try { const parsed = new URL(url); return [url, parsed.host, `${parsed.host}${parsed.pathname}`].includes(title) ? '' : title; } catch { return title; }
}

/** The page's prefers-color-scheme as the app's theme (`dark`), through the DevTools Emulation domain and nothing else. */
export function colorScheme(contents: WebContents, dark: boolean): void {
  if (contents.isDestroyed()) return;
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    void contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }).catch(() => {});
  } catch { /* DevTools hold the page: it keeps the system's scheme */ }
}

export class TabChrome {
  readonly history: BrowserHistory;
  private readonly zoom: SiteZoom;
  private readonly states = new Map<string, ChromeState>();
  private readonly host: ChromeHost;
  private readonly mac = process.platform === 'darwin';

  constructor(host: ChromeHost, options: { historyFile?: string; zoomFile?: string } = {}) {
    this.host = host;
    this.history = new BrowserHistory({ file: options.historyFile });
    this.zoom = new SiteZoom({ file: options.zoomFile });
  }

  /** Wires a new tab (before the browser's own listeners, so their publish carries this state). */
  attach(id: string, contents: WebContents): void {
    const state: ChromeState = {};
    this.states.set(id, state);
    contents.on('did-navigate', (_event, url) => {
      if (state.find) state.find = { active: 0, matches: 0 }; // another page: the old count is gone
      if (!this.host.agentTab(id)) this.history.visit(url);
      const percent = this.zoom.percent(url);
      if (Math.round(contents.getZoomFactor() * 100) !== percent) contents.setZoomFactor(percent / 100);
    });
    contents.on('did-navigate-in-page', (_event, url, main) => { if (main && !this.host.agentTab(id)) this.history.visit(url, titleOf(contents)); });
    contents.on('page-title-updated', () => this.history.title(contents.getURL(), titleOf(contents)));
    contents.on('audio-state-changed', () => this.host.publish());
    contents.on('found-in-page', (_event, result) => {
      state.find = { active: result.activeMatchOrdinal ?? 0, matches: result.matches ?? 0 };
      this.host.publish();
    });
    contents.on('before-input-event', (event, input) => this.key(id, contents, event, input));
  }

  closed(id: string): void { this.states.delete(id); }

  /** The tab's Chrome fields for its page entry. */
  extras(id: string, contents: WebContents): Partial<WorkspaceBrowserPage> {
    const find = this.states.get(id)?.find;
    const percent = Math.round(contents.getZoomFactor() * 100);
    return {
      ...(contents.isCurrentlyAudible() ? { audible: true } : {}),
      ...(contents.isAudioMuted() ? { muted: true } : {}),
      ...(percent !== 100 ? { zoom: percent } : {}),
      ...(find ? { find: { ...find } } : {}),
    };
  }

  /** History for the app (newest first) or Clear history. */
  historyRequest(request: unknown): HistoryEntry[] {
    const value = (request ?? {}) as Record<string, unknown>;
    if (value.clear === true) { this.history.clear(); return []; }
    return this.history.search(typeof value.query === 'string' ? value.query.slice(0, 200) : '', typeof value.limit === 'number' ? value.limit : 50);
  }

  command(id: string, contents: WebContents, command: ChromeCommand): void {
    const state = this.states.get(id) ?? {};
    if (command.action === 'focus') contents.focus();
    else if (command.action === 'devtools') {
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      else contents.openDevTools({ mode: 'detach', activate: true });
    } else if (command.action === 'mute') contents.setAudioMuted(!contents.isAudioMuted());
    else if (command.action === 'zoom') {
      const next = zoomStep(Math.round(contents.getZoomFactor() * 100), command.step);
      contents.setZoomFactor(next / 100);
      this.zoom.set(contents.getURL(), next);
    } else if (command.action === 'find') {
      const text = command.text.slice(0, 500);
      if (!text) { contents.stopFindInPage('clearSelection'); state.find = { active: 0, matches: 0 }; state.findText = ''; return; }
      const again = Boolean(command.next) && state.findText === text;
      state.findText = text;
      state.find ??= { active: 0, matches: 0 };
      contents.findInPage(text, { forward: command.forward !== false, findNext: !again });
    } else {
      contents.stopFindInPage('clearSelection');
      state.find = undefined; state.findText = undefined;
    }
  }

  private key(id: string, contents: WebContents, event: Event, input: Input): void {
    const key = pageKey(input, this.mac, contents.isLoading());
    if (!key) return;
    event.preventDefault();
    const window = this.host.window();
    if ('app' in key) {
      if (!window || window.isDestroyed()) return;
      if (TAKES_KEYBOARD.has(key.app)) window.webContents.focus();
      window.webContents.send(WORKSPACE_BROWSER.key, { id, action: key.app });
      return;
    }
    if ('host' in key) { // the app's own shortcuts, as if pressed in the app
      if (!window) return;
      window.webContents.focus();
      const modifiers: Array<'meta' | 'control'> = input.meta ? ['meta'] : ['control'];
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: input.key, modifiers });
      return;
    }
    const action = key.main;
    if (action === 'devtools') this.command(id, contents, { action, id });
    else if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') {
      this.command(id, contents, { action: 'zoom', id, step: action === 'zoom-in' ? 1 : action === 'zoom-out' ? -1 : 0 });
      this.host.publish();
    } else if (action === 'hard-reload') contents.reloadIgnoringCache();
    else this.host.mainKey(id, action);
  }
}
