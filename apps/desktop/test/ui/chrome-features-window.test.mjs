// Real Electron: the browser's Chrome features. History with suggestions under the address field (and Ctrl+H, its file,
// agents' pages stay out of it), Ctrl+Shift+T, Ctrl+Tab and Ctrl+1…9 in the pane and inside a page, All tabs in the menu, zoom kept per site over
// a restart, mute with its mark on the tab, DevTools, Mark a region into the composer (a page; the screen without a saved
// picture), the Activity panel, the media library with its search, and Comment at in the Video panel. Screenshots:
// SCREENSHOTS names the folder. A temp profile, the demo engine, a local fixture server, no real sites.
// Owns: these user paths. Never: touches the person's profile or external websites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Chrome features: history, reopen, keys, zoom, mute, DevTools, Mark a region, Activity, Media, Comment at', { timeout: 480_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-chrome-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const name = decodeURIComponent(req.url.slice(1)) || 'home';
    res.end(`<title>${name} page</title><style>html,body{height:100%;margin:0}body{font:22px system-ui;padding:24px;box-sizing:border-box;background:#2266cc;color:#fff}</style><h1>${name}</h1><p>A local fixture.</p>`);
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
    await page?.screenshot({ path: path.join(out, 'last.png'), timeout: 5000 }).catch(() => {});
    rpc?.close?.();
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });
  let page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  const errors = [];
  const watch = (target) => target.on('pageerror', (error) => errors.push(error.message));
  watch(page);
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const reconnect = async () => {
    rpc?.close?.();
    const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
    rpc = await connect(info.port, info.token, 'cli');
  };
  await reconnect();
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Chrome chat', agentIds: [manager.id] });

  const step = (line) => appendFileSync(path.join(out, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const shot = async (name) => {
    step(`shot ${name}`);
    await page.waitForTimeout(300);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (what, check, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) assert.fail(`waited for ${what}`);
      await sleep(120);
    }
  };
  const strip = () => page.locator('.browser-strip');
  const bar = () => page.locator('.browser-bar');
  const shownTitle = () => page.locator('.browser-strip-tab.selected .browser-strip-title').textContent();
  const waitShown = (title) => page.waitForFunction((expected) => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === expected, title, { timeout: 20_000 });
  const openTab = async (name) => {
    await strip().getByRole('button', { name: 'New tab', exact: true }).click();
    const field = bar().getByRole('textbox', { name: 'Website address' });
    await field.fill(`${address}/${name}`);
    await field.press('Enter');
    await waitShown(`${name} page`);
  };
  /** The shown page's WebContents, by what it does in main. */
  const inPage = (run, arg) => app.evaluate(({ webContents }, [body, prefix, value]) => {
    const pages = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(prefix));
    return new Function('pages', 'value', body)(pages, value); // eslint-disable-line no-new-func
  }, [run, address, arg]);
  const menu = async (name) => {
    await bar().getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menuitem', { name }).click();
  };
  const paneKey = async (keys) => { await bar().locator('.browser-address-view, .browser-address').first().focus(); await page.keyboard.press(keys); };
  /** A key pressed inside the page of tab `name`, through main's real input path. */
  const pageKeyDown = (name, keyCode, modifiers) => inPage(`
    const page = pages.find((contents) => contents.getURL().endsWith('/' + value.name));
    page.sendInputEvent({ type: 'rawKeyDown', keyCode: value.keyCode, modifiers: value.modifiers });
    page.sendInputEvent({ type: 'keyUp', keyCode: value.keyCode, modifiers: value.modifiers });
    return Boolean(page);`, { name, keyCode, modifiers });
  const file = async (name) => JSON.parse(await readFile(path.join(profile, name), 'utf8'));

  // ---- the chat and the pane
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.composer-input').waitFor();
  const cell = page.locator('.frame-workspace-cell button');
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click();
  await strip().waitFor();
  step('pane open');

  // ---- history: pages go in, the address field suggests them
  await openTab('Alpha');
  await openTab('Beta');
  await openTab('Gamma');
  await bar().locator('.browser-address-view').click();
  const field = bar().getByRole('textbox', { name: 'Website address' });
  await field.fill('alph');
  await page.locator('.browser-suggestion').first().waitFor();
  const suggestions = await page.locator('.browser-suggestion-title').allTextContents();
  assert.ok(suggestions.includes('alph'), `the typed search row: ${suggestions}`);
  assert.ok(suggestions.includes('Alpha page'), `the open tab: ${suggestions}`);
  await shot('01-suggestions-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('02-suggestions-dark'); await page.emulateMedia({ colorScheme: 'light' });
  const notes = await page.locator('.browser-suggestion-note').allTextContents();
  assert.ok(notes.includes('Switch to this tab'), notes.join());
  await page.locator('.browser-suggestion', { hasText: 'Alpha page' }).click();
  await waitShown('Alpha page');
  await until('history file', async () => {
    const entries = await file('browser-history.json').then((value) => value.entries).catch(() => []);
    return entries.some((entry) => entry.url.endsWith('/Alpha') && entry.title === 'Alpha page') && entries.some((entry) => entry.url.endsWith('/Gamma'));
  });
  step('history file ok');

  // ---- Ctrl+H in the pane: the popover, its search, a row opens the page
  await paneKey('Control+h');
  await page.locator('.browser-history').waitFor();
  await until('rows', async () => (await page.locator('.browser-history-row').count()) >= 3);
  assert.equal((await page.locator('.browser-history-title').allTextContents())[0], 'Gamma page', 'newest first');
  await shot('03-history-light');
  await page.locator('.browser-history-search').fill('beta');
  await until('search', async () => (await page.locator('.browser-history-row').count()) === 1);
  await page.keyboard.press('Escape');
  await page.locator('.browser-history').waitFor({ state: 'hidden' });

  // ---- Ctrl+Tab and Ctrl+1…9
  await waitShown('Alpha page');
  await paneKey('Control+Tab');
  await waitShown('Beta page');
  await paneKey('Control+Shift+Tab');
  await waitShown('Alpha page');
  await paneKey('Control+9');
  await waitShown('Gamma page');
  await paneKey('Control+2');
  await until('Ctrl+2', async () => (await shownTitle()) === (await page.locator('.browser-strip-title').nth(1).textContent()));
  step('tab keys in the pane ok');
  // inside a page: main reads them and tells the app
  await page.locator('.browser-strip-tab', { hasText: 'Gamma page' }).locator('.browser-strip-choose').click();
  await waitShown('Gamma page');
  await page.waitForTimeout(400);
  await pageKeyDown('Gamma', 'Tab', ['control', 'shift']);
  await waitShown('Beta page');
  await page.waitForTimeout(300);
  await pageKeyDown('Beta', '1', ['control']);
  await until('Ctrl+1 from a page', async () => (await shownTitle()) === (await page.locator('.browser-strip-title').first().textContent()));
  step('tab keys in a page ok');

  // ---- close and reopen
  await page.locator('.browser-strip-tab', { hasText: 'Beta page' }).locator('.browser-strip-choose').click();
  await waitShown('Beta page');
  const before = await page.locator('.browser-strip-tab').count();
  await paneKey('Control+w');
  await until('the tab closed', async () => (await page.locator('.browser-strip-tab').count()) === before - 1);
  await paneKey('Control+Shift+t');
  await waitShown('Beta page');
  assert.equal(await page.locator('.browser-strip-tab').count(), before, 'it came back as a tab, shown');
  await page.waitForTimeout(400);
  await page.locator('.browser-strip-tab.selected .browser-strip-close').click();
  await until('closed again', async () => (await page.locator('.browser-strip-tab').count()) === before - 1);
  await menu('Reopen closed tab');
  await waitShown('Beta page');
  step('reopen ok');

  // ---- All tabs: the menu lists every tab (the strip has no count cell), the shown one marked; a row shows its tab
  assert.equal(await page.locator('.global-pane .browser-tabs-button').count(), 0, 'no count cell in the strip');
  await menu('All tabs');
  const list = page.getByRole('menu', { name: 'Tabs' });
  await list.waitFor();
  assert.equal(await list.locator('.browser-tab-row').count(), await page.locator('.global-pane .browser-strip-tab').count(), 'one row per tab');
  assert.equal((await list.locator('[aria-current="true"] .menu-label > span:first-child').textContent())?.trim(), 'Beta page', 'the shown tab marked');
  await shot('03b-all-tabs-light');
  await list.getByRole('menuitem', { name: /Alpha page/ }).click();
  await waitShown('Alpha page');
  await list.waitFor({ state: 'detached' });
  await page.locator('.browser-strip-tab', { hasText: 'Beta page' }).locator('.browser-strip-choose').click();
  await waitShown('Beta page');
  step('all tabs ok');

  // ---- zoom: the menu, kept for the site
  await menu('Zoom in');
  await until('zoom', async () => (await inPage(`return pages.find((contents) => contents.getURL().endsWith('/Beta')).getZoomFactor();`)) > 1.05);
  await until('zoom file', async () => (await file('workspace-zoom.json').catch(() => ({ sites: {} }))).sites['127.0.0.1'] === 110);
  await bar().getByRole('button', { name: 'Browser menu' }).click();
  await shot('04-menu-zoomed');
  assert.ok(await page.getByRole('menuitem', { name: /Zoom in.*110%/ }).count(), 'the menu says the zoom');
  await page.keyboard.press('Escape');
  await paneKey('Control+-');
  await until('zoom out by key', async () => (await inPage(`return pages.find((contents) => contents.getURL().endsWith('/Beta')).getZoomFactor();`)) < 1.05);
  await menu('Zoom in');
  await until('zoom again', async () => (await file('workspace-zoom.json')).sites['127.0.0.1'] === 110);

  // ---- mute: a mark on the tab in the icon's cell, nothing moves
  await expectStable(page, ['.browser-strip-tab.selected', '.browser-strip-tab.selected .browser-strip-title', '.browser-strip-tab.selected .browser-strip-close'], () => menu('Mute tab'));
  await page.locator('.browser-strip-tab.selected .browser-strip-sound').waitFor();
  assert.equal(await inPage(`return pages.find((contents) => contents.getURL().endsWith('/Beta')).isAudioMuted();`), true);
  await shot('05-muted-tab');
  await page.locator('.browser-strip-tab.selected .browser-strip-sound').click();
  await page.locator('.browser-strip-tab.selected .browser-strip-sound').waitFor({ state: 'detached' });
  assert.equal(await inPage(`return pages.find((contents) => contents.getURL().endsWith('/Beta')).isAudioMuted();`), false);

  // ---- Mark a region of the page: the picture shows the page, a drag, into the composer
  await page.waitForTimeout(500);
  await menu('Mark a region');
  const frame = page.locator('.region-frame');
  await frame.locator('img').waitFor();
  await page.waitForFunction(() => document.querySelector('.region-frame img')?.complete);
  const colour = await page.evaluate(() => {
    const image = document.querySelector('.region-frame img');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(Math.floor(image.naturalWidth / 2), Math.floor(image.naturalHeight / 2), 1, 1).data];
  });
  assert.ok(colour[2] > 150 && colour[0] < 90, `the picture is the page, not an empty one: ${colour}`);
  assert.equal(await page.getByRole('button', { name: 'Add to message' }).isDisabled(), true, 'no region yet');
  const box = await frame.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.locator('.region-box').waitFor();
  assert.equal(await page.evaluate(() => { const content = document.querySelector('.paint-dialog[open] .dialog-content'); return content.scrollHeight > content.clientHeight; }), false, 'the whole picture fits, nothing to scroll to');
  await shot('06-region-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('07-region-dark'); await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Add to message' }).click();
  await page.locator('.paint-dialog[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await until('the draft', async () => (await page.locator('.composer-input').inputValue()).includes(`${address}/Beta`));
  await page.locator('.composer-attachments').getByText('-region.png').waitFor();
  await shot('08-region-in-composer');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('composer-input')), true, 'the keyboard is in the message field');
  await page.locator('.composer-input').fill('');
  await page.locator('.composer-attachments button[aria-label*="Remove"]').first().click().catch(() => {});
  step('region ok');

  // ---- the panels: Activity
  const panel = async (name) => {
    await strip().getByRole('button', { name: 'New tab', exact: true }).click();
    await page.locator('.new-tab-row', { hasText: name }).first().click();
  };
  await panel('Activity');
  await page.locator('.pane-activity .activity-row').first().waitFor();
  assert.equal(await shownTitle(), 'Activity');
  assert.ok(await page.locator('.activity-row', { hasText: manager.name }).count(), 'the agents are listed');
  await shot('09-activity-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('10-activity-dark'); await page.emulateMedia({ colorScheme: 'light' });

  // ---- Mark a region on the Screen tab (the picture is this PC's screen: no screenshot of it is kept)
  await panel('Screen');
  await page.locator('.pane-screen').waitFor();
  await bar().getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Mark a region' }).click();
  await page.locator('.region-frame img').waitFor({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.locator('.region-frame').waitFor({ state: 'detached' });
  step('screen region ok');

  // ---- Media: a video in the chat, the library's list and search
  const clip = await readFile(path.join(root, 'test/ui/fixtures/clip.webm'));
  const ref = await rpc.call('files.upload', { name: 'clip.webm', mime: 'video/webm', dataBase64: clip.toString('base64') });
  await rpc.call('messages.send', { conversationId: chat.id, body: 'The clip', attachments: [{ fileId: ref.id, name: ref.name, mime: ref.mime, size: ref.size }] });
  await panel('Media');
  await page.locator('.pane-search-field').waitFor();
  assert.equal(await shownTitle(), 'Media');
  await until('the clip in the library', async () => (await page.locator('.new-tab-row', { hasText: 'clip.webm' }).count()) > 0);
  await shot('11-media-library');
  await page.locator('.pane-search-field').fill('nothing-like-this');
  await page.getByText('No media found.').waitFor();
  await page.locator('.pane-search-field').fill('clip');
  await page.locator('.new-tab-row', { hasText: 'clip.webm' }).click();
  await until('the file in its own tab', async () => (await page.locator('.browser-strip-tab', { hasText: 'clip.webm' }).count()) > 0);
  assert.equal(await page.locator('.browser-strip-tab', { hasText: /^Media$/ }).count(), 1, 'the library stays');

  // ---- Video, opened through side-tabs.json: Comment at
  await until('layout in the file', async () => (await file('side-tabs.json')).spaces.global.tabs.some((tab) => tab.panel === 'media' && tab.id === 'media'));
  const tabs = await file('side-tabs.json');
  tabs.spaces.global.tabs.push({ id: `video:${chat.id}`, panel: 'video', conversationId: chat.id });
  tabs.spaces.global.shown = `video:${chat.id}`;
  await writeFile(path.join(profile, 'side-tabs.json'), `${JSON.stringify(tabs, null, 1)}\n`);
  await page.locator('.pane-video-player').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /Comment at 0:00\.0/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('.pane-video-player').readyState >= 1, undefined, { timeout: 20_000 });
  await page.evaluate(() => { document.querySelector('.pane-video-player').currentTime = 0.5; });
  await page.getByRole('button', { name: /Comment at 0:00\.5/ }).waitFor();
  await shot('12-video-comment');
  await page.getByRole('button', { name: /Comment at/ }).click();
  await until('the pointer in the draft', async () => (await page.locator('.composer-input').inputValue()).startsWith('[clip.webm @ 0:00.5] '));
  await shot('13-comment-in-composer');
  await page.locator('.composer-input').fill('');
  step('video ok');

  // ---- DevTools from the menu, in their own window. After the video on purpose: a video played after DevTools were open
  // stopped this window's frames for minutes on this PC (open in the build's list), and the clicks above wait for frames.
  await page.locator('.browser-strip-tab', { hasText: 'Beta page' }).locator('.browser-strip-choose').click();
  await waitShown('Beta page');
  await menu('DevTools');
  await until('DevTools open', () => inPage(`return pages.find((contents) => contents.getURL().endsWith('/Beta')).isDevToolsOpened();`));
  await menu('DevTools');
  await until('DevTools shut', async () => !(await inPage(`return pages.find((contents) => contents.getURL().endsWith('/Beta')).isDevToolsOpened();`)));
  step('devtools ok');

  // ---- an agent's page in a chat's space stays out of the history
  await rpc.call('chats.update', { id: chat.id, settings: { mode: 'browser' } });
  const sent = await rpc.call('messages.send', { conversationId: chat.id, body: `@${manager.name} [[tool:browser.open {"url":"${address}/Agent%20page","where":"chat"}]]`, mentions: [manager.id] });
  await until('the agent\'s answer', async () => (await rpc.call('messages.list', { conversationId: chat.id, limit: 30 })).some((message) => message.authorId === manager.id && message.seq > sent.seq && message.state === 'final'), 60_000);
  await until('the agent\'s tab', async () => (await file('side-tabs.json')).spaces[`chat:${chat.id}`]?.tabs.some((tab) => tab.by === manager.id));
  await sleep(2500); // the history's write is bundled behind a short timer
  assert.equal((await file('browser-history.json')).entries.some((entry) => entry.url.includes('Agent')), false, 'what an agent browses in its tab stays out');

  // ---- a restart keeps the history and the site's zoom
  await until('history saved', async () => (await file('browser-history.json')).entries.length >= 3);
  rpc.close?.();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  watch(page);
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await reconnect();
  const cellAgain = page.locator('.frame-workspace-cell button');
  if ((await cellAgain.getAttribute('aria-expanded')) !== 'true') await cellAgain.click();
  await strip().waitFor();
  await page.locator('.browser-strip-tab', { hasText: /Beta page|127\.0\.0\.1/ }).first().locator('.browser-strip-choose').click();
  await until('Beta loaded again at its site\'s zoom', async () => {
    const factor = await inPage(`const beta = pages.find((contents) => contents.getURL().endsWith('/Beta')); return beta ? beta.getZoomFactor() : 0;`);
    return factor > 1.05;
  }, 30_000);
  await bar().getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  await until('history after the restart', async () => (await page.locator('.browser-history-row').count()) >= 3);
  await shot('14-history-after-restart');

  assert.deepEqual(errors, [], 'no page errors');
});
