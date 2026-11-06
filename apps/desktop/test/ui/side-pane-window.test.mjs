// Real Electron check of the side pane built like a browser: at its default width its tab strip is its first line under
// the window's title row (no room for three titled tabs beside the caption controls), on a wide pane it is the title row
// (clear of the frame's cells and the caption controls), under it the address row. The resting
// address shows the address alone and the page's title lives on the tab, with the page's favicon; the tabs share the
// room like Chrome's (one width, narrower with more tabs, whole tabs only, "+" right after the last), a click (also on a
// narrow tab: no tab box, icon or × cell moves) and a close under the pointer move nothing; "+" opens a blank tab whose page lists
// the panels, and a panel takes that tab's place; My day, Work, Notes, Media and an agent's browser open as tabs;
// the agent's right-click menu has "Open in side panel"; full view covers the main zone, its strip stays where it was,
// and comes back; the feedback cell
// sits right before the caption controls and clear of them; a menu over a page hides its native view while it is open; a
// chat's own way in (Chat details › Notes) opens in the chat's area above the messages and the global pane keeps its tabs;
// full view per surface (the area takes its column above the composer); at 640×480 the area lies above the composer and
// its address field offers no tab of the global pane, which this layout has not;
// light and dark, 1280×800 and 640×480 (SCREENSHOTS names the folder). A temp profile, the demo engine, a local fixture
// server, no real sites.
// Owns: these user paths. Never: touches the person's profile or external websites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

