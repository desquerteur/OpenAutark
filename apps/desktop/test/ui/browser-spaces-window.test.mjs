// Real Electron: the browser per chat, in the chat's area above its messages. An agent in a group chat calls browser.open
// where:chat; the person opens that chat's area (Chat tabs in the chat header) and sees the tab live while the global
// pane beside it shows its own page – two native pages at once; another agent in the same chat lists and uses the same
// tab; the global pane shows only global tabs and never changes by itself; an agent's tab in a closed area lights the
// chat's cell, browser.show opens the area; an agent clicks in a tab nobody looks at and works with the window closed
// (snapshot, click, eval, screenshot) on the host window, and a new window shows that page with its state; the host goes
// when no agent used a page for a while; at most MAX_LIVE pages stay loaded; an edit of side-tabs.json reaches the
// window; all of it survives a restart, and the old workspace-tabs.json moves over. Screenshots: SCREENSHOTS names the
// folder. A temp profile, the demo engine, a local fixture server, no real sites.
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

test('a browser per chat: shared tabs, global untouched, agents with the window closed, survives a restart', { timeout: 480_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-spaces-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const name = decodeURIComponent(req.url.slice(1)) || 'home';
    res.end(`<title>${name}</title><style>body{font:18px system-ui;padding:24px;background:#f3f6ff}</style><h1>${name}</h1><button onclick="document.title='clicked '+document.title">Press</button>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;

  // An old profile's flat list: it moves over once.
  await writeFile(path.join(profile, 'workspace-tabs.json'), JSON.stringify({ version: 1, tabs: [{ id: 'web-old-global', url: `${address}/Old%20global` }] }));

  const launch = () => electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', WORKFORCE_TAB_IDLE_MS: '30000' },
  });
  let app = await launch();
  let rpc;
  t.after(async () => {
    await page?.screenshot({ path: path.join(out, 'last.png'), timeout: 5000 }).catch(() => {});
    rpc?.close?.();
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
  const lena = await rpc.call('agents.create', { name: 'Lena', role: 'Researcher', managerId: manager.id });
  const group = await rpc.call('chats.create', { title: 'Launch group', agentIds: [manager.id, lena.id] });
  await rpc.call('chats.update', { id: group.id, settings: { mode: 'browser' } });
  const other = await rpc.call('chats.create', { title: 'Other chat', agentIds: [manager.id] });
  await rpc.call('chats.update', { id: other.id, settings: { mode: 'browser' } });

  const step = (line) => appendFileSync(path.join(out, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const shot = async (name) => {
    step(`shot ${name}`);
    await page.waitForTimeout(300);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const file = async () => JSON.parse(await readFile(path.join(profile, 'side-tabs.json'), 'utf8'));
  /** A surface: '.global-pane' (the person's own, global tabs) or '.chat-area' (the open chat's tabs above its messages). */
  const PANE = '.global-pane';
  const AREA = '.chat-area';
  const stripTitles = (where) => page.locator(`${where} .browser-strip-title`).allTextContents();
  const shownTitle = (where) => page.locator(`${where} .browser-strip-tab.selected .browser-strip-title`).textContent();
  const waitShown = (where, title) => page.waitForFunction(([scope, expected]) => document.querySelector(`${scope} .browser-strip-tab.selected .browser-strip-title`)?.textContent === expected, [where, title], { timeout: 30_000 });
  const areaCell = () => page.locator('.chat-header [data-cell="browser"] button').first();
  /** Opens the open chat's area unless it is open already (kept per chat on this device). */
  const openArea = async () => {
    if ((await areaCell().getAttribute('aria-pressed')) !== 'true') await areaCell().click();
    await page.locator(`${AREA} .browser-strip`).waitFor();
  };
  const goChat = async (id) => {
    await page.evaluate((value) => { location.hash = `#/chat/${value}`; }, id);
    await page.locator('textarea.composer-input').waitFor();
  };
  /** The URLs of the native pages shown now, on their slots. */
  const shownPages = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
    .filter((view) => view.constructor.name === 'WebContentsView' && view.getVisible() && view.getBounds().width > 10).map((view) => view.webContents.getURL()));
  const loaded = () => app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(prefix)).map((contents) => contents.getURL()), address);
  const until = async (what, check, ms = 45_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) assert.fail(`waited for ${what}`);
      await sleep(150);
    }
  };
  /** Sends one agent the directives; returns its answer's text once the turn ended. */
  const agentDoes = async (chat, agent, body) => {
    step(`${agent.name}: ${body.slice(0, 120)}`);
    const sent = await rpc.call('messages.send', { conversationId: chat.id, body: `@${agent.name} ${body}`, mentions: [agent.id] });
    return until(`${agent.name}'s answer`, async () => {
      const messages = await rpc.call('messages.list', { conversationId: chat.id, limit: 30 });
      const answer = messages.find((message) => message.authorId === agent.id && message.seq > sent.seq && message.body && message.state === 'final')?.body;
      if (answer) step(`  → ${answer.replace(/\s+/g, ' ').slice(0, 400)}`);
      return answer;
    });
  };

  // ---- the moved file, the pane on global
  assert.equal((await file()).version, 2, 'side-tabs.json replaces workspace-tabs.json');
  assert.deepEqual((await file()).spaces.global.tabs.map((tab) => tab.id), ['web-old-global']);
  await assert.rejects(readFile(path.join(profile, 'workspace-tabs.json')), 'the old file is gone');
  const cell = page.locator('.frame-workspace-cell button');
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click();
  await page.locator(`${PANE} .browser-strip`).waitFor();
  await page.locator(`${PANE} .browser-strip-tab`, { hasText: /Old global|127\.0\.0\.1/ }).first().locator('.browser-strip-choose').click();
  await waitShown(PANE, 'Old global');
  const global = { titles: await stripTitles(PANE), shown: await shownTitle(PANE), file: (await file()).spaces.global };
  await shot('01-global');

  // ---- an agent in the group chat opens a tab there: it waits in the chat's space, global does not notice
  // (newTab: the shared tab this test follows is a tab of its own – as the Manager's preview tab its next page, e.g. an
  // echo of Lena's open below, would take it over, main/workspace-marks.ts.)
  await goChat(other.id);
  const opened = await agentDoes(group, manager, `[[tool:browser.open {"url":"${address}/Shared%20page","where":"chat","newTab":true}]]`);
  assert.match(opened, /browser\.open → Tab web-/, opened.slice(0, 300));
  await until('the page to load', async () => (await loaded()).includes(`${address}/Shared%20page`));
  const space = `chat:${group.id}`;
  const inFile = await until('the file to hold the chat tab', async () => (await file()).spaces[space]);
  const sharedTab = inFile.tabs[0];
  assert.equal(sharedTab.url, `${address}/Shared%20page`);
  assert.equal(sharedTab.by, manager.id, 'the tab names the agent that opened it');
  assert.deepEqual(await stripTitles(PANE), global.titles, 'global tabs are untouched');
  assert.equal(await shownTitle(PANE), global.shown, 'and it shows what it showed');
  assert.deepEqual((await file()).spaces.global, global.file, 'in the file too');

  // ---- the person opens that chat's area and sees the tab live on its native page, the global page beside it
  await goChat(group.id);
  assert.deepEqual(await stripTitles(PANE), global.titles, 'the global pane shows only global tabs');
  await expectStable(page, [`${PANE} .browser-strip [aria-label="New tab"]`, `${PANE} .browser-bar`, '.chat-header [data-cell="call"]', '.chat-header [data-cell="browser"]', '.composer'],
    () => areaCell().click());
  await waitShown(AREA, 'Shared page');
  assert.deepEqual(await stripTitles(AREA), ['Shared page']);
  assert.equal(await shownTitle(PANE), global.shown, 'the global pane keeps its tab');
  const both = await until('both native pages to show', async () => { const urls = await shownPages(); return urls.length === 2 && urls; });
  assert.ok(both.includes(`${address}/Shared%20page`), `the chat's page: ${both.join(', ')}`);
  // the status line (lasting to-do toasts) lies over the top of the messages, under the open area – never on its tabs or page
  const [hostTop, areaBottom] = await page.evaluate((area) => [document.querySelector('.main-slot > .status-host').getBoundingClientRect().top, document.querySelector(area).getBoundingClientRect().bottom], AREA);
  assert.ok(hostTop >= areaBottom, `the status line starts under the chat's area (${hostTop} >= ${areaBottom})`);
  await shot('02-chat-area');

  // ---- another agent in the same chat lists and uses the same tab; the person sees it happen
  // (The demo engine runs every directive it has not heard yet, so each agent also repeats what the person asked the other: Lena's first turn opens a second tab, which goes again here, and a click may land twice.)
  const listed = await agentDoes(group, lena, '[[tool:browser.tabs {"where":"chat"}]] [[tool:browser.eval {"where":"chat","expression":"document.title = \'Used by Lena\'"}]]');
  assert.match(listed, new RegExp(`browser\\.tabs → [^]*${sharedTab.id}[^]*opened by ${manager.name}`), 'she sees the tab the Manager opened');
  await waitShown(AREA, 'Used by Lena');
  const repeated = (await file()).spaces[space].tabs.filter((tab) => tab.id !== sharedTab.id);
  for (const tab of repeated) await agentDoes(group, lena, `[[tool:browser.tabs {"close":"${tab.id}","where":"chat"}]]`);
  await until('one shared tab', async () => (await file()).spaces[space].tabs.length === 1);

  // ---- an agent really clicks in a tab nobody looks at, with the window open: the person stays on what they see
  await goChat(other.id);
  await page.locator(AREA).waitFor({ state: 'detached' }); // the other chat's area is closed: nobody looks at the shared page
  const snapshot = await agentDoes(group, lena, '[[tool:browser.snapshot {"where":"chat"}]]');
  const press = /button "Press"[^\n]*\[ref=(s\d+)\]/.exec(snapshot)?.[1];
  assert.ok(press, snapshot.slice(0, 400));
  const clicked = await agentDoes(group, lena, `[[tool:browser.act {"where":"chat","action":"click","ref":"${press}","motion":"instant"}]] [[size:browser.screenshot {"where":"chat"}]]`);
  assert.doesNotMatch(clicked, /did not answer|failed|"error":\s*true|cannot be captured/, clicked.slice(0, 600));
  assert.match(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.getTitle(), `${address}/Shared%20page`), /^(clicked )+Used by Lena$/, 'a real click landed');
  assert.equal(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter((win) => win.isVisible() && win.getOpacity() === 0).length), 1, 'on the one invisible host');
  await goChat(group.id);
  await page.waitForFunction(() => /Used by Lena$/.test(document.querySelector('.chat-area .browser-strip-tab.selected .browser-strip-title')?.textContent ?? ''), undefined, { timeout: 30_000 }); // its area stayed open for this chat
  await until('the page back in the window', async () => (await shownPages()).includes(`${address}/Shared%20page`));
  await shot('02b-after-agent-click');

  // ---- the person clicks directly in the area's address row: a new tab joins this chat, not global
  await page.locator(`${AREA} .browser-strip`).getByRole('button', { name: 'New tab', exact: true }).click();
  const field = page.locator(`${AREA} .browser-bar`).getByRole('textbox', { name: 'Website address' });
  await field.fill(`${address}/Mine%20in%20chat`);
  await field.press('Enter');
  await waitShown(AREA, 'Mine in chat');
  await until('the file to hold it', async () => (await file()).spaces[space]?.tabs.length === 2);
  assert.deepEqual((await file()).spaces.global.tabs.map((tab) => tab.id), global.file.tabs.map((tab) => tab.id));
  assert.deepEqual(await stripTitles(PANE), global.titles, 'the global pane beside it is untouched');

  // ---- another chat's area: an empty space shows the new-tab page, and the file stays clean; the global pane never changes by itself
  await goChat(other.id);
  await openArea();
  await page.locator(`${AREA} .new-tab`).waitFor();
  assert.equal((await file()).spaces[`chat:${other.id}`], undefined, 'a blank tab goes nowhere');
  assert.equal(await shownTitle(PANE), 'Old global', 'global never changes by itself');
  await shot('03-other-chat-area');
  await areaCell().click(); // closed again: the next agent tab waits there with a dot
  await page.locator(AREA).waitFor({ state: 'detached' });
  await goChat(group.id);
  await waitShown(AREA, 'Mine in chat');

  // ---- with the pane closed another chat opening lights nothing: its agents' old tabs are no new tabs
  const dot = page.locator('.frame-workspace-cell .frame-header-badge.dot');
  const areaDot = page.locator('.chat-header [data-cell="browser"] .frame-header-badge.dot');
  await cell.click();
  await goChat(other.id);
  await page.waitForTimeout(300);
  assert.equal(await dot.count(), 0, 'no dot on a chat switch');
  assert.equal(await areaDot.count(), 0, 'nor on the chat\'s cell');
  await cell.click();
  await waitShown(PANE, 'Old global');

  // ---- an agent's new tab in the open chat while its area is closed: the chat's cell gets the dot; opening the area puts it out
  await agentDoes(other, manager, `[[tool:browser.open {"url":"${address}/Waiting%20here","where":"chat"}]]`);
  await areaDot.waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(AREA).count(), 0, 'nothing opens by itself');
  await shot('03b-chat-cell-dot');
  await openArea();
  await areaDot.waitFor({ state: 'detached' });
  await areaCell().click();
  await page.locator(AREA).waitFor({ state: 'detached' });

  // ---- browser.show from the open chat opens its area at once and shows the page there
  await agentDoes(other, manager, `[[tool:browser.show {"url":"${address}/Shown%20here"}]]`);
  await waitShown(AREA, 'Shown here');
  assert.equal(await shownTitle(PANE), 'Old global', 'the global pane stays');
  assert.ok((await file()).spaces[`chat:${other.id}`].tabs.some((tab) => tab.url === `${address}/Shown%20here`));

  // ---- at most MAX_LIVE pages stay loaded across spaces; an agent's tab comes back when used
  // (newTab: six tabs of their own – without it each page would take the Manager's preview tab, main/workspace-marks.ts.)
  const many = Array.from({ length: 6 }, (_, n) => `[[tool:browser.open {"url":"${address}/Many%20${n}","where":"chat","newTab":true}]]`).join(' ');
  await agentDoes(other, manager, many);
  await until('the cap to hold', async () => (await loaded()).length <= 5);
  assert.ok((await file()).spaces[`chat:${other.id}`].tabs.length >= 7, 'the entries stay');

  // ---- an edit of the file reaches the window: a panel and a new website tab in global
  const edited = await file();
  edited.spaces.global.tabs.push({ id: 'day', panel: 'day' }, { id: 'web-from-file', url: `${address}/From%20file` });
  await writeFile(path.join(profile, 'side-tabs.json'), JSON.stringify(edited, null, 1));
  await until('the file\'s tabs in the strip', async () => (await page.locator(`${PANE} .browser-strip-tab`).count()) === global.titles.length + 2);
  assert.ok(await page.locator(`${PANE} .browser-strip-tab[data-tab="day"]`).count());
  assert.ok(await page.locator(`${PANE} .browser-strip-tab[data-tab="web-from-file"]`).count());
  await shot('04-after-file-edit');

  // ---- a page an agent works in opens another: it joins that chat in the background, the global pane stays as it is
  await agentDoes(other, manager, `[[tool:browser.eval {"where":"chat","expression":"window.open('${address}/Popup'); 1"}]]`);
  await until('the popup in the chat\'s tabs', async () => (await file()).spaces[`chat:${other.id}`].tabs.some((tab) => tab.url === `${address}/Popup`));
  await page.waitForTimeout(300);
  assert.equal(await page.locator(`${PANE} .browser-strip-tab`).count(), global.titles.length + 2, 'the global pane stays as it is');
  assert.equal(await page.locator(`${AREA} .browser-strip-tab[data-tab="day"]`).count(), 0, 'the chat\'s area does not get the global panel');

  // ---- the window closes: the tab an agent just used stays alive on the hidden host, and works
  await agentDoes(group, lena, `[[tool:browser.eval {"tab":"${sharedTab.id}","expression":"window.kept = 41; document.title"}]]`);
  assert.equal(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter((win) => win.isVisible() && win.getOpacity() === 0).length), 1, 'the host holds it');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await until('the window to close', () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0));
  await sleep(500);
  assert.ok((await loaded()).includes(`${address}/Shared%20page`), 'the page an agent works in stays');
  const closed = await agentDoes(group, lena, [
    `[[tool:browser.eval {"tab":"${sharedTab.id}","expression":"window.kept + 1"}]]`,
    `[[tool:browser.open {"url":"${address}/Opened%20while%20closed","where":"chat"}]]`,
    '[[tool:browser.snapshot {"where":"chat"}]]',
    '[[tool:browser.act {"where":"chat","action":"press","key":"Tab"}]]',
    '[[size:browser.screenshot {"where":"chat"}]]',
  ].join(' '));
  t.diagnostic(`with the window closed: ${closed.slice(0, 1200)}`);
  assert.doesNotMatch(closed, /"error":\s*(true|")|not available|window is closed|did not answer/, closed.slice(0, 800));
  assert.match(closed, /browser\.eval → [^]*42/, 'the same page, alive');
  const closedSnap = await agentDoes(group, lena, '[[tool:browser.snapshot {"where":"chat"}]]');
  const closedPress = /button "Press"[^\n]*\[ref=(s\d+)\]/.exec(closedSnap)?.[1];
  const closedClick = await agentDoes(group, lena, `[[tool:browser.act {"where":"chat","action":"click","ref":"${closedPress}","motion":"instant"}]]`);
  assert.doesNotMatch(closedClick, /did not answer|failed/, closedClick.slice(0, 500));
  await until('a real click with the window closed', async () => /^clicked /.test(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((contents) => contents.getURL() === url).map((contents) => contents.getTitle()).find((title) => title.startsWith('clicked')) ?? '', `${address}/Opened%20while%20closed`)));
  assert.ok((await loaded()).includes(`${address}/Opened%20while%20closed`));
  await until('the tab in the file', async () => (await file()).spaces[space].tabs.some((tab) => tab.url === `${address}/Opened%20while%20closed`));
  assert.equal(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter((win) => win.isVisible() && win.getOpacity() === 0).length), 1, 'one host holds the pages');

  // ---- a new window shows the page with its state; the host goes when no agent used a page for a while
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(({ app: electronApp }) => { electronApp.emit('second-instance', {}, []); });
  page = await nextWindow;
  page.setDefaultTimeout(20_000);
  watch(page);
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await goChat(group.id);
  await openArea();
  step(`new window: space tabs ${JSON.stringify(await stripTitles(AREA))}, file ${JSON.stringify((await file()).spaces[space])}`);
  // (The six pages above pushed this one out once – the cap – so an agent's use loaded it again: its own title is back.)
  await page.locator(AREA).getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'All tabs' }).click();
  await page.getByRole('menuitem', { name: /Shared page/ }).click();
  await waitShown(AREA, 'Shared page');
  const kept = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.executeJavaScript('window.kept'), `${address}/Shared%20page`);
  assert.equal(kept, 41, 'the same page, not a reloaded one');
  await shot('05-new-window');
  await until('the host to go', () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter((win) => win.isVisible() && win.getOpacity() === 0).length === 0), 90_000);
  assert.match(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.getTitle(), `${address}/Shared%20page`), /^Shared page$/, 'its pages stay loaded (the memory saver has its own time)');

  // ---- a restart: both spaces, panels, the shown tabs and who opened what come back; nothing loads until shown or used
  rpc.close(); rpc = undefined;
  const before = await file();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  watch(page);
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await reconnect();
  assert.deepEqual(Object.keys((await file()).spaces).sort(), Object.keys(before.spaces).sort());
  const restarted = (await file()).spaces[space];
  assert.equal(restarted.shown, before.spaces[space].shown, 'the shown tab comes back');
  assert.deepEqual(restarted.tabs.map((tab) => tab.id), before.spaces[space].tabs.map((tab) => tab.id), 'in the same order');
  await goChat(group.id);
  await openArea();
  await until('the chat\'s tabs', async () => (await page.locator(`${AREA} .browser-strip-tab`).count()) === before.spaces[space].tabs.length);
  assert.ok(await page.locator(`${AREA} .browser-strip-tab[data-tab="${sharedTab.id}"]`).count(), 'the shared tab is back');
  const after = await agentDoes(group, lena, '[[tool:browser.tabs {"where":"chat"}]]');
  assert.match(after, /opened by/, after.slice(0, 500));
  await shot('06-after-restart');

  assert.deepEqual(errors, [], 'no renderer errors');
  t.diagnostic(`screenshots: ${out}`);
});
