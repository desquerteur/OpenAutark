// BrowserService against a fake Playwright: a persistent profile per agent, steps that answer with a change list,
// error translation, stored secrets fetched at fill time, workspace-only uploads, password fields masked, new tabs,
// the vault reads (a field by ref, a 2FA setup key), idle close and shutdown.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService, type LaunchOptions } from '../../../src/runtime/browser/service.ts';
import type { ContextLike, DownloadLike, LocatorLike, PageLike } from '../../../src/runtime/browser/page.ts';
import { normaliseUrl } from '../../../src/runtime/browser/page.ts';
import { channelCandidates, detectChannel } from '../../../src/runtime/browser/channel.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';

class FakeLocator implements LocatorLike {
  readonly page: FakePage;
  readonly selector: string;
  constructor(page: FakePage, selector: string) { this.page = page; this.selector = selector; }
  private act(name: string, value?: unknown) { this.page.actions.push({ selector: this.selector, name, value }); return this.page.onAction(this.selector, name, value); }
  async click(options?: { button?: string }) { await this.act(options?.button === 'right' ? 'right_click' : 'click'); }
  async dblclick() { await this.act('dblclick'); }
  async fill(value: string) { await this.act('fill', value); }
  async pressSequentially(text: string) { await this.act('type', text); }
  async press(key: string) { await this.act('press', key); }
  async selectOption(values: string[]) { await this.act('select', values); return values; }
  async check() { await this.act('check'); }
  async uncheck() { await this.act('uncheck'); }
  async hover() { await this.act('hover'); }
  async scrollIntoViewIfNeeded() { await this.act('scroll'); }
  async setInputFiles(files: string[]) { await this.act('upload', files); }
  async innerText() { return this.page.bodyText; }
  async inputValue() { return this.page.fields[this.selector] ?? ''; }
  async getAttribute() { return 'text'; }
  first() { return this; }
  nth(index: number) { return new FakeLocator(this.page, `${this.selector} >> nth=${index}`); }
}

class FakePage implements PageLike {
  urlValue = 'about:blank';
  titleValue = '';
  snapshot = '- document';
  bodyText = 'Hello   \n\n\n\nWorld';
  closed = false;
  passwords: string[] = [];
  links: string[] = [];
  fields: Record<string, string> = {};
  actions: Array<{ selector: string; name: string; value?: unknown }> = [];
  onAction: (selector: string, name: string, value?: unknown) => Promise<void> | void = () => {};
  readonly context: FakeContext;
  constructor(context: FakeContext) { this.context = context; }
  url() { return this.urlValue; }
  async title() { return this.titleValue; }
  async goto(url: string) { this.urlValue = url; this.titleValue = 'Example'; this.snapshot = '- heading "Example" [ref=e1]\n- button "Send" [ref=e2]'; }
  async goBack() {} async goForward() {} async reload() {}
  async ariaSnapshot() { return this.snapshot; }
  locator(selector: string) { return new FakeLocator(this, selector); }
  getByRole(role: string, options?: { name?: string }) { return new FakeLocator(this, `role=${role}${options?.name ? `[name="${options.name}"]` : ''}`); }
  getByText(text: string) { return new FakeLocator(this, `text=${text}`); }
  getByLabel(text: string) { return new FakeLocator(this, `label=${text}`); }
  getByPlaceholder(text: string) { return new FakeLocator(this, `placeholder=${text}`); }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff]); }
  async waitForLoadState() {}
  async bringToFront() {}
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  async evaluate(expression: string) { return expression.includes('type=password') ? this.passwords : expression.includes('otpauth') ? this.links : undefined; }
  keyboard = { press: async (key: string) => { this.actions.push({ selector: 'keyboard', name: 'press', value: key }); } };
  mouse = { wheel: async (_x: number, y: number) => { this.actions.push({ selector: 'mouse', name: 'wheel', value: y }); } };
  downloads: Array<(download: DownloadLike) => void> = [];
  on(_event: 'download', listener: (download: DownloadLike) => void) { this.downloads.push(listener); }
}

class FakeContext implements ContextLike {
  list: FakePage[] = [];
  closed = false;
  closeListeners: Array<() => void> = [];
  pageListeners: Array<(page: PageLike) => void> = [];
  timeout = 0;
  constructor() { this.list.push(new FakePage(this)); }
  pages() { return this.list; }
  async newPage() { const page = new FakePage(this); this.list.push(page); this.pageListeners.forEach((fn) => fn(page)); return page; }
  async close() { this.closed = true; this.closeListeners.forEach((fn) => fn()); }
  on(event: 'close' | 'page', listener: never) {
    if (event === 'close') this.closeListeners.push(listener as () => void);
    else this.pageListeners.push(listener as (page: PageLike) => void);
  }
  setDefaultTimeout(ms: number) { this.timeout = ms; }
}

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function setup(options: { idleMs?: number } = {}) {
  const launches: Array<{ dir: string; options: LaunchOptions; context: FakeContext }> = [];
  const data = mkdtempSync(path.join(os.tmpdir(), 'wf-browser-'));
  roots.push(data);
  const workspace = path.join(data, 'work');
  const browser = new BrowserService({
    paths: { data, workspace }, log: new MemoryLogger(), channel: () => 'msedge', settleMs: 0, idleMs: options.idleMs,
    launcher: async (dir, launchOptions) => { const context = new FakeContext(); launches.push({ dir, options: launchOptions, context }); return context; },
  });
  return { browser, launches, data, workspace };
}

