// The page's own right-click menu in a personal tab (owner, 31.10.2026: right-click menus everywhere):
// Back, Forward, Reload; Open link in new tab and Copy link on a link; Copy on a selection; Paste in a
// field; Send page to chat and Inspect. Built natively from the page's context-menu event, so the app
// draws nothing over the page and no menu item is a script in it. A link opens in a background tab
// next to this one. Send page to chat tells the app window (the key channel's 'send-page' with the
// page's address); the app puts the address and a picture of the page into the open chat's message
// field (ui/workspace/send-page.ts). B-078 (D20): Fill login (a submenu of the catalog's logins, the page's site
// first) on an http(s) page and on Ctrl/Cmd+Shift+L – workspace-fill.ts lists and types them.
// Owns: the menu's items and what each does. Never: reads the page beyond the event's link and
// selection flags or opens anything but http(s) links; the only script it starts is Fill login's field finder.

import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions, WebContents } from 'electron';
import { WORKSPACE_BROWSER } from '../shared/api/workspace-browser.ts';
import { fillableUrl, fillItems, fillLogin, fillRpc, loginChoices } from './workspace-fill.ts';

/** What the menu needs from a tab's page (Electron's WebContents has all of it). */
export interface PageContents {
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void };
  reload(): void;
  copy(): void;
  paste(): void;
  isDevToolsOpened(): boolean;
  openDevTools(options: { mode: 'detach'; activate: boolean }): void;
  inspectElement(x: number, y: number): void;
}

export interface PageMenuHost {
  /** The app window the menu opens in. */
  window(): BrowserWindow | null;
  /** Opens `url` in a background tab next to this one. */
  openLink(url: string): void;
  /** Hands the page at `url` to the app's open chat (attachPageMenu sends it to the app window). */
  sendPage?(url: string): void;
  electron: { Menu: Pick<typeof Menu, 'buildFromTemplate'>; clipboard: { writeText(text: string): void } };
}

type MenuParams = Pick<ContextMenuParams, 'linkURL' | 'isEditable' | 'x' | 'y'> & Partial<Pick<ContextMenuParams, 'pageURL'>> & { editFlags: Pick<ContextMenuParams['editFlags'], 'canCopy' | 'canPaste'> };

/** The menu's items for one right click, groups divided by separators; `fill`: the Fill login entry (workspace-fill.ts). */
export function pageMenuTemplate(contents: PageContents, params: MenuParams, host: Pick<PageMenuHost, 'openLink' | 'sendPage' | 'electron'>, fill?: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  const history = contents.navigationHistory;
  const groups: MenuItemConstructorOptions[][] = [[
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Reload', click: () => contents.reload() },
  ]];
  const link = /^https?:\/\//i.test(params.linkURL) ? params.linkURL : '';
  if (link) groups.push([
    { label: 'Open link in new tab', click: () => host.openLink(link) },
    { label: 'Copy link', click: () => host.electron.clipboard.writeText(link) },
  ]);
  const edit: MenuItemConstructorOptions[] = [];
  if (params.editFlags.canCopy) edit.push({ label: 'Copy', click: () => contents.copy() });
  if (params.isEditable) edit.push({ label: 'Paste', enabled: params.editFlags.canPaste, click: () => contents.paste() });
  if (edit.length) groups.push(edit);
  if (fill) groups.push([fill]);
  const page =/^https?:\/\//i.test(params.pageURL ?? '') ? params.pageURL! : '';
  const send = host.sendPage;
  groups.push([...(page && send ? [{ label: 'Send page to chat', click: () => send(page) }] : []), {
    label: 'Inspect',
    click: () => {
      if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: 'detach', activate: true });
      contents.inspectElement(params.x, params.y);
    },
  }]);
  return groups.flatMap((group, index) => (index ? [{ type: 'separator' as const }, ...group] : group));
}

/** A press of Ctrl/Cmd+Shift+L (the Fill login shortcut). */
export function isFillKey(input: { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }, mac = process.platform === 'darwin'): boolean {
  return (input.type === 'keyDown' || input.type === 'rawKeyDown') && input.key.toLowerCase() === 'l' && input.shift && !input.alt && (mac ? input.meta : input.control);
}

/** Shows the menu on every right click in the tab's page; Fill login there and on its shortcut while main's RPC is set. */
export function attachPageMenu(contents: WebContents, host: PageMenuHost): void {
  const pick = (id: string) => { void fillLogin(fillRpc(), contents, id); };
  contents.on('context-menu', (_event, params) => {
    const window = host.window();
    if (!window || window.isDestroyed()) return;
    const sendPage = (url: string) => { // the keyboard to the app, where the message field takes it
      if (window.isDestroyed()) return;
      window.webContents.focus();
      window.webContents.send(WORKSPACE_BROWSER.key, { id: '', action: 'send-page', url });
    };
    const show = (fill?: MenuItemConstructorOptions) => {
      if (!window.isDestroyed()) host.electron.Menu.buildFromTemplate(pageMenuTemplate(contents, params, { ...host, sendPage }, fill)).popup({ window });
    };
    const page = fillableUrl(params.pageURL);
    const link = fillRpc();
    if (!link || !page) { show(); return; }
    void loginChoices(link, page).then((choices) => show(fillItems(choices, pick)));
  });
  contents.on('before-input-event', (event, input) => {
    const link = fillRpc();
    if (!link || !isFillKey(input)) return;
    event.preventDefault();
    const page = fillableUrl(contents.getURL());
    const window = host.window();
    if (!page || !window || window.isDestroyed()) return;
    void loginChoices(link, page).then((choices) => {
      const item = fillItems(choices, pick);
      if (!window.isDestroyed()) host.electron.Menu.buildFromTemplate(Array.isArray(item.submenu) ? item.submenu : [item]).popup({ window });
    });
  });
}
