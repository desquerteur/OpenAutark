// The native right-click menu of a personal tab's page (main/workspace-page-menu.ts): Back, Forward,
// Reload always; Open link in new tab and Copy link only on an http(s) link; Copy on a selection and
// Paste in a field; Send page to chat (an http(s) page) and Inspect last, groups divided by
// separators; every item does its one thing – Send page to chat tells the app window on the key channel.
// Owns: these assertions. Never: Electron or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPageMenu, pageMenuTemplate, type PageContents } from '../../../src/main/workspace-page-menu.ts';

function fakePage(history = { back: true, forward: false }) {
  const calls: string[] = [];
  let devtools = false;
  const contents: PageContents = {
    navigationHistory: { canGoBack: () => history.back, canGoForward: () => history.forward, goBack: () => calls.push('back'), goForward: () => calls.push('forward') },
    reload: () => calls.push('reload'), copy: () => calls.push('copy'), paste: () => calls.push('paste'),
    isDevToolsOpened: () => devtools,
    openDevTools: (options) => { devtools = true; calls.push(`devtools ${options.mode}`); },
    inspectElement: (x, y) => calls.push(`inspect ${x},${y}`),
  };
  return { contents, calls };
}

const params = (patch: Partial<{ linkURL: string; isEditable: boolean; canCopy: boolean; canPaste: boolean }> = {}) => ({
  linkURL: patch.linkURL ?? '', isEditable: patch.isEditable ?? false, x: 12, y: 34, editFlags: { canCopy: patch.canCopy ?? false, canPaste: patch.canPaste ?? false },
});

function host() {
  const opened: string[] = [];
  const copied: string[] = [];
  return { opened, copied, openLink: (url: string) => opened.push(url), electron: { Menu: { buildFromTemplate: () => { throw new Error('not used'); } }, clipboard: { writeText: (text: string) => copied.push(text) } } };
}

const labels = (items: Array<{ label?: string; type?: string }>) => items.map((item) => item.type === 'separator' ? '-' : item.label);

test('a plain page: navigation, then Inspect', () => {
  const { contents } = fakePage();
  const items = pageMenuTemplate(contents, params(), host());
  assert.deepEqual(labels(items), ['Back', 'Forward', 'Reload', '-', 'Inspect']);
  assert.deepEqual([items[0]!.enabled, items[1]!.enabled], [true, false], 'Back and Forward follow the page history');
});

test('a link adds Open link in new tab and Copy link; only http(s) links count', () => {
  const { contents } = fakePage();
  const h = host();
  const items = pageMenuTemplate(contents, params({ linkURL: 'https://example.test/a?b=1' }), h);
  assert.deepEqual(labels(items), ['Back', 'Forward', 'Reload', '-', 'Open link in new tab', 'Copy link', '-', 'Inspect']);
  (items[4]!.click as () => void)();
  (items[5]!.click as () => void)();
  assert.deepEqual(h.opened, ['https://example.test/a?b=1']);
  assert.deepEqual(h.copied, ['https://example.test/a?b=1']);
  assert.deepEqual(labels(pageMenuTemplate(contents, params({ linkURL: 'javascript:alert(1)' }), h)), ['Back', 'Forward', 'Reload', '-', 'Inspect']);
  assert.deepEqual(labels(pageMenuTemplate(contents, params({ linkURL: 'file:///etc/passwd' }), h)), ['Back', 'Forward', 'Reload', '-', 'Inspect']);
});

test('Copy comes with a selection, Paste with a field (enabled only when the clipboard can paste)', () => {
  const { contents, calls } = fakePage();
  const items = pageMenuTemplate(contents, params({ canCopy: true, isEditable: true, canPaste: false }), host());
  assert.deepEqual(labels(items), ['Back', 'Forward', 'Reload', '-', 'Copy', 'Paste', '-', 'Inspect']);
  assert.equal(items[5]!.enabled, false);
  (items[4]!.click as () => void)();
  assert.deepEqual(calls, ['copy']);
  assert.deepEqual(labels(pageMenuTemplate(contents, params({ canCopy: true }), host())), ['Back', 'Forward', 'Reload', '-', 'Copy', '-', 'Inspect']);
});

