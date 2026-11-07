// AF-010, real Electron: a chat's tabs dock. The agent opens a page in its chat (browser.show): the chat's tabs open
// docked right of the messages (data-tour="side-panel"), the native page on its slot inside them; the grip on their edge
// sizes them; dragging the grip cell to the chat's bottom edge docks them there, to its middle floats them as a window
// of their own, the grip cell's menu docks them left; every change lands in settings.json › appearance.chatDock and
// stays after a restart, where the page shows inside the dock again. Tabs drag to a new place in their strip and onto the
// person's pane (and back by the tab menu); side-tabs.json follows. Screenshots light and dark: SCREENSHOTS names the
// folder. A temp profile, the demo engine, a local fixture server, no real sites.
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
/** settings.json without its comments (the app writes JSON with a comment line above every key). */
const settingsOf = async (profile) => {
  const text = await readFile(path.join(profile, 'settings.json'), 'utf8');
  return JSON.parse(text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n').replace(/,(\s*[}\]])/g, '$1'));
};

test('a chat\'s tabs dock right, move by drag, float, size and stay after a restart', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autark-dock-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const name = decodeURIComponent(req.url.slice(1)) || 'home';
    res.end(`<title>${name}</title><style>body{font:18px system-ui;margin:0;padding:24px;background:#eef3ff;color:#123}</style><h1>${name}</h1><p>A page in the chat's tabs.</p>`);
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
    await page?.screenshot({ path: path.join(out, 'dock-last.png'), timeout: 5000 }).catch(() => {});
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
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1440, 900); });
    rpc?.close?.();
    const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
    rpc = await connect(info.port, info.token, 'cli');
  };
  await open();
  await rpc.call('settings.update', { onboarding: { step: 'done' }, preferences: { theme: 'light' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Research', agentIds: [manager.id] });

  const shot = async (name) => {
    await page.waitForTimeout(400);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (what, check, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) assert.fail(`waited for ${what}`);
      await sleep(150);
    }
  };
  const goChat = async () => {
    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    await page.locator('textarea.composer-input').waitFor();
  };
  const box = (selector) => page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  }, selector);
  /** The native pages on their slots now (address and box). */
  const shownPages = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
    .filter((view) => view.constructor.name === 'WebContentsView' && view.getVisible() && view.getBounds().width > 10)
    .map((view) => ({ url: view.webContents.getURL(), ...view.getBounds() })));
  const pageInside = async (selector, url) => until(`the page on its slot inside ${selector}`, async () => {
    const area = await box(selector);
    const shown = (await shownPages()).find((view) => view.url.startsWith(url));
    return area && shown && shown.x >= area.x - 1 && shown.x + shown.width <= area.right + 1 && shown.y >= area.y - 1 && shown.y + shown.height <= area.bottom + 1 ? shown : null;
  });
  const dockOf = async () => (await settingsOf(profile)).appearance?.chatDock;
  /** Drags with the mouse from the middle of `selector` to (x, y) in small steps (a real drag, past the 5 px start). */
  const drag = async (selector, x, y) => {
    const from = await box(selector);
    assert.ok(from, `${selector} is there`);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i += 1) {
      await page.mouse.move(from.x + from.width / 2 + ((x - from.x - from.width / 2) * i) / 12, from.y + from.height / 2 + ((y - from.y - from.height / 2) * i) / 12);
      await sleep(16);
    }
    await page.mouse.up();
  };

  // 1. The agent opens a page in its chat: the chat's tabs open docked right of the messages, the page inside them.
  await goChat();
  assert.equal(await page.locator('.chat-area').count(), 0, 'the chat\'s tabs start closed');
  const first = `${address}/First%20site`;
  await page.locator('textarea.composer-input').fill(`[[tool:browser.show {"url":"${first}","where":"chat"}]]`);
  await page.locator('button.send-button').click();
  await page.locator('.chat-body > .chat-area.dock-right[data-tour="side-panel"]').waitFor({ timeout: 30_000 });
  const column = await box('.chat-column');
  const right = await box('.chat-area');
  assert.ok(right.x >= column.right - 1, `docked right of the messages (${right.x} ≥ ${column.right})`);
  assert.ok(Math.abs(right.width - 480) <= 2, `at the default width (${right.width})`);
  assert.ok(Math.abs(right.y - 48) < 2, `right under the header row (${right.y})`);
  await pageInside('.chat-area', first);
  await shot('af010-01-dock-right-light');
  await rpc.call('settings.update', { preferences: { theme: 'dark' } });
  await shot('af010-02-dock-right-dark');
  await rpc.call('settings.update', { preferences: { theme: 'light' } });

  // 2. The grip on its inner edge sizes it: 120 px wider, saved once let go.
  await drag('.chat-area > .dock-resize', right.x - 120, right.y + 300);
  await until('the wider dock saved', async () => ((await dockOf())?.width ?? 0) >= 590);
  const wider = await box('.chat-area');
  assert.ok(Math.abs(wider.width - (await dockOf()).width) <= 2, `drawn at the saved width (${wider.width})`);

  // 3. The grip cell dragged to the chat's bottom edge: docked under the composer, the page follows.
  const body = await box('.chat-body');
  await drag('.chat-area > .dock-grip', body.x + body.width / 2, body.bottom - 12);
  await page.locator('.chat-column > .chat-area.dock-bottom').waitFor();
  await until('bottom saved', async () => (await dockOf())?.place === 'bottom');
  const composer = await box('.composer');
  const bottom = await box('.chat-area');
  assert.ok(bottom.y >= composer.bottom - 1, 'under the composer');
  await pageInside('.chat-area', first);
  await shot('af010-03-dock-bottom-light');

  // 4. Dragged to the middle: a floating window of its own at the drop point.
  await drag('.chat-area > .dock-grip', body.x + body.width / 2, body.y + body.height / 2 - 60);
  await page.locator('.chat-body > .chat-area.dock-float').waitFor();
  const floated = await until('float saved', async () => { const dock = await dockOf(); return dock?.place === 'float' ? dock : null; });
  const win = await box('.chat-area');
  assert.ok(Math.abs(win.x - body.x - floated.floatX) <= 2 && Math.abs(win.y - body.y - floated.floatY) <= 2, 'drawn where it was saved');
  await pageInside('.chat-area', first);
  await shot('af010-04-dock-float-light');
  await rpc.call('settings.update', { preferences: { theme: 'dark' } });
  await shot('af010-05-dock-float-dark');
  await rpc.call('settings.update', { preferences: { theme: 'light' } });

  // 5. The grip cell's menu: Dock left.
  await page.locator('.chat-area > .dock-grip').click();
  await page.getByRole('menuitemcheckbox', { name: 'Dock left' }).click();
  await page.locator('.chat-body > .chat-area.dock-left').waitFor();
  await until('left saved', async () => (await dockOf())?.place === 'left');
  await pageInside('.chat-area', first);

  // 6. Tabs: a second page, then the first dragged behind it; the order is in side-tabs.json.
  const second = `${address}/Second%20site`;
  await page.locator('textarea.composer-input').fill(`[[tool:browser.show {"url":"${second}","where":"chat","newTab":true}]]`);
  await page.locator('button.send-button').click();
  await until('two tabs', async () => (await page.locator('.chat-area .browser-strip-tab').count()) === 2);
  const space = `chat:${chat.id}`;
  const tabsFile = async () => JSON.parse(await readFile(path.join(profile, 'side-tabs.json'), 'utf8'));
  await until('both in the file', async () => (await tabsFile()).spaces?.[space]?.tabs?.length === 2);
  const before = (await tabsFile()).spaces[space].tabs.map((tab) => tab.url);
  const tabs = page.locator('.chat-area .browser-strip-tab');
  const secondBox = await tabs.nth(1).boundingBox();
  await tabs.nth(0).dragTo(tabs.nth(1), { targetPosition: { x: secondBox.width - 8, y: secondBox.height / 2 } }); // past its middle: behind it
  await until('the order swapped in the file', async () => {
    const now = (await tabsFile()).spaces[space]?.tabs?.map((tab) => tab.url) ?? [];
    return now.length === 2 && now[0] === before[1] && now[1] === before[0];
  });

  // 7. A tab dragged onto the person's pane moves there with its page; the tab menu brings it back.
  await rpc.call('settings.update', { preferences: { workspaceOpen: true } });
  await page.locator('.global-pane .browser-strip').waitFor();
  const moving = page.locator('.chat-area .browser-strip-tab').first();
  const movingUrl = (await tabsFile()).spaces[space].tabs[0].url;
  await moving.dragTo(page.locator('.global-pane .browser-strip-tabs'));
  await until('the tab in the global space', async () => (await tabsFile()).spaces.global?.tabs?.some((tab) => tab.url === movingUrl));
  assert.equal((await tabsFile()).spaces[space].tabs.length, 1, 'it left the chat\'s tabs');
  await pageInside('.global-pane', movingUrl);
  await shot('af010-06-tab-moved-to-pane-light');
  await page.locator('.global-pane .browser-strip-tab', { hasText: decodeURIComponent(movingUrl.split('/').pop()) }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to this chat\'s tabs' }).click();
  await until('back in the chat', async () => (await tabsFile()).spaces[space]?.tabs?.length === 2);
  await rpc.call('settings.update', { preferences: { workspaceOpen: false } });

  // 8. Docked at the bottom again, 300 px high; after a restart the chat's tabs are there, at the bottom, the page inside.
  const body2 = await box('.chat-body');
  await drag('.chat-area > .dock-grip', body2.x + body2.width / 2, body2.bottom - 10);
  await until('bottom saved again', async () => (await dockOf())?.place === 'bottom');
  await page.locator('.chat-area.dock-bottom').waitFor();
  await page.locator('.chat-area > .dock-resize').focus();
  await page.keyboard.press('Home'); // the lowest height
  await until('the lowest height saved', async () => (await dockOf())?.height === 140);
  const saved = await dockOf();
  await app.close();
  app = await launch();
  await open();
  await goChat();
  await page.locator('.chat-column > .chat-area.dock-bottom').waitFor({ timeout: 30_000 });
  assert.deepEqual(await dockOf(), saved, 'the same dock after the restart');
  await sleep(1500); t.diagnostic(`after restart: dock=${await page.locator('.chat-area').getAttribute('data-dock')} file=${JSON.stringify(await dockOf())} pages=${JSON.stringify(await shownPages())} area=${JSON.stringify(await box('.chat-area'))}`);
  const shownTitle = await page.locator('.chat-area .browser-strip-tab.selected .browser-strip-title').textContent();
  await pageInside('.chat-area', `${address}/${encodeURIComponent(shownTitle).replace(/%20/g, '%20')}`);
  assert.ok(Math.abs((await box('.chat-area')).height - 140) <= 2, 'at its saved height');
  await shot('af010-07-after-restart-light');
  assert.deepEqual(errors, [], 'no renderer exceptions');
  t.diagnostic(`screenshots: ${out}`);
});