test('one persistent Edge/Chrome profile per agent, launched once and reused', async () => {
  const { browser, launches, data } = setup();
  const state = await browser.open('ag_1', { url: 'example.com' });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].dir, path.join(data, 'browser-profiles', 'ag_1'));
  assert.deepEqual(launches[0].options, {
    channel: 'msedge', headless: false, viewport: null, acceptDownloads: true,
    args: ['--no-first-run', '--no-default-browser-check', '--window-position=-32000,-32000', '--window-size=1280,860'],
  });
  assert.equal(launches[0].context.timeout, 10_000);
  assert.deepEqual({ tab: state.tab, url: state.url, title: state.title }, { tab: 't1', url: 'https://example.com/', title: 'Example' });
  assert.match(state.snapshot, /button "Send" \[ref=e2\]/);
  await browser.snapshot('ag_1');
  await browser.open('ag_2', { url: 'https://other.test/' });
  assert.equal(launches.length, 2); // a separate profile for another agent
  await browser.close();
  assert.equal(launches.every((launch) => launch.context.closed), true);
  assert.equal(browser.isOpen(), false);
});

test('steps answer with a change list and whether the page changed; a failing step stops the batch with one sentence', async () => {
  const { browser, launches } = setup();
  await browser.open('ag_1', { url: 'https://example.com' });
  const page = launches[0].context.list[0];
  page.onAction = (selector, name) => { if (selector === 'aria-ref=e2' && name === 'click') page.snapshot = '- status "Sent" [ref=e3]'; };
  const sent = await browser.batch('ag_1', { steps: [{ action: 'click', target: { ref: 'e2' } }] });
  assert.deepEqual([sent.done, sent.total, sent.changed, sent.urlChanged], [1, 1, true, false]);
  assert.match(sent.snapshot, /Sent/);
  const same = await browser.batch('ag_1', { steps: [{ action: 'hover', target: { role: 'button', name: 'Send' } }, { action: 'press', key: 'Enter' }] });
  assert.deepEqual([same.done, same.changed], [2, false]);
  assert.equal(page.actions[1].selector, 'role=button[name="Send"]');
  assert.deepEqual(page.actions[2], { selector: 'keyboard', name: 'press', value: 'Enter' });

  page.onAction = () => { throw new Error('locator.click: Error: strict mode violation: getByText(\'Save\') resolved to 3 elements:\n 1) <button>'); };
  const strict = await browser.batch('ag_1', { steps: [{ action: 'click', target: { text: 'Save' } }, { action: 'press', key: 'Enter' }] });
  assert.equal(strict.done, 0);
  assert.match(strict.failure!, /^3 elements match "Save"/);
  page.onAction = () => { throw new Error('locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator\n  - element is not visible'); };
  assert.match((await browser.batch('ag_1', { steps: [{ action: 'fill', target: { label: 'Email' }, value: 'x' }] })).failure!, /it is not visible/);
  assert.match((await browser.batch('ag_1', { steps: [{ action: 'click' }] })).failure!, /needs a target element/);
  assert.match((await browser.batch('ag_1', { steps: [{ action: 'click', target: { role: 'banana' } }] })).failure!, /Unknown ARIA role/);
  await assert.rejects(browser.batch('ag_1', { steps: [] }), /1 to 20 steps/);
});

test('a stored secret is fetched for the page host at fill time; uploads stay in the workspace', async () => {
  const { browser, launches, workspace } = setup();
  await browser.open('ag_1', { url: 'https://accounts.example.com/login' });
  const page = launches[0].context.list[0];
  const asked: Array<[string, string]> = [];
  const result = await browser.batch('ag_1', {
    steps: [{ action: 'fill', target: { label: 'Password' }, secretId: 'pw_1' }], secret: async (id, host) => { asked.push([id, host]); return 'hunter2-very-secret'; },
  });
  assert.deepEqual(asked, [['pw_1', 'accounts.example.com']]);
  assert.equal(page.actions[0].value, 'hunter2-very-secret');
  assert.equal(JSON.stringify(result).includes('hunter2'), false);
  assert.match((await browser.batch('ag_1', { steps: [{ action: 'click', target: { ref: 'e1' }, secretId: 'pw_1' }], secret: async () => 'x' })).failure!, /used with fill or type/);
  await browser.batch('ag_1', { steps: [{ action: 'upload', target: { ref: 'e4' }, files: ['videos/clip.mp4'] }] });
  assert.deepEqual(page.actions.at(-1)?.value, [path.join(workspace, 'videos', 'clip.mp4')]);
  const outside = await browser.batch('ag_1', { steps: [{ action: 'upload', target: { ref: 'e4' }, files: ['../secrets.txt'] }] });
  assert.match(outside.failure!, /outside the workspace/);
  await browser.close();
});

