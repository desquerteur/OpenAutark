// Real Electron regression: persistent columns, both dividers, settings return, the browser pane's real website tabs
// and isolated websites (fixture refuses iframe embedding). Screenshots use fake data.
// One header row in the chrome color that the native caption controls fill (no control under them in any route), no
// rounded column corner (the sheet edge is drawn once by the frame), and in the compact window the controls sit in its
// 48 px top bar (no strip above it), nothing under them. Every zone's top row is a lib/header.tsx row (.frame-header);
// the frame's Browser cell sits at the right of the row in both states and the browser pane lies below the row at its
// default width and in a narrower wide window (its tab strip with "+" its first line), on a wide pane from the window's
// top (its strip is the row's part above it); under the strip a 40 px bar: Back, Forward, Reload, the address, the menu
// with All tabs; a
// chat's area opens as the first part of its column, right under the row, beside the details panel, in the chat's colour.
// Owns: the integrated user paths. Never: touches the person's profile or external websites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('persistent desktop columns and real browser pane tabs', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-columns-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    res.end(`<title>${req.url === '/next' ? 'Second page' : 'Browser test'}</title><style>body{font:16px system-ui;padding:24px;background:#f4f4f4;color:#222}input{font:inherit;padding:8px}</style><h1>Browser test</h1><p>${req.url}</p><input aria-label="Test input"><p><a href="/next">Next page</a></p><a href="/popup" target="_blank">New tab</a>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
    await page.waitForTimeout(300);
  };
  const shot = async (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  const overlayOs = process.platform !== 'darwin'; // Windows/Linux: window-controls overlay
  /** The overlay's height and every visible control that reaches under it. */
  const caption = () => page.evaluate(() => {
    const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    if (!rect || !rect.width) return null;
    const left = rect.x + rect.width;
    const under = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=tab], [role=separator]')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > left && box.top < rect.height && getComputedStyle(el).visibility !== 'hidden';
    }).map((el) => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30));
    return { height: rect.height, width: innerWidth - left, under };
  });
  const captionClear = async (where) => {
    if (!overlayOs) return;
    const state = await caption();
    assert.ok(state, `${where}: window controls overlay present`);
    assert.deepEqual(state.under, [], `${where}: nothing under the caption controls`);
  };
  /** Top headers share one color (the frame's chrome); no column keeps a rounded corner. */
  const headerRow = (selectors) => page.evaluate((list) => {
    const color = (el) => getComputedStyle(el).backgroundColor;
    const frame = color(document.querySelector('.shell > .app-frame') ?? document.querySelector('.shell'));
    const heads = list.map((selector) => document.querySelector(selector)).filter(Boolean);
    const corners = ['.main-slot', '.global-pane', '.chat-panel'].map((selector) => document.querySelector(selector))
      .filter(Boolean).map((el) => getComputedStyle(el).borderTopLeftRadius);
    return { frame, count: heads.length, colors: [...new Set(heads.map(color))], tops: heads.map((el) => el.getBoundingClientRect().top), corners };
  }, selectors);
  const wait = async (check, why) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(50); }
    assert.fail(why);
  };
  // Settings opens from the profile menu or with Ctrl+, (mod+, toggles it; there is no rail button).
  const settings = { click: () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma') };
  const sidebar = page.getByRole('separator', { name: 'Resize sidebar' });
  const workspace = page.getByRole('separator', { name: 'Resize workspace' });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' }, appearance: { chatDock: { place: 'top' } } }); // AF-010: the chat's tabs above the messages, as this test measures them (right is the default now)
  await size(1440, 900);
  await page.locator('.day-view').waitFor();
  const workspaceCell = page.locator('.frame-workspace-cell button');
  if ((await workspaceCell.getAttribute('aria-expanded')) !== 'true') await workspaceCell.click();
  await page.locator('.global-pane .browser-bar').waitFor();
  await shot('01-columns-home-light');

  const aligned = await page.evaluate(() => ['.sidebar .frame-header', '.day-view > .frame-header'].map((selector) => {
    const box = document.querySelector(selector).getBoundingClientRect(); return { y: box.y, height: box.height, right: box.right };
  }));
  assert.ok(aligned.every((box) => box.y === 0 && Math.abs(box.height - 48) < 1), JSON.stringify(aligned));
  assert.ok(Math.abs(aligned[1].right - await page.evaluate(() => innerWidth)) < 1, 'the main zone\'s row runs on over the open pane');
  // the default pane leaves the row no room for three titled tabs beside the caption controls: it lies below the row
  const paneTop = () => page.evaluate(() => document.querySelector('.global-pane').getBoundingClientRect().top);
  assert.ok(Math.abs(await paneTop() - 48) < 1, `the pane lies below the header row at its default width (top ${await paneTop()})`);
  assert.equal(await page.locator('.app-frame.strip-in-row').count(), 0, 'its strip is its first line, not cramped into the row');
  const row = await headerRow(['.sidebar .frame-header', '.day-view > .frame-header']);
  assert.equal(row.count, 2);
  assert.equal(row.colors.length, 1, `one header row color (${row.colors.join(', ')})`);
  assert.ok(row.corners.every((radius) => radius === '0px'), `no rounded column corner: ${row.corners}`);
  if (overlayOs) assert.equal((await caption()).height, 47, 'caption controls fill the 48 px header row (1 px for the sheet edge)');
  await captionClear('home with the browser pane');
  // Hold references to the actual nodes; route changes must not replace either column.
  await page.evaluate(() => { window.columnsBefore = { sidebar: document.querySelector('.sidebar'), pane: document.querySelector('.global-pane') }; });
  const sidebarBefore = await page.locator('.sidebar').boundingBox();
  const paneBefore = await page.locator('.global-pane').boundingBox();
  await settings.click();
  await page.locator('.settings-view').waitFor();
  assert.deepEqual(await page.locator('.sidebar').boundingBox(), sidebarBefore);
  assert.deepEqual(await page.locator('.global-pane').boundingBox(), paneBefore);
  assert.equal(await page.evaluate(() => window.columnsBefore.sidebar === document.querySelector('.sidebar') && window.columnsBefore.pane === document.querySelector('.global-pane')), true);
  assert.equal(await page.getByRole('button', { name: 'Close settings', exact: true }).count(), 0);
  await captionClear('settings with the browser pane');
  await shot('02-columns-settings-light');
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await page.locator('.day-view').waitFor();

  // Both dividers: keyboard and pointer; the pane's width survives a reload.
  const widthBefore = Number(await sidebar.getAttribute('aria-valuenow'));
  await sidebar.focus(); await page.keyboard.press('ArrowRight');
  await wait(async () => Number(await sidebar.getAttribute('aria-valuenow')) === widthBefore + 8, 'sidebar keyboard resize');
  const paneWidth = Number(await workspace.getAttribute('aria-valuenow'));
  await workspace.focus(); await page.keyboard.press('Shift+ArrowLeft');
  await wait(async () => Number(await workspace.getAttribute('aria-valuenow')) === paneWidth + 32, 'pane keyboard resize');
  const grip = await workspace.boundingBox();
  await page.mouse.move(grip.x + 4, grip.y + 150); await page.mouse.down();
  await page.mouse.move(grip.x - 46, grip.y + 150, { steps: 5 }); await page.mouse.up();
  await wait(async () => Number(await workspace.getAttribute('aria-valuenow')) > paneWidth + 70, 'pane pointer resize');
  await page.reload(); await page.waitForSelector('.shell');
  await page.locator('.global-pane').waitFor();
  assert.ok(Number(await workspace.getAttribute('aria-valuenow')) > paneWidth + 70, 'resize persists after reload');
  // a wide pane: room for three titled tabs in the row, so the pane starts at the window's top and its strip is the row's part above it
  await workspace.focus(); await page.keyboard.press('End');
  await page.locator('.app-frame.strip-in-row').waitFor();
  assert.ok(Math.abs(await paneTop()) < 1, `the pane starts at the window's top (top ${await paneTop()})`);
  assert.equal(Math.round((await page.locator('.global-pane .browser-strip').boundingBox()).height), 49, 'the row and the sheet edge line');
  await captionClear('a wide pane with its strip in the row');
  const cellBox = await workspaceCell.boundingBox();
  assert.equal(await workspaceCell.getAttribute('aria-pressed'), 'true', 'pressed while the pane is open');
  await workspaceCell.click();
  await page.locator('.global-pane').waitFor({ state: 'detached' });
  assert.deepEqual(await workspaceCell.boundingBox(), cellBox, 'the Browser cell keeps its place when the pane closes');
  await settings.click();
  assert.equal(await page.locator('.global-pane').count(), 0, 'a closed pane stays closed in settings');
  await workspaceCell.click();
  await page.locator('.global-pane .browser-bar').waitFor();

  // A real website tab: a sandboxed native view without any bridge.
  const bar = page.locator('.global-pane .browser-bar');
  const field = bar.getByRole('textbox', { name: 'Website address' });
  const strip = page.locator('.global-pane .browser-strip');
  const title = () => page.evaluate(() => document.querySelector('.global-pane .browser-strip-tab.selected .browser-strip-title')?.textContent ?? '');
  const waitTitle = (expected) => page.waitForFunction((want) => document.querySelector('.global-pane .browser-strip-tab.selected .browser-strip-title')?.textContent === want, expected, { timeout: 15_000 });
  await strip.getByRole('button', { name: 'New tab', exact: true }).click();
  await field.waitFor();
  await field.fill(address);
  await field.press('Enter');
  await waitTitle('Browser test');
  const nativeState = () => app.evaluate(({ webContents }, prefix) => {
    const wc = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(prefix));
    return wc ? { id: wc.id, url: wc.getURL(), preferences: wc.getLastWebPreferences() } : null;
  }, address);
  const native = await nativeState();
  assert.equal(native.preferences.sandbox, true);
  assert.equal(native.preferences.nodeIntegration, false);
  assert.equal(native.preferences.preload, undefined);
  const inside = await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({bridge:typeof window.workforce,node:typeof require})'), native.id);
  assert.deepEqual(inside, { bridge: 'undefined', node: 'undefined' });
  await shot('04-browser-settings-light');
  const nativeShot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const [width, height] = window.getSize();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: width * 2, height: height * 2 } });
    return sources.find((source) => source.id === window.getMediaSourceId())?.thumbnail.toPNG().toString('base64');
  });
  assert.ok(nativeShot, 'the real window can be captured with its native website surface');
  await writeFile(path.join(out, '04b-browser-native-window.png'), Buffer.from(nativeShot, 'base64'));

  // Typing into the native page; the text survives leaving and coming back (settings and back).
  await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    contents.focus();
    await contents.executeJavaScript('document.querySelector("input").focus()');
    for (const keyCode of 'kept across views') contents.sendInputEvent({ type: 'char', keyCode });
  }, native.id);
  await page.evaluate(() => { location.hash = '#/settings'; }); // the keyboard is with the website now
  await page.locator('.settings-view').waitFor();
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.querySelector("input").value'), native.id), 'kept across views');
  assert.equal(await title(), 'Browser test');

  // Address, Back and Forward; a popup becomes a tab of its own; a closed tab releases its renderer.
  await bar.locator('.browser-address-view').click();
  await field.fill(`${address}/next`);
  await field.press('Enter');
  await waitTitle('Second page');
  await bar.getByRole('button', { name: 'Back', exact: true }).click();
  await waitTitle('Browser test');
  await bar.getByRole('button', { name: 'Forward', exact: true }).click();
  await waitTitle('Second page');
  const count = () => strip.locator('.browser-strip-tab').count();
  const before = await count();
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.querySelector("a[target]").click()', true), native.id);
  await wait(async () => (await count()) === before + 1, 'a website popup becomes a tab of its own');
  await waitTitle('Browser test');
  await page.locator('.global-pane .browser-bar').getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'All tabs' }).click();
  const tabsMenu = page.getByRole('menu', { name: 'Tabs' });
  await tabsMenu.waitFor();
  await tabsMenu.getByRole('button', { name: 'Close Browser test', exact: true }).click();
  await wait(async () => (await count()) === before, 'the popup tab closes');
  await page.keyboard.press('Escape').catch(() => undefined);

  // Ctrl+K from inside the page opens the palette; the native view hides behind it.
  const current = await nativeState();
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: ['control'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: ['control'] });
  }, current.id);
  await page.locator('dialog[open]').waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => view.constructor.name === 'WebContentsView' && view.getVisible()).length), 0, 'the browser hides behind the palette');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => { location.hash = '#/settings'; }); await shot('05-columns-settings-dark');
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  // Closing the last website tab releases its renderer.
  for (let i = 0; i < 5 && (await nativeState()); i += 1) {
    await page.locator('.global-pane .browser-bar').getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menuitem', { name: 'All tabs' }).click();
    await tabsMenu.waitFor();
    const close = tabsMenu.getByRole('button', { name: /^Close / }).first();
    if (!(await close.count())) { await page.keyboard.press('Escape'); break; }
    await close.click();
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(300);
  }
  assert.equal(await nativeState(), null, 'closing the tabs releases their renderers');

  // Compact windows: the caption controls in the one top bar, nothing under them.
  await page.emulateMedia({ colorScheme: 'light' });
  await size(900, 650); await shot('07-browser-narrow');
  // a narrower window: the pane shrinks (to 304 px at most), too little for three titled tabs beside the caption controls
  await page.waitForFunction(() => !document.querySelector('.app-frame.strip-in-row'));
  assert.ok(Math.abs(await paneTop() - 48) < 1, 'the pane lies below the row again, its strip its first line');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await size(640, 480); await page.locator('.mobile-shell').waitFor(); await shot('08-settings-640x480');
  if (overlayOs) await wait(async () => (await caption())?.height === 47, 'compact window: the caption controls fill its 48 px top bar');
  if (overlayOs) {
    // whatever row is on top (here the settings page's top bar) holds the controls
    const top = await page.evaluate(() => { const el = document.elementFromPoint(120, 24)?.closest('.mobile-top, .frame-header'); const b = el?.getBoundingClientRect(); return b && { top: b.top, height: b.height, drag: getComputedStyle(el).getPropertyValue('app-region') || getComputedStyle(el).getPropertyValue('-webkit-app-region') }; });
    assert.deepEqual(top && [top.top, top.height], [0, 48], 'the top bar is the top row, as tall as the header row');
    assert.equal(top.drag, 'drag', 'the window moves by its top bar');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.mobile-shell'), '::before').content), 'none', 'no caption strip above the top bar');
  }
  await captionClear('compact settings');
  await size(420, 860); await shot('09-settings-phone-light');
  await captionClear('phone-width settings');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('10-settings-phone-dark');
  await size(1440, 900); await page.locator('.shell').waitFor();
  if (overlayOs) await wait(async () => (await caption())?.height === 47, 'column layout again: the controls fill the header row');

  // A chat: the details panel opens below the chat header row; the row's cells and the frame's Browser cell stay.
  const chat = (await rpc.call('chats.list'))[0];
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('textarea.composer-input').waitFor(); await shot('11-chat-dark');
  await page.emulateMedia({ colorScheme: 'light' }); await shot('12-chat-light');
  await captionClear('chat');
  await expectStable(page, ['.chat-header [data-cell="call"]', '.chat-header [data-cell="browser"]', '.chat-header .chat-title-button', '.frame-workspace-cell'], async () => {
    await page.locator('.chat-title-button').click();
    await page.locator('.chat-panel').waitFor();
  });
  const details = await headerRow(['.chat-header', '.sidebar .frame-header']);
  assert.equal(details.colors.length, 1, 'the chat header row keeps the chrome color');
  assert.deepEqual(details.tops, [0, 0]);
  const panelTop = await page.locator('.chat-panel').evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(Math.abs(panelTop - 48) < 1, `the panel starts below the header row (${panelTop})`);
  assert.ok(details.corners.every((radius) => radius === '0px'), `no rounded panel corner: ${details.corners}`);
  await captionClear('chat with details');
  await shot('13-chat-details-light');

  // The chat's area: the first part of the chat column right under the header row, beside the details panel, in the
  // chat's colour (the global pane keeps its chrome-coloured strip); the row's cells, the panel and the composer stay.
  // The steps above widened the pane until the details float over the chat (a chat view under 620 px, chat.css);
  // a double-click on its divider gives it back its default width, room for the column and the panel side by side.
  await workspace.dblclick();
  await wait(async () => Number(await workspace.getAttribute('aria-valuenow')) === 400, 'the pane back at its default width');
  await expectStable(page, ['.chat-header [data-cell="call"]', '.chat-header [data-cell="browser"]', '.chat-header .chat-title-button', '.frame-workspace-cell', '.chat-panel', '.composer'], async () => {
    await page.locator('.chat-header [data-cell="browser"] button').click();
    await page.locator('.chat-area .browser-strip').waitFor();
  });
  const area = await page.evaluate(() => {
    const box = document.querySelector('.chat-area').getBoundingClientRect();
    const color = (selector) => { const el = document.querySelector(selector); return el && getComputedStyle(el).backgroundColor; };
    return { top: box.top, right: box.right, panel: document.querySelector('.chat-panel').getBoundingClientRect().left, strip: color('.chat-area .browser-strip'), chat: color('.chat-column'), pane: color('.global-pane .browser-strip') };
  });
  assert.ok(Math.abs(area.top - 48) < 1, `the area starts below the header row (${area.top})`);
  assert.ok(area.right <= area.panel + 1, 'the details panel stays beside it');
  assert.equal(area.strip, area.chat, 'the area is part of the chat');
  if (area.pane) assert.notEqual(area.pane, area.strip, 'the global pane looks like the frame, not like the chat');
  await captionClear('chat with its area');
  await shot('14-chat-area-light');
  await page.locator('.chat-header [data-cell="browser"] button').click();
  await page.locator('.chat-area').waitFor({ state: 'detached' });
  assert.deepEqual(errors, [], 'no renderer exceptions');
  t.diagnostic(`screenshots: ${out}`);
});
