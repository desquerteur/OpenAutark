// AF-008, real Electron: Settings › Appearance (data-tour="appearance") without editing a file. A new theme starts from
// Autark's own: accent colour, light background, text size, density and corner radius change, the whole window shows
// the draft at once, Save keeps it (settings.json › appearance); the panels of a new tab move (arrow and drag) and one
// hides; the chat's tabs dock left from the page. After a restart the theme, the panel order and the dock are the same,
// a new tab offers the panels in that order, and a website still lies inside the chat's tabs at the larger text size.
// "Reset to default" brings Autark's look and layout back, the theme stays in the list. Screenshots light and dark:
// SCREENSHOTS names the folder. A temp profile, the demo engine, a local fixture server.
// Owns: these user paths. Never: touches the person's profile or external websites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settingsOf = async (profile) => {
  const text = await readFile(path.join(profile, 'settings.json'), 'utf8');
  return JSON.parse(text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n').replace(/,(\s*[}\]])/g, '$1'));
};

test('Settings › Appearance: an own theme, panels in order, the dock – kept after a restart, and a reset', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autark-appearance-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Plan</title><style>body{font:18px system-ui;margin:0;padding:24px;background:#eef3ff}</style><h1>Plan</h1>');
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
  let page;
  t.after(async () => {
    await page?.screenshot({ path: path.join(out, 'appearance-last.png'), timeout: 5000 }).catch(() => {});
    rpc?.close?.();
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const errors = [];
  const open = async () => {
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForSelector('.shell', { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 900); });
    rpc?.close?.();
    const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
    rpc = await connect(info.port, info.token, 'cli');
  };
  await open();
  await rpc.call('settings.update', { onboarding: { step: 'done' }, preferences: { theme: 'light' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Look', agentIds: [manager.id] });
  const shot = async (name) => {
    await page.waitForTimeout(400);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (what, check, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) assert.fail(`waited for ${what}`);
      await sleep(150);
    }
  };
  const look = async () => (await settingsOf(profile)).appearance;
  const rootVar = (name) => page.evaluate((key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);
  const goSettings = async () => {
    await page.evaluate(() => { location.hash = '#/settings/appearance'; });
    await page.locator('.appearance-page').waitFor();
    assert.equal(await page.locator('.settings-nav [data-tour="appearance"]').count(), 1, 'the nav entry is the tour target');
  };

  // 1. A new theme from Autark's own; every change shows at once (a draft), Save keeps it.
  await goSettings();
  await shot('af008-01-appearance-light');
  await page.getByRole('button', { name: 'New theme…' }).click();
  await page.getByRole('menuitem', { name: 'Autark' }).click();
  await page.locator('#theme-name').fill('Sea');
  const hex = (label) => page.getByRole('textbox', { name: `${label} as hex` });
  await hex('Accent colour').fill('#1f6fd1'); await hex('Accent colour').press('Tab');
  await until('the draft accent in the window', async () => (await rootVar('--accent')) === '#1f6fd1');
  await hex('Background, light').fill('#f4f8fc'); await hex('Background, light').press('Tab');
  await hex('Background, dark').fill('#1b2330'); await hex('Background, dark').press('Tab');
  await page.getByRole('slider', { name: 'Text size' }).fill('110');
  await page.getByRole('radio', { name: 'Compact' }).click();
  await page.getByRole('slider', { name: 'Corner radius' }).fill('16');
  await until('the draft radius', async () => (await rootVar('--r-md')) === '16px');
  assert.equal((await look()).themes.length, 0, 'nothing saved before Save');
  await shot('af008-02-theme-editor-light');
  await page.getByRole('button', { name: 'Save theme' }).click();
  const saved = await until('the theme saved', async () => { const value = await look(); return value.themes.length === 1 && value.theme ? value : null; });
  assert.deepEqual({ ...saved.themes[0], id: '' }, { id: '', name: 'Sea', accent: '#1f6fd1', background: '#f4f8fc', backgroundDark: '#1b2330', font: '', textSize: 110, density: 'compact', radius: 16 });
  assert.equal(saved.theme, saved.themes[0].id, 'and in use');
  assert.equal(await rootVar('--surface'), '#f4f8fc', 'the light background');
  await rpc.call('settings.update', { preferences: { theme: 'dark' } });
  await until('the dark background', async () => (await rootVar('--surface')) === '#1b2330');
  await shot('af008-03-appearance-dark');
  await rpc.call('settings.update', { preferences: { theme: 'light' } });

  // 2. The panels of a new tab: Files up by its arrow, Agents dragged to the top, Work hidden.
  await page.getByRole('button', { name: 'Move Files up' }).click();
  await until('Files above Media', async () => (await look()).panels.join() === 'day,work,notes,files,media,agents');
  await page.locator('[data-panel="agents"]').dragTo(page.locator('[data-panel="day"]'), { targetPosition: { x: 40, y: 4 } });
  await until('Agents first', async () => (await look()).panels[0] === 'agents');
  await page.getByRole('switch', { name: 'Show Work in a new tab' }).click();
  await until('Work hidden', async () => (await look()).hiddenPanels.join() === 'work');
  // 3. The chat's tabs dock left from the page.
  await page.getByRole('radiogroup', { name: 'Where the chat\'s tabs sit' }).getByRole('radio', { name: 'Left' }).click();
  await until('docked left', async () => (await look()).chatDock.place === 'left');
  await shot('af008-04-layout-light');
  const before = await look();

  // 4. After a restart: the same theme, panels and dock; a new tab offers the panels in that order; a page lies inside the dock.
  await app.close();
  app = await launch();
  await open();
  assert.deepEqual(await look(), before, 'settings.json the same');
  await until('the theme back', async () => (await rootVar('--accent')) === '#1f6fd1');
  assert.equal(await rootVar('--text-zoom'), '1.1');
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('textarea.composer-input').waitFor();
  await page.locator('.chat-header [data-cell="browser"] button').click();
  await page.locator('.chat-body > .chat-area.dock-left').waitFor();
  const offered = await page.locator('.chat-area .new-tab-list[aria-label="Open in this tab"] .new-tab-label').allTextContents();
  assert.deepEqual(offered.slice(0, 5), ['Agents', 'My day', 'Notes', 'Files', 'Media'], `the panels in their order, Work left out: ${offered.join(', ')}`);
  await page.locator('textarea.composer-input').fill(`[[tool:browser.show {"url":"${address}/plan","where":"chat"}]]`);
  await page.locator('button.send-button').click();
  await until('the page inside the chat\'s tabs at 110 %', async () => {
    const area = await page.locator('.chat-area .browser-native-slot').evaluate((element) => { const r = element.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom }; }).catch(() => null);
    const views = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
      .filter((view) => view.constructor.name === 'WebContentsView' && view.getVisible() && view.getBounds().width > 10).map((view) => view.getBounds()));
    return area && views.some((view) => Math.abs(view.x - area.x) <= 2 && Math.abs(view.y - area.y) <= 2 && Math.abs(view.x + view.width - area.right) <= 2);
  }, 40_000);
  await shot('af008-05-chat-with-theme-light');
  await rpc.call('settings.update', { preferences: { theme: 'dark' } });
  await shot('af008-06-chat-with-theme-dark');
  await rpc.call('settings.update', { preferences: { theme: 'light' } });

  // 5. Reset to default: Autark's look and layout, the theme stays in the list.
  await goSettings();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const reset = await until('reset', async () => { const value = await look(); return value.theme === '' && value.chatDock.place === 'right' ? value : null; });
  assert.deepEqual(reset.panels, ['day', 'work', 'notes', 'media', 'files', 'agents']);
  assert.deepEqual(reset.hiddenPanels, []);
  assert.equal(reset.themes.length, 1, 'the own theme stays');
  assert.equal((await settingsOf(profile)).preferences.theme, 'system');
  await until('Autark\'s look', async () => (await rootVar('--accent')) === '');
  assert.deepEqual(errors, [], 'no renderer exceptions');
  t.diagnostic(`screenshots: ${out}`);
});
