// Real Electron check of <data>/pages: a file there shows up on the "+" page without a reload and opens as a tab; the page reaches the
// app with wf.rpc and hears its events with wf.listen; an error comes back as the app's message; editing the file reloads the tab;
// wf.state survives that; a .js page runs; the look follows light and dark; side-tabs.json can open one and a restart keeps it
// (through the file); a deleted file says so; nothing shifts when the row opens; right-click opens the file; 640×480.
// A temp profile, the demo engine.
// Owns: these user paths. Never: touches the person's profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BOARD = (word, api) => `<!doctype html>
<html><head><title>Board</title><style>
  body { font: 14px var(--wf-font, sans-serif); color: var(--wf-fg, currentColor); background: var(--wf-surface, transparent); margin: 16px; }
  h3 { margin: 0 0 8px; } .num { color: var(--wf-accent, inherit); }
</style></head><body>
<h3 id="word">${word}</h3>
<p>Agents: <span class="num" id="agents">?</span></p>
<p>Error: <span id="error">?</span></p>
<p>Heard: <span id="heard">nothing</span></p>
<p>State: <span id="state">?</span></p>
<p>Fetched: <span id="fetched">?</span></p>
<script>
  wf.ready.then(async () => {
    document.getElementById('fetched').textContent = await fetch('${api}').then((response) => response.text(), (error) => String(error));
    const agents = await wf.rpc('agents.list');
    document.getElementById('agents').textContent = String(agents.length);
    try { await wf.rpc('chats.get', { id: 'ch_nothing' }); } catch (error) { document.getElementById('error').textContent = error.message; }
    await wf.listen('settings.updated', () => { document.getElementById('heard').textContent = 'settings'; });
    const before = await wf.state.get();
    document.getElementById('state').textContent = JSON.stringify(before ?? null);
    await wf.state.set({ seen: (before?.seen ?? 0) + 1 });
    document.body.dataset.ready = '1';
  });
