// Real Electron regression (the global pane: a tab strip with "+", under it the address row – Back, Forward, Reload, the
// address, the menu with All tabs): the person's website tabs survive an app restart – same order, the chosen
// tab selected again, the page loading only when shown; a blank tab keeps Back / Forward / Reload in place (disabled);
// an agent's browser.show (the demo engine's scripted tool call) opens its page as a tab of that chat's area above the
// messages, opens the area and shows it at once; the global pane stays as it was, both pages on their slots. That tab is
// the agent's preview (title in italics): its next page takes it over, a double-click keeps it, and the page after that
// opens a new preview tab. Runs centrally with the other window tests (npm run test:ui); a local fixture server, a temp
// profile, no real sites.
// Owns: these user paths. Never: touches the person's profile or external websites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('website tabs come back after a restart; an agent\'s browser.show opens a tab at once', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-tabs-'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const name = { '/two': 'Second', '/three': 'Third' }[req.url] ?? 'First';
    res.end(`<title>${name} site</title><body style="font:20px system-ui;padding:24px"><h1>${name}</h1><p>Price 42 EUR</p></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const launch = () => electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
  });
  let app = await launch();
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = [];
  const watch = (target) => target.on('pageerror', (error) => errors.push(error.message));
  watch(page);
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // past the first-run layer (first-run-window covers it)
  rpc.close();
  rpc = undefined;
  // A fresh profile starts with the browser closed; the person opens it (the choice is kept).
  const cell = page.locator('.frame-workspace-cell button');
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click();
  await page.locator('.global-pane .browser-bar').waitFor();

  /** The tab shown in a surface ('.global-pane' or '.chat-area'), and its list. */
  const shownIn = (where, expected, timeout = 15_000) => page.waitForFunction(([scope, want]) => document.querySelector(`${scope} .browser-strip-tab.selected .browser-strip-title`)?.textContent === want, [where, expected], { timeout });
  const tabsMenu = () => page.getByRole('menu', { name: 'Tabs' });
  const allTabs = async (where) => { // the surface's menu › All tabs
    await page.locator(where).getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menuitem', { name: 'All tabs' }).click();
    await tabsMenu().waitFor();
  };
  const tabTitles = async (where = '.global-pane') => {
    await allTabs(where);
    const titles = (await tabsMenu().locator('.browser-tab-row .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
    const current = (await tabsMenu().locator('[role="menuitem"][aria-current="true"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
    await page.keyboard.press('Escape');
    await tabsMenu().waitFor({ state: 'detached' });
    return { titles, current: current[0] };
  };
  const choose = async (title) => {
    await allTabs('.global-pane');
    await tabsMenu().getByRole('menuitem', { name: new RegExp(title) }).click();
  };
  const bar = page.locator('.global-pane .browser-bar');
  const open = async (url, title) => {
    await page.locator('.global-pane .browser-strip').getByRole('button', { name: 'New tab', exact: true }).click();
    const field = bar.getByRole('textbox', { name: 'Website address' });
    await field.waitFor();
    for (const name of ['Back', 'Forward', 'Reload']) assert.equal(await bar.getByRole('button', { name, exact: true }).isDisabled(), true, `${name} stays in its place on a blank tab, disabled`);
    await field.fill(url);
    await field.press('Enter');
    await shownIn('.global-pane', title);
    assert.equal(await bar.getByText(title).count(), 0, 'the page\'s title lives on its tab, not beside the address');
  };
  await open(`${address}/one?token=secret-value`, 'First site');
  await open(`${address}/two`, 'Second site');
  await choose('First site');
  await shownIn('.global-pane', 'First site');
  await page.waitForTimeout(500); // the tab file is written on the change

  const saved = JSON.parse(await readFile(path.join(profile, 'side-tabs.json'), 'utf8'));
  assert.deepEqual(saved.spaces.global.tabs.map((tab) => tab.url), [`${address}/one`, `${address}/two`], 'order and addresses, without the token');
  assert.ok(!JSON.stringify(saved).includes('First site'), 'no titles or page content in the file');

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  watch(page);
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.locator('.global-pane .browser-bar').waitFor(); // the browser stays open after the restart
  await shownIn('.global-pane', 'First site', 20_000); // it loads because it is the chosen tab
  const after = await tabTitles();
  assert.equal(after.titles.length, 2, `two tabs came back: ${after.titles.join(', ')}`);
  assert.equal(after.current, 'First site', 'the chosen tab is selected again');
  const loaded = await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(prefix)).map((contents) => contents.getURL()), address);
  assert.deepEqual(loaded, [`${address}/one`], 'only the shown tab loaded; the other waits');

  // The chat's agent shows a page: it opens as a tab of the chat's area, the area opens and shows it at once.
  const again = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(again.port, again.token, 'cli');
  const chat = (await rpc.call('chats.list')).find((entry) => !entry.settings?.system) ?? (await rpc.call('chats.list'))[0];
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const composer = page.locator('textarea.composer-input');
  await composer.waitFor();
  assert.equal(await page.locator('.chat-area').count(), 0, 'the area starts closed');
  const third = `${address}/three`;
  const loaded3 = () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(url)), third);
  await composer.fill(`[[tool:browser.show {"url":"${third}"}]]`);
  await page.locator('button.send-button').click();
  await shownIn('.chat-area', 'Third site', 30_000);
  assert.equal(await loaded3(), true, 'the page is shown');
  assert.equal(await page.locator('.chat-header [data-cell="browser"] button').getAttribute('aria-pressed'), 'true', 'the chat\'s cell shows its area open');
  const shown = await tabTitles('.chat-area');
  assert.deepEqual(shown.titles, ['Third site'], `the chat's own tab: ${shown.titles.join(', ')}`);
  assert.equal(shown.current, 'Third site');
  // the global pane beside it stays as it was, and both pages lie on their slots at once (one shown tab per space)
  await shownIn('.global-pane', 'First site');
  const globalTabs = await tabTitles('.global-pane');
  assert.equal(globalTabs.titles.length, 2, `the global tabs are as they were: ${globalTabs.titles.join(', ')}`); // the second, not loaded since the restart, is named by its host
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => view.constructor.name === 'WebContentsView' && view.getVisible()).map((view) => view.webContents.getURL()));
  let both = [];
  for (let i = 0; i < 60 && both.length !== 2; i += 1) { both = await visible(); if (both.length !== 2) await page.waitForTimeout(100); }
  assert.deepEqual(both.map((url) => url.replace(address, '')).sort(), ['/one', '/three'], `the global page and the chat's page are both shown: ${both.join(', ')}`);

  // That tab is the agent's preview: its next page takes it over, a double-click keeps it, the page after that opens a new one.
  const areaTabs = page.locator('.chat-area .browser-strip-tab');
  const previews = page.locator('.chat-area .browser-strip-tab.transient');
  assert.equal(await previews.count(), 1, 'the agent\'s tab is its preview (title in italics)');
  assert.match(await areaTabs.first().locator('[role=tab]').getAttribute('title'), /Opened by .+\nPreview – the agent's next page replaces it; double-click to keep$/);
  const show = async (url, title) => {
    await composer.fill(`[[tool:browser.show {"url":"${url}"}]]`);
    await page.locator('button.send-button').click();
    await shownIn('.chat-area', title, 30_000);
  };
  await show(`${address}/two`, 'Second site');
  assert.equal(await areaTabs.count(), 1, 'the next page took the preview tab over');
  assert.equal(await previews.count(), 1, 'still a preview');
  await areaTabs.first().dblclick();
  await previews.first().waitFor({ state: 'detached' });
  await show(third, 'Third site');
  assert.equal(await areaTabs.count(), 2, 'the kept tab stays; the next page is a new preview tab');
  assert.equal((await previews.locator('.browser-strip-title').textContent())?.trim(), 'Third site');
  assert.equal(await page.locator('.chat-area .browser-strip-tab:not(.transient) .browser-strip-title').textContent(), 'Second site');

  assert.deepEqual(errors, [], 'no renderer errors');
});
