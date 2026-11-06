// The surfaces' browser shortcuts, Chrome's keys (shared/api/workspace-browser-keys.ts): Ctrl+T a new tab, Ctrl+W closes
// the shown tab, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+1…9 choose a tab in the strip's order, Ctrl+L the address field (the
// path field on a file or folder tab, a new tab on another app tab), Ctrl+F the find field of a website tab, Ctrl+H
// history, Ctrl+Shift+T reopens a closed tab; a website tab's own keys (reload, back, zoom …) go to main as commands. Each
// acts on one space: pressed in the app, the surface the keyboard is in (`data-space` of its .workspace-pane) – not in an
// agent's browser taken over, but in the picture of a page on another PC (B-076, `data-app-keys`) as in a page here –;
// pressed inside a page, that page's space, from main (the bridge's onKey) – like the page menu's "Send page to chat".
// Owns: that dispatch. Never: keys outside the surfaces (lib/hotkeys.ts has the app's own) or page content.

import { GLOBAL_SPACE, type BrowserKeyAction, type WorkspaceBrowserCommand } from '../../shared/api/workspace-browser.ts';
import { pageKey, type MainKeyAction } from '../../shared/api/workspace-browser-keys.ts';
import { bridge, os } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { isAppTab, tabFor } from './browser-model.ts';
import { addPage, addressFocus, askFor, browserPages, closePage, command, historyAsk, openFind, pathFocus, reopenTab, selectPage, shownEntry, tabsOf } from './pages.ts';
import { sendPageToChat } from './send-page.ts';

/** Runs a shortcut in `space`; false when it does nothing here (Ctrl+F without a website tab keeps its other meaning). */
function run(shortcut: Exclude<BrowserKeyAction, 'send-page'>, space: string): boolean {
  const shown = shownEntry(space);
  if (shortcut === 'new-tab') addPage(space);
  else if (shortcut === 'find') return openFind(space);
  else if (shortcut === 'history') askFor(historyAsk, space);
  else if (shortcut === 'address') {
    if (shown?.kind === 'file' || shown?.kind === 'folder') askFor(pathFocus, space);
    else if (shown?.kind === 'remote') askFor(addressFocus, space); // its own address row (RemoteWebTab), as in a local website tab
    else if (isAppTab(shown)) addPage(space);
    else askFor(addressFocus, space);
  }
  else if (shortcut === 'close-tab') { if (shown) void closePage(shown.id, space).catch((error) => toastError(error)); }
  else {
    const next = tabFor(shortcut, tabsOf(space).map((page) => page.id), shown?.id);
    if (next) selectPage(next, space);
  }
  return true;
}

/** A website tab's own key pressed in a surface's strip or address row (F12 in the app's parts stays the app's); false when it does nothing here. */
function runMain(action: MainKeyAction, space: string): boolean {
  if (action === 'reopen') { void reopenTab(space); return true; }
  const shown = shownEntry(space);
  if (shown?.kind !== 'website' || action === 'devtools' || action === 'hard-reload') return false;
  const next: WorkspaceBrowserCommand = action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset'
    ? { action: 'zoom', id: shown.id, step: action === 'zoom-in' ? 1 : action === 'zoom-out' ? -1 : 0 }
    : { action, id: shown.id };
  void command(next);
  return true;
}

/** The page menu's "Send page to chat" names its page by address: the shown tab of `space` when it is that page. */
function sendPage(url: string | undefined, space: string): void {
  const shown = shownEntry(space);
  const pages = browserPages.peek();
  const id = shown?.kind === 'website' && (!url || pages.some((page) => page.id === shown.id && page.url === url)) ? shown.id : pages.find((page) => page.url === url)?.id;
  if (id) void sendPageToChat(id).catch((error) => toastError(error));
}

let watching = false;

/** Starts both paths (idempotent; the desktop app's surfaces). */
export function watchBrowserKeys(): void {
  const native = bridge?.workspaceBrowser;
  if (watching || !native) return;
  watching = true;
  native.onKey?.((event) => {
    const space = browserPages.peek().find((page) => page.id === event.id)?.space ?? GLOBAL_SPACE;
    if (event.action === 'send-page') sendPage(event.url, space);
    else run(event.action, space);
  });
  window.addEventListener('keydown', (event) => { // capture: before lib/hotkeys.ts, so in a surface Ctrl+Shift+T reopens a tab as in Chrome (elsewhere it stays Quick task)
    const target = event.target as HTMLElement | null;
    const surface = target?.closest?.('.workspace-pane') as HTMLElement | null | undefined;
    if (event.defaultPrevented || event.isComposing || !target || !surface || target.closest('.browser-touch:not([data-app-keys])')) return;
    const space = surface.dataset.space ?? GLOBAL_SPACE;
    const key = pageKey({ type: 'keyDown', key: event.key, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey }, os === 'mac', false);
    if (key && ('app' in key ? run(key.app, space) : 'main' in key && runMain(key.main, space))) event.preventDefault();
  }, true);
}