test('Back, Forward, Reload and Inspect act on the page; Inspect opens DevTools in their own window once', () => {
  const { contents, calls } = fakePage({ back: true, forward: true });
  const items = pageMenuTemplate(contents, params(), host());
  for (const item of items) (item.click as (() => void) | undefined)?.();
  assert.deepEqual(calls, ['back', 'forward', 'reload', 'devtools detach', 'inspect 12,34']);
  (items.at(-1)!.click as () => void)();
  assert.deepEqual(calls.slice(5), ['inspect 12,34'], 'DevTools already open: only the element is inspected');
});

test('every right click in the page pops the menu up in the app window', () => {
  const { contents } = fakePage();
  const listeners: Array<(event: unknown, menuParams: ReturnType<typeof params>) => void> = [];
  const popped: unknown[] = [];
  const window = { isDestroyed: () => false };
  const page = Object.assign(contents, { on: (name: string, listener: (event: unknown, menuParams: ReturnType<typeof params>) => void) => { if (name === 'context-menu') listeners.push(listener); else assert.equal(name, 'before-input-event'); } });
  const h = host();
  attachPageMenu(page as never, {
    window: () => window as never, openLink: h.openLink,
    electron: { Menu: { buildFromTemplate: (template: unknown[]) => ({ popup: (options: unknown) => popped.push([template.length, options]) }) } as never, clipboard: h.electron.clipboard },
  });
  listeners[0]!({}, params());
  assert.deepEqual(popped, [[5, { window }]]);
  attachPageMenu(page as never, { window: () => null, openLink: h.openLink, electron: h.electron as never });
  listeners[1]!({}, params()); // no window: nothing pops up, nothing throws
  assert.equal(popped.length, 1);
});

test('Send page to chat comes with an http(s) page and tells the app window which page', () => {
  const { contents } = fakePage();
  const sent: string[] = [];
  const h = { ...host(), sendPage: (url: string) => sent.push(url) };
  const items = pageMenuTemplate(contents, { ...params(), pageURL: 'https://site.test/a' }, h);
  assert.deepEqual(labels(items), ['Back', 'Forward', 'Reload', '-', 'Send page to chat', 'Inspect']);
  (items[4]!.click as () => void)();
  assert.deepEqual(sent, ['https://site.test/a']);
  assert.deepEqual(labels(pageMenuTemplate(contents, { ...params(), pageURL: 'about:blank' }, h)), ['Back', 'Forward', 'Reload', '-', 'Inspect']);

  const listeners: Array<(event: unknown, menuParams: unknown) => void> = [];
  const messages: unknown[][] = [];
  let focused = 0;
  const window = { isDestroyed: () => false, webContents: { focus: () => { focused++; }, send: (...args: unknown[]) => messages.push(args) } };
  const page = Object.assign(contents, { on: (_name: string, listener: (event: unknown, menuParams: unknown) => void) => { listeners.push(listener); } });
  let template: Array<{ label?: string; click?: () => void }> = [];
  attachPageMenu(page as never, {
    window: () => window as never, openLink: h.openLink,
    electron: { Menu: { buildFromTemplate: (items: typeof template) => { template = items; return { popup: () => undefined }; } } as never, clipboard: h.electron.clipboard },
  });
  listeners[0]!({}, { ...params(), pageURL: 'https://site.test/b' });
  template.find((item) => item.label === 'Send page to chat')!.click!();
  assert.equal(focused, 1, 'the keyboard goes to the app');
  assert.deepEqual(messages, [['workspace-browser:key', { id: '', action: 'send-page', url: 'https://site.test/b' }]]);
});