test('password field values never show in a snapshot', async () => {
  const { browser, launches } = setup();
  await browser.open('ag_1', { url: 'https://shop.example/login' });
  const page = launches[0].context.list[0];
  page.passwords = ['correct horse'];
  page.snapshot = '- textbox "Password" [ref=e5]: correct horse\n- text: correct horse is a famous example';
  const text = (await browser.snapshot('ag_1')).snapshot;
  assert.match(text, /textbox "Password" \[ref=e5\]: •••• \(password field\)/);
  assert.match(text, /- text: correct horse is a famous example/, 'only field lines are masked');
  await browser.close();
});

test('a click that opens a new tab is followed; tabs can be listed and closed; text is extracted; a human check is a fact', async () => {
  const { browser, launches } = setup();
  await browser.open('ag_1', { url: 'https://example.com' });
  const context = launches[0].context;
  const page = context.list[0];
  page.onAction = async () => { const popup = await context.newPage(); popup.urlValue = 'https://docs.example.com/'; popup.titleValue = 'Docs'; popup.snapshot = '- heading "Docs"'; };
  const result = await browser.batch('ag_1', { steps: [{ action: 'click', target: { ref: 'e2' } }] });
  assert.deepEqual([result.tab, result.url, result.changed, result.newTab], ['t2', 'https://docs.example.com/', true, true]);
  const listed = await browser.tabs('ag_1');
  assert.deepEqual(listed.tabs.map((tab) => [tab.tab, tab.active]), [['t1', false], ['t2', true]]);
  const closed = await browser.tabs('ag_1', { close: 't2' });
  assert.deepEqual(closed.tabs.map((tab) => tab.tab), ['t1']);
  assert.equal((await browser.extract('ag_1')).text, 'Hello\n\nWorld');
  await assert.rejects(browser.tabs('ag_1', { activate: 't9' }), /No open tab t9/);
  page.snapshot = '- heading "Verify you are human"';
  assert.equal((await browser.snapshot('ag_1')).humanCheck, true);
  await browser.close();
});

test('the vault reads: a field\'s value by ref and the 2FA setup key a page shows', async () => {
  const { browser, launches } = setup();
  await browser.open('ag_1', { url: 'https://dash.example.com/keys' });
  const page = launches[0].context.list[0];
  page.fields['aria-ref=e7'] = 'sk_live_abcdef123456';
  assert.deepEqual(await browser.fieldValue('ag_1', { ref: 'e7' }), { host: 'dash.example.com', value: 'sk_live_abcdef123456', password: false });
  page.links = ['otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example'];
  const keys = await browser.setupKeys('ag_1');
  assert.equal(keys.host, 'dash.example.com');
  assert.equal(keys.keys.length, 1);
  assert.equal(keys.keys[0]!.base32, 'JBSWY3DPEHPK3PXP');
  await browser.close();
});

test('shutdown while a browser is still starting closes it too', async () => {
  const contexts: FakeContext[] = [];
  const data = mkdtempSync(path.join(os.tmpdir(), 'wf-browser-'));
  roots.push(data);
  const browser = new BrowserService({
    paths: { data, workspace: path.join(data, 'work') }, log: new MemoryLogger(), channel: () => 'chrome', settleMs: 0,
    launcher: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); const context = new FakeContext(); contexts.push(context); return context; },
  });
  const opening = browser.open('ag_1', { url: 'https://example.com' }).catch(() => undefined);
  await browser.close();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, true);
  await opening;
});

test('an idle browser is closed after the idle time', async () => {
  const { browser, launches } = setup({ idleMs: 25 });
  await browser.open('ag_1', { url: 'https://example.com' });
  assert.equal(browser.isOpen('ag_1'), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(launches[0].context.closed, true);
  assert.equal(browser.isOpen('ag_1'), false);
});

test('URLs are normalised to http(s) and the installed browser channel is detected', () => {
  assert.equal(normaliseUrl('example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(normaliseUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(normaliseUrl('about:blank'), 'about:blank');
  assert.throws(() => normaliseUrl('file:///C:/Windows/win.ini'), /Only http and https/);
  assert.throws(() => normaliseUrl('javascript:alert(1)'), /Only http and https/);
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' };
  assert.equal(channelCandidates('msedge', { platform: 'win32', env, exists: () => false })[2], 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  const only = (file: string) => (candidate: string) => candidate === file;
  assert.equal(detectChannel({ platform: 'win32', env, exists: only('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') }), 'msedge');
  assert.equal(detectChannel({ platform: 'win32', env, exists: only('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe') }), 'chrome');
  assert.throws(() => detectChannel({ platform: 'linux', env: {}, exists: () => false }), /No Google Chrome or Microsoft Edge/);
});