</script></body></html>`;

test('pages: a file in <data>/pages is a tab that reaches the app', { timeout: 420_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-pages-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const launch = () => electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
  });
  const outside = createServer((_request, response) => { response.writeHead(200, { 'access-control-allow-origin': '*' }); response.end('from outside'); });
  await new Promise((resolve) => { outside.listen(0, '127.0.0.1', resolve); });
  const api = `http://127.0.0.1:${outside.address().port}/`;
  let app = await launch();
  let rpc;
  t.after(async () => {
    outside.close();
    rpc?.close?.();
    await app.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });
  let page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell, .mobile-shell', { timeout: 60_000 });
  let info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const dataRoot = (await rpc.call('system.root')).path;
  const pages = path.join(dataRoot, 'pages');
  await mkdir(pages, { recursive: true });

  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 400); win.setContentSize(w, h); }, [width, height]);
    await page.waitForTimeout(400);
  };
  const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
  const strip = () => page.locator('.browser-strip');
  const newTab = async () => { await strip().getByRole('button', { name: 'New tab', exact: true }).click(); await page.locator('.new-tab-row').first().waitFor(); };
  const row = (name) => page.locator('.new-tab .new-tab-row', { has: page.locator('.new-tab-label', { hasText: new RegExp(`^${name}$`) }) });
  const shownTitle = () => page.locator('.browser-strip-tab.selected .browser-strip-title').textContent();
  const frame = () => page.frameLocator('iframe.pane-page-frame');

  await size(1280, 800);
  await page.waitForSelector('.shell');
  const cell = page.locator('.frame-workspace-cell button');
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click();
  await strip().waitFor();

  // ---- rpc.methods answers what can be called, with params
  const listed = await rpc.call('rpc.methods', { match: 'pages.' });
  assert.deepEqual(listed.methods.map((method) => method.name), ['pages.list', 'pages.read']);
  assert.equal(listed.methods[1].params, '{ name: string }');

  // ---- a new file shows up on an open "+" page, without a reload, below the fixed rows
  await newTab();
  await row('Screen').waitFor();
  assert.equal(await row('board').count(), 0);
  await writeFile(path.join(pages, 'board.html'), BOARD('First', api));
  await row('board').waitFor({ timeout: 10_000 });
  const names = await page.locator('.new-tab-label').allTextContents();
  assert.equal(names.at(-1), 'board');
  await shot('01-new-tab-with-page');

  // ---- it opens in place of the blank tab; the strip and the address row stay where they are
  const tabsBefore = await page.locator('.browser-strip-tab').count();
  await expectStable(page, ['.browser-strip', '.browser-bar', '.browser-address-form'], async () => {
    await row('board').click();
    await page.locator('iframe.pane-page-frame').waitFor();
  });
  assert.equal(await page.locator('.browser-strip-tab').count(), tabsBefore, 'the blank tab became the page');
  assert.equal(await shownTitle(), 'board');

  // ---- the page reaches the app: a call, an error as the app's message, an event, its state
  await frame().locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
  assert.equal(await frame().locator('#word').textContent(), 'First');
  assert.match(await frame().locator('#agents').textContent(), /^\d+$/);
  assert.match(await frame().locator('#error').textContent(), /not found/i);
  assert.equal(await frame().locator('#state').textContent(), 'null');
  assert.equal(await frame().locator('#fetched').textContent(), 'from outside', 'it fetches what it likes');
  await rpc.call('settings.update', { profile: { name: 'Ada' } });
  await frame().locator('#heard', { hasText: 'settings' }).waitFor({ timeout: 10_000 });
  await shot('02-page-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await shot('03-page-dark');
  const darkBackground = await frame().locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  const lightBackground = await frame().locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
  assert.notEqual(darkBackground, lightBackground, 'the page follows the look');

  // ---- a frame has no way into the window: its origin is opaque
  const origin = await frame().locator('body').evaluate(() => window.origin);
  assert.equal(origin, 'null');

  // ---- editing the file reloads the tab, and its state survived
  await writeFile(path.join(pages, 'board.html'), BOARD('Second', api));
  await frame().locator('#word', { hasText: 'Second' }).waitFor({ timeout: 10_000 });
  await frame().locator('body[data-ready="1"]').waitFor();
  assert.equal(await frame().locator('#state').textContent(), '{"seen":1}');

  // ---- a .js file is a module in an empty page
  await writeFile(path.join(pages, 'clock.js'), `const line = document.createElement('p'); line.id = 'clock'; line.textContent = 'tick'; document.body.append(line);
await wf.ready; line.textContent = 'tock ' + (await wf.rpc('system.info')).version;`);
  await newTab();
  await row('clock').waitFor({ timeout: 10_000 });
  await row('clock').click();
  await frame().locator('#clock', { hasText: 'tock' }).waitFor({ timeout: 15_000 });
  await shot('04-js-page');

  // ---- the example in the skill works as written: it lists open tasks and follows them
  const skill = await readFile(path.join(root, 'resources/skills/app-data-model/SKILL.md'), 'utf8');
  const copy = await rpc.call('tasks.create', { title: 'Write the copy' });
  const after = await rpc.call('tasks.create', { title: 'Build the page', dependsOn: [copy.id] });
  assert.equal(after.status, 'waiting');
  await writeFile(path.join(pages, 'example.html'), /```html\r?\n([\s\S]*?)```/.exec(skill)[1]);
  await newTab();
  await row('example').waitFor({ timeout: 10_000 });
  await row('example').click();
  await frame().locator('#list li', { hasText: 'Write the copy' }).waitFor({ timeout: 15_000 });
  assert.equal(await frame().locator('#list li', { hasText: 'Build the page' }).count(), 0, 'what waits is not open yet');
  await rpc.call('tasks.create', { title: 'Added later' });
  await frame().locator('#list li', { hasText: 'Added later' }).waitFor({ timeout: 10_000 });
  await shot('04b-skill-example');

  // ---- the task that waits, as the person sees it
  await newTab();
  await row('Work').click();
  await page.locator('.workspace-pane', { hasText: 'Build the page' }).waitFor({ timeout: 15_000 });
  await shot('04c-work-waiting');

  // ---- wf.open opens a website tab beside the page
  await strip().locator('.browser-strip-tab', { hasText: 'example' }).click();
  await frame().locator('#list li').first().waitFor();
  await frame().locator('body').evaluate((_body, url) => { void wf.open(url); }, api);
  await page.waitForFunction(() => !document.querySelector('iframe.pane-page-frame'), null, { timeout: 15_000 });
  await page.waitForFunction((host) => document.querySelector('.browser-address-form .browser-address-view')?.title.includes(host), new URL(api).host, { timeout: 15_000 });
  await shot('04d-wf-open');

  // ---- a right click on its row opens the file in a file tab
  await newTab();
  await row('board').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit file' }).click();
  await page.locator('textarea.file-field').waitFor();
  assert.equal(await shownTitle(), 'board.html');
  await shot('05-edit-file');

  // ---- side-tabs.json opens a page too, and it stays over a restart
  const sideTabs = path.join(dataRoot, 'side-tabs.json');
  const layout = JSON.parse(await readFile(sideTabs, 'utf8'));
  const global = layout.spaces.global;
  assert.ok(global.tabs.some((tab) => tab.panel === 'page' && tab.name === 'board'), 'the file holds the open page');
  global.shown = 'page:board';
  await writeFile(sideTabs, JSON.stringify(layout, null, 2));
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'board', null, { timeout: 10_000 });
  await frame().locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });

  await size(640, 480);
  await shot('06-small-window');
  await size(1280, 800);

  rpc.close?.();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await page.locator('iframe.pane-page-frame').waitFor({ timeout: 30_000 });
  await frame().locator('#word', { hasText: 'Second' }).waitFor({ timeout: 20_000 });
  await frame().locator('body[data-ready="1"]').waitFor({ timeout: 20_000 }); // it reaches the app after a restart too
  assert.match(await frame().locator('#agents').textContent(), /^\d+$/);
  await shot('07-after-restart');

  // ---- the file goes: the tab says so
  await rm(path.join(pages, 'board.html'));
  await page.locator('.pane-view', { hasText: 'This page is gone' }).waitFor({ timeout: 10_000 });
  await shot('08-gone');

  assert.deepEqual(errors, []);
});