test('the side pane: tab strip, address row, panels as tabs, full view', { timeout: 560_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-pane-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const server = createServer((req, res) => {
    if (req.url === '/icon.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(ICON); return; }
    const name = /^\/page(\d+)/.exec(req.url)?.[1] ?? '1';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<title>Site number ${name}</title><link rel="icon" href="/icon.png"><style>:root{color-scheme:light dark}body{font:16px system-ui;padding:24px}</style><h1>Page ${name}</h1><p>A local fixture.</p>`);
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
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(45_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell, .mobile-shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 400); win.setContentSize(w, h); }, [width, height]);
    await page.waitForTimeout(400);
  };
  /** The window's own page as drawn (a native page and the caption controls are not in this picture; nativeVisible, the bounds and the caption rect below cover them). */
  const shot = async (name) => {
    await page.waitForTimeout(250);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
    await page.screenshot({ path: path.join(out, `${name}-page.png`) });
  };
  const scheme = async (value) => { await page.emulateMedia({ colorScheme: value }); await page.waitForTimeout(300); };
  const strip = page.locator('.browser-strip');
  const bar = page.locator('.browser-bar');
  const shown = () => page.locator('.browser-strip-tab.selected .browser-strip-title').textContent();
  const nativeVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => view.constructor.name === 'WebContentsView' && view.getVisible()).length);

  await size(1280, 800);
  await page.waitForSelector('.shell');
  const first = (await rpc.call('chats.list'))[0];
  const agents = await rpc.call('agents.list');
  assert.ok(agents.length > 0, 'the demo profile has an agent');
  await rpc.call('todos.add', { text: 'Call the supplier about the delivery' }).catch(() => {});
  await rpc.call('tasks.create', { title: 'Compare three offers for the new office' }).catch(() => {});
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, first.id);
  await page.locator('textarea.composer-input').waitFor();

  // ---- the frame's cells: the feedback cell right before the caption, clear of it
  const cell = page.locator('.frame-workspace-cell button');
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click();
  await strip.waitFor();
  const feedback = await page.locator('.frame-feedback-cell').boundingBox();
  const workspace = await page.locator('.frame-workspace-cell').boundingBox();
  assert.ok(workspace.x + workspace.width <= feedback.x, 'the Browser cell comes first, then feedback');
  const overlay = await page.evaluate(() => { const controls = navigator.windowControlsOverlay; return controls?.visible ? controls.getTitlebarAreaRect().toJSON() : null; });
  if (process.platform === 'win32') assert.ok(overlay, 'Windows draws its caption controls over the row');
  const room = overlay ? overlay.x + overlay.width : await page.evaluate(() => innerWidth);
  assert.ok(feedback.x + feedback.width <= room, `feedback ends before the caption controls (${feedback.x + feedback.width} ≤ ${room})`);
  // the default pane leaves the row no room for three titled tabs beside the caption controls and the frame's cells: its
  // strip is its first line under the row, not cramped into it
  assert.equal(await page.locator('.app-frame.strip-in-row').count(), 0, 'no strip in the row at the default width');
  assert.equal(Math.round((await page.locator('.global-pane .browser-strip').boundingBox()).y), 48, 'the strip is the pane\'s first line under the row');
  // a wide pane: its strip is the title row's part above the pane – the row's height, its "+" before the frame's cells
  const resize = page.getByRole('separator', { name: 'Resize workspace' });
  await resize.focus();
  await page.keyboard.press('End');
  await page.locator('.app-frame.strip-in-row').waitFor();
  const stripBox = await page.locator('.global-pane .browser-strip').boundingBox();
  assert.equal(stripBox.y, 0, 'the strip starts at the window\'s top');
  assert.equal(Math.round(stripBox.height), 49, 'the row\'s 48 px and the sheet\'s edge line');
  const plusBox = await page.locator('.global-pane .browser-strip-new').boundingBox();
  assert.ok(plusBox.x + plusBox.width <= workspace.x, `"+" ends before the Browser cell (${plusBox.x + plusBox.width} ≤ ${workspace.x})`);
  assert.ok(plusBox.y + plusBox.height <= 48, '"+" lies in the row');

  // ---- a blank tab: the panels under the address field
  await strip.getByRole('button', { name: 'New tab', exact: true }).click();
  await bar.getByRole('textbox', { name: 'Website address' }).waitFor();
  const rows = () => page.locator('.new-tab-row .new-tab-label').allTextContents();
  assert.deepEqual(await rows(), ['My day', 'Work', 'Notes', 'Media', 'Files', 'Agents']);
  for (const name of ['Back', 'Forward', 'Reload']) assert.equal(await bar.getByRole('button', { name, exact: true }).isDisabled(), true, `${name} is in its place, faint`);
  await scheme('light'); await shot('01-new-tab-light');
  await scheme('dark'); await shot('02-new-tab-dark');
  await scheme('light');

  // ---- a website: the address alone at rest, the title and icon on the tab
  const open = async (url) => {
    await strip.getByRole('button', { name: 'New tab', exact: true }).click();
    const field = bar.getByRole('textbox', { name: 'Website address' });
    await field.fill(url);
    await field.press('Enter');
    await page.locator('.browser-native-slot').waitFor();
  };
  await open(`${address}/page1`);
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'Site number 1');
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected img')?.src.startsWith('data:image/'), undefined, { timeout: 15_000 });
  assert.equal((await bar.locator('.browser-address-view').textContent()).trim(), `${address}/page1`, 'only the address');
  assert.equal(await bar.getByText('Site number 1').count(), 0, 'no title beside it');
  await page.waitForTimeout(500);
  assert.equal(await nativeVisible(), 1, 'the page is shown');
  const slotBox = await page.locator('.browser-native-slot').boundingBox();
  const viewBox = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.constructor.name === 'WebContentsView' && view.getVisible()).getBounds());
  for (const side of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(slotBox[side] - viewBox[side]) <= 1, `the native page lies on its slot under the two rows (${side}: ${viewBox[side]} / ${slotBox[side]})`);
  await shot('03-website-light');

  // ---- the tabs share the room like Chrome's (one width, at most 200 px, at least 48 px, whole tabs only, "+" right
  // after the last tab or at the room's end); a click moves nothing; a close under the pointer moves nothing
  const widthAlone = await page.locator('.browser-strip-tab').first().boundingBox();
  assert.ok(widthAlone.width <= 200.5, `one tab: at most 200 px (${widthAlone.width})`);
  await page.mouse.move(640, 600); // off the strip: its widths follow the tabs
  for (const n of [2, 3, 4, 5, 6]) await open(`${address}/page${n}`);
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'Site number 6');
  await page.mouse.move(640, 600);
  await page.waitForTimeout(200);
  const tabBoxes = await page.evaluate(() => {
    const view = document.querySelector('.browser-strip-tabs').getBoundingClientRect();
    return [...document.querySelectorAll('.browser-strip-tab')].map((tab) => { const box = tab.getBoundingClientRect(); return { width: box.width, right: box.right, inView: box.right > view.left + 1 && box.left < view.right - 1, whole: box.left >= view.left - 1 && box.right <= view.right + 1 }; });
  });
  const sixWidth = tabBoxes[0].width;
  assert.ok(tabBoxes.every((box) => Math.abs(box.width - sixWidth) < 0.5), `one width for every tab: ${tabBoxes.map((box) => box.width)}`);
  assert.ok(sixWidth >= 47.5 && sixWidth <= widthAlone.width + 0.5, `between 48 px and the width of one tab alone (${sixWidth} / ${widthAlone.width})`);
  assert.ok(tabBoxes.filter((box) => box.inView).every((box) => box.whole), `whole tabs only: ${JSON.stringify(tabBoxes)}`);
  const plusAfter = await page.locator('.global-pane .browser-strip-new').boundingBox();
  const lastInView = Math.max(...tabBoxes.filter((box) => box.inView).map((box) => box.right));
  assert.ok(plusAfter.x - lastInView >= 0 && plusAfter.x - lastInView <= 4, `"+" right after the last tab in view (${plusAfter.x} / ${lastInView})`);
  assert.ok(plusAfter.x + plusAfter.width <= workspace.x, '"+" still before the Browser cell');
  const selectedInView = await page.evaluate(() => { const view = document.querySelector('.browser-strip-tabs').getBoundingClientRect(); const box = document.querySelector('.browser-strip-tab.selected').getBoundingClientRect(); return box.left >= view.left - 1 && box.right <= view.right + 1; });
  assert.ok(selectedInView, 'the new tab shows');
  const cells = ['.browser-strip', '.browser-strip-tabs', '.browser-bar', '.browser-native-slot', '.browser-strip [aria-label="New tab"]'];
  const visibleTabs = page.locator('.browser-strip-tab');
  const count = await visibleTabs.count();
  const other = visibleTabs.nth(count - 2);
  // beside the caption controls these are narrow tabs (icon only): selecting one moves no tab, no icon and no × cell
  if (overlay) assert.ok(sixWidth < 72, `narrow tabs in the row (${sixWidth})`);
  const tabParts = (await visibleTabs.evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab)))
    .flatMap((id) => ['', ' .browser-tab-icon', ' .browser-strip-close'].map((part) => `.browser-strip-tab[data-tab="${id}"]${part}`));
  await other.locator('[role=tab]').hover();
  await expectStable(page, [...cells, ...tabParts], () => other.locator('[role=tab]').click());
  await shot('04-many-tabs-light');
  await scheme('dark'); await shot('05-many-tabs-dark'); await scheme('light');
  const last = visibleTabs.nth(count - 1);
  const lastId = await last.getAttribute('data-tab');
  await other.hover();
  const closing = other.locator('.browser-strip-close');
  await expectStable(page, ['.browser-strip', `.browser-strip-tab[data-tab="${lastId}"]`], async () => { await closing.click(); await page.waitForTimeout(150); });
  assert.equal(await page.locator('.browser-strip-ghost').count(), 1, 'a closed tab keeps its place while the pointer is on the strip');
  const plus = page.locator('.global-pane .browser-strip-new');
  const plusHeld = await plus.boundingBox();
  await plus.hover();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.browser-strip-ghost').count(), 1, 'from a tab to "+" the strip is still held');
  assert.deepEqual(await plus.boundingBox(), plusHeld, '"+" does not move under the pointer');
  await bar.hover();
  await page.waitForFunction(() => !document.querySelector('.browser-strip-ghost'));

  // ---- right click on a tab: the same menu as the list
  await page.locator('.browser-strip-tab.selected').click({ button: 'right' });
  const context = page.getByRole('menu').last();
  await context.getByRole('menuitem', { name: 'Close others' }).waitFor();
  await context.getByRole('menuitem', { name: 'Copy address' }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await nativeVisible(), 0, 'the native page hides under a menu that lies over it');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.popover'));
  await page.waitForTimeout(300);
  assert.equal(await nativeVisible(), 1, 'and comes back');

  // ---- the address row's menu: over the page, and Full view
  await bar.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Find in page' }).waitFor();
  await shot('06-menu-open-light');
  const stripBefore = await page.locator('.global-pane .browser-strip').boundingBox();
  await page.getByRole('menuitem', { name: 'Full view' }).click();
  await page.locator('.app-frame.pane-full').waitFor();
  await page.waitForTimeout(300);
  const fullBox = await page.locator('.global-pane').boundingBox();
  const mainBox = await page.locator('.main-slot').boundingBox();
  assert.ok(Math.abs(fullBox.x - mainBox.x) < 2, 'full view covers the main zone');
  assert.deepEqual(await page.locator('.global-pane .browser-strip').boundingBox(), stripBefore, 'the strip stays in the row where it was');
  const headerReached = await page.evaluate(() => {
    const box = document.querySelector('.main-slot .chat-header .frame-header-title').getBoundingClientRect();
    return Boolean(document.elementFromPoint(box.left + 10, box.top + box.height / 2)?.closest('.chat-header'));
  });
  assert.ok(headerReached, 'the chat\'s row beside the strip still shows and takes clicks');
  await shot('07-full-view-light');
  await bar.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Exit full view' }).click();
  await page.waitForFunction(() => !document.querySelector('.app-frame.pane-full'));
  // the pane back at its default width (its divider's double-click): a width change may put the strip under the row again
  await resize.dispatchEvent('dblclick');
  await page.waitForFunction(() => !document.querySelector('.app-frame.strip-in-row'));

  // ---- panels are tabs: each takes the blank tab's place
  const panel = async (name, check) => {
    await strip.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.locator('.new-tab-row', { hasText: name }).first().click();
    await check();
  };
  await panel('My day', () => page.locator('.day-panel').waitFor());
  assert.equal(await shown(), 'My day');
  assert.equal(await page.locator('.browser-strip-tab[data-tab^="web-"] ~ .browser-strip-tab', { hasText: 'New tab' }).count(), 0, 'no blank tab stays behind');
  assert.equal((await bar.locator('.browser-address').textContent()).trim(), 'My day');
  assert.equal(await nativeVisible(), 0, 'no native page over a panel');
  await shot('08-my-day-light');
  await scheme('dark'); await shot('09-my-day-dark'); await scheme('light');
  await panel('Work', () => page.locator('.pane-work').waitFor());
  assert.equal(await shown(), 'Work');
  await shot('10-work-light');
  await scheme('dark'); await shot('11-work-dark'); await scheme('light');
  const workRow = page.locator('.pane-work .task-row').first();
  if (await workRow.count()) {
    await workRow.click();
    await page.locator('.pane-work .tasks-detail').waitFor();
    await shot('12-work-detail-light');
    await page.locator('.pane-work .task-detail-close').click();
  }
  await panel('Notes', () => page.locator('.pane-notes-field').waitFor());
  // B-078 (T6b): Screen and Activity left the new-tab list
  await strip.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.locator('.new-tab-row', { hasText: 'Agents' }).click();
  await page.locator('.new-tab-head').waitFor();
  await shot('13-agents-list-light');
  await page.locator('.new-tab-row', { hasText: agents[0].name }).click();
  await page.locator('.global-pane .browser-live-toolbar').waitFor();
  assert.equal(await shown(), `${agents[0].name}'s browser`);
  assert.equal(await page.locator('.global-pane .browser-bar').count(), 0, 'the agent browser\'s own toolbar in the address row\'s place');
  await page.locator('.browser-live-toolbar').getByRole('button', { name: 'Browser menu' }).click(); // also while the agent's browser is closed
  await page.getByRole('menuitem', { name: 'Full view' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.popover'));
  await shot('14-agent-browser-light');
  await scheme('dark'); await shot('15-agent-browser-dark'); await scheme('light');

  // ---- the agent's right-click menu opens the same tab
  await strip.locator('.browser-strip-tab.selected .browser-strip-close').click();
  await page.evaluate((id) => { location.hash = `#/team/${id}`; }, agents[0].id);
  const nameInTree = page.locator('.sidebar').getByText(agents[0].name, { exact: true }).first();
  await nameInTree.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in side panel' }).click();
  await page.locator('.global-pane .browser-live-toolbar').waitFor();
  assert.equal(await shown(), `${agents[0].name}'s browser`);

  // ---- the chat's own way in lands in its area above the messages (Chat details › Notes); the global pane keeps its tabs
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, first.id);
  await page.locator('textarea.composer-input').waitFor();
  const paneTabs = () => page.locator('.global-pane .browser-strip-tab').evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tab));
  const globalTabs = await paneTabs();
  const area = page.locator('.chat-area');
  const areaCell = page.locator('.chat-header [data-cell="browser"] button');
  await page.locator('.chat-title-button').click();
  await page.locator('.chat-panel .details-notes').click();
  await area.locator('.pane-notes-field').waitFor();
  assert.equal(await area.locator('.browser-strip-tab.selected').getAttribute('data-tab'), `notes:${first.id}`);
  assert.deepEqual(await paneTabs(), globalTabs, 'the global pane keeps its tabs');
  assert.equal(await areaCell.getAttribute('aria-pressed'), 'true', 'the chat\'s cell shows its area open');
  await page.locator('.chat-title-button').click();
  await page.locator('.chat-panel').waitFor({ state: 'detached' });
  await shot('15b-chat-area-notes-light');
  await scheme('dark'); await shot('15c-chat-area-notes-dark'); await scheme('light');

  // ---- full view per surface: the area takes its column above the composer, the global pane stays as it is
  const paneBox = await page.locator('.global-pane').boundingBox();
  await area.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Full view' }).click();
  await page.locator('.chat-column.area-full').waitFor();
  assert.equal(await page.locator('.app-frame.pane-full').count(), 0, 'only the area\'s surface');
  assert.equal(await page.locator('.chat-column .message-scroller').isVisible(), false, 'the messages lie under it');
  assert.ok(await page.locator('.chat-column .composer').isVisible(), 'the composer stays');
  assert.deepEqual(await page.locator('.global-pane').boundingBox(), paneBox);
  await shot('15d-chat-area-full-light');
  await area.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Exit full view' }).click();
  await page.waitForFunction(() => !document.querySelector('.chat-column.area-full'));
  await areaCell.click();
  await area.waitFor({ state: 'detached' });

  // ---- 640 × 480: the phone layout, the chat's area above the composer, the same strip
  await size(640, 480);
  await page.waitForSelector('.mobile-shell');
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, first.id);
  await page.locator('.mobile-shell textarea.composer-input').waitFor();
  await page.locator('.mobile-shell [data-cell="workspace"] button').click();
  const small = page.locator('.mobile-shell .chat-area .browser-strip');
  await small.waitFor();
  assert.ok(await page.locator('.mobile-shell .composer').isVisible(), 'the composer stays under the area');
  await shot('16-area-640x480-light');
  await scheme('dark'); await shot('17-area-640x480-dark'); await scheme('light');
  await small.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.locator('.mobile-shell .chat-area .new-tab').waitFor();
  await shot('18-area-new-tab-640x480-light');
  await scheme('dark'); await shot('19-area-new-tab-640x480-dark'); await scheme('light');
  // no global pane in this layout: the address field offers none of its tabs (its sites are still open) to switch to
  const smallField = page.locator('.mobile-shell .chat-area').getByRole('textbox', { name: 'Website address' });
  await smallField.fill('127.0.0.1');
  await page.locator('.mobile-shell .chat-area .browser-suggestions').waitFor();
  assert.equal(await page.locator('.browser-suggestion-note', { hasText: 'Switch to this tab' }).count(), 0, 'no switch to a tab nobody can see here');
  await smallField.press('Escape');
  await page.locator('.mobile-shell [data-cell="workspace"] button').click();
  await page.locator('.chat-area').waitFor({ state: 'detached' });

  await size(1280, 800);
  assert.deepEqual(errors, [], 'no renderer errors');
  t.diagnostic(`screenshots: ${out}`);
});
