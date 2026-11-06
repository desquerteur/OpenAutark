// Real Electron check of the owner's standing rule (25.10.2026, B-044 §2): "Ich mag nicht, dass sich
// da irgendwas bewegt … Alles bleibt 100 Prozent gerade" – a click marks its button and nothing else
// moves. Demo engine, isolated profile; every step measures the neighbours before and after
// (test/ui/lib/stable.mjs expectStable):
//   * Search chats and Search the team: the field takes the title's place in the side header row,
//     the magnifier keeps its cell, no row is inserted and the sidebar never scrolls sideways;
//   * switching My day ↔ Team ↔ Chats in the rail: rail, side header row, main zone and the workspace
//     cell keep their boxes;
//   * the workspace cell and the chat's header cells: one place whether the pane is open or closed;
//   * an open side panel keeps the message list at the newest message;
//   * opening the chat's details panel: it opens below the header row, no header cell moves;
//   * the chat's area (Chat tabs, its tabs above the messages): open and closed, no header cell and not the composer
//     moves, the list stays at the newest message, the cell only changes its pressed state;
//   * the composer's Ultra switch (beside the model chip): on and off change only its colour – the composer, its
//     action row and the message list keep their boxes;
//   * an agent starting work (the LiveLine in the fixed sub line); a status line (the emergency stop) lies over the
//     content instead of pushing it (the call cell's Talk → End voice: call-window.test.mjs);
//   * phone width: the top row's search swaps the title in place; its Browser cell pushes the global tabs as one sheet
//     over the stack (nothing under it moves) and the sheet's Close brings the same screen back.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.
// Owns: these window checks. Never: touches the person's profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('nothing moves: searches, rail, workspace cell, details panel, chat area, call cell, live line and notices', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-stability-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  await page.waitForTimeout(400);
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const agents = await rpc.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager');
  const other = agents.find((agent) => agent.id !== manager.id) ?? (await rpc.call('agents.create', { name: 'Ava' }));
  const chat = await rpc.call('chats.create', { title: 'Steady chat', agentIds: [manager.id, other.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, 'org', 'system'] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.chat-header [data-cell="call"]').waitFor({ timeout: 15_000 });
  const sideScroll = () => page.evaluate(() => [document.querySelector('.sidebar').scrollLeft, document.querySelector('.sidebar-body').scrollLeft]);

  // Search chats: the field replaces the title in place; the magnifier, "+ Chat" and the rows stay.
  const side = ['.sidebar .frame-header', '.sidebar .frame-header-title', '.sidebar [data-cell="search"]', '.sidebar .sidebar-action', '.sidebar .chat-rows', '.main-slot .chat-header'];
  await expectStable(page, side, () => page.getByRole('button', { name: 'Search chats' }).click());
  const field = page.locator('.sidebar .frame-header-search');
  assert.ok(await field.evaluate((element) => element === document.activeElement), 'the field has the focus');
  assert.deepEqual(await sideScroll(), [0, 0], 'the focus scrolled nothing sideways');
  assert.equal(await page.locator('.sidebar [data-cell="search"] button').getAttribute('aria-pressed'), 'true', 'the magnifier is marked');
  await expectStable(page, ['.sidebar .frame-header-title', '.sidebar [data-cell="search"]', '.sidebar .sidebar-action'], () => field.fill('Steady'));
  await shot('stable-01-search-chats');
  await expectStable(page, side.filter((selector) => selector !== '.sidebar .chat-rows'), () => page.keyboard.press('Escape'));
  assert.equal(await page.locator('.sidebar .frame-header-search').count(), 0, 'Esc closes the field');

  // Rail: My day ↔ Team ↔ Chats keep the rail, the side header row, the main zone and the workspace cell.
  // (the side header's title track may differ between views: each view has its own cells; the title starts at one place)
  const frame = ['.rail', '.rail-header', '.sidebar', '.sidebar .frame-header', '.main-slot', '.main-slot .frame-header', '.frame-workspace-cell'];
  const rail = (name) => page.locator('.rail').getByRole('button', { name, exact: true });
  await expectStable(page, frame, async () => { await rail('My day').click(); await page.locator('.day-view').waitFor(); });
  await expectStable(page, frame, async () => { await rail('Team').click(); await page.locator('.team-nav').waitFor(); });

  // Search the team: the same in-place swap.
  await expectStable(page, ['.sidebar .frame-header-title', '.sidebar [data-cell="search"]', '.sidebar .team-nav'],
    () => page.getByRole('button', { name: 'Search the team' }).click());
  assert.deepEqual(await sideScroll(), [0, 0], 'the focus scrolled nothing sideways');
  await page.keyboard.press('Escape');
  await expectStable(page, frame, async () => { await rail('Chats').click(); await page.locator('.chat-view').waitFor(); });

  // The workspace cell: one place, open (pressed) or closed – and the pane's tab strip never lies over the chat's own
  // cells, so they stay too (a second click hits the same cell). At its default width the pane leaves the row no room
  // for three titled tabs beside the caption controls: its strip is its first line under the row (strip-in-row: never
  // set or cleared by a click).
  const cell = page.locator('.frame-workspace-cell button');
  const head = ['.frame-workspace-cell', '.rail', '.sidebar .frame-header', '.chat-header', '.chat-header .chat-title-button', '.chat-header [data-cell="browser"]', '.chat-header [data-cell="call"]'];
  const atBottom = () => page.evaluate(() => { const el = document.querySelector('.message-scroller'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
  assert.equal(await atBottom(), true, 'the chat opens at the newest message');
  await expectStable(page, head, async () => { await cell.click(); await page.locator('.global-pane').waitFor(); });
  assert.equal(await cell.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.app-frame.strip-in-row').count(), 0, 'the default pane: its strip under the row, not cramped into it');
  const clear = await page.evaluate(() => document.querySelector('.chat-header [data-cell="browser"]').getBoundingClientRect().right <= document.querySelector('.global-pane').getBoundingClientRect().left + 0.5);
  assert.ok(clear, 'the chat\'s cells stay left of the pane');
  await page.waitForTimeout(100);
  assert.equal(await atBottom(), true, 'the narrower chat stays at the newest message');
  await shot('stable-02-workspace-open');
  await expectStable(page, head, async () => { await cell.click(); await page.locator('.global-pane').waitFor({ state: 'detached' }); });
  assert.equal(await cell.getAttribute('aria-pressed'), 'false');

  // The details panel opens below the header row: no header cell moves.
  const cells = ['.chat-header', '.chat-header .chat-title-button', '.chat-header [data-cell="browser"]', '.chat-header [data-cell="call"]', '.frame-workspace-cell', '.sidebar .frame-header'];
  await expectStable(page, cells, async () => { await page.locator('.chat-title-button').click(); await page.locator('.chat-panel').waitFor(); });
  await shot('stable-03-details-open');
  await expectStable(page, cells, async () => { await page.locator('.chat-title-button').click(); await page.locator('.chat-panel').waitFor({ state: 'detached' }); });

  // The chat's area opens above the messages in one fixed height: the header cells and the composer stay where they are.
  const tabsCell = page.locator('.chat-header [data-cell="browser"] button');
  const steady = [...cells, '.composer', '.composer-area'];
  assert.equal(await tabsCell.getAttribute('aria-label'), 'Chat tabs');
  await expectStable(page, steady, async () => { await tabsCell.click(); await page.locator('.chat-area .browser-strip').waitFor(); });
  assert.equal(await tabsCell.getAttribute('aria-pressed'), 'true');
  await page.waitForTimeout(100);
  assert.equal(await atBottom(), true, 'the shorter list stays at the newest message');
  assert.equal(await page.locator('.chat-column > .chat-area:first-child').count(), 1, 'the first part of the chat column');
  await shot('stable-03c-chat-area-open');
  await expectStable(page, steady, async () => { await tabsCell.click(); await page.locator('.chat-area').waitFor({ state: 'detached' }); });
  assert.equal(await tabsCell.getAttribute('aria-pressed'), 'false');

  // The Ultra switch beside the model chip: on and off change only its colour.
  const composerRow = ['.composer', '.composer-actions', '.composer .composer-plus', '.composer .ultra-switch',
    '.composer .model-chip', '.composer .send-button', '.message-scroller', '.chat-header'];
  const ultra = page.locator('.composer .ultra-switch');
  for (const on of ['true', 'false']) {
    await expectStable(page, composerRow, async () => {
      await ultra.click();
      await page.locator(`.composer .ultra-switch[aria-checked="${on}"]`).waitFor({ timeout: 5_000 });
    });
    if (on === 'true') await shot('stable-03b-ultra-on');
  }

  // An agent starts working: the live line fills the reserved sub line; the title stays.
  const working = rpc.waitFor('agent.activity', (event) => event.active.some((run) => run.conversationId === chat.id), 30_000);
  await expectStable(page, cells, async () => {
    await rpc.call('messages.send', { conversationId: chat.id, body: 'Keep going [[hang:bash]]' });
    await working;
    await page.locator('.chat-header .chat-live').waitFor({ timeout: 15_000 });
  });
  await shot('stable-05-live-line');
  // A status line (the emergency stop) lies over the top of the main zone: nothing is pushed.
  const content = [...cells, '.message-scroller', '.composer'];
  const stopped = rpc.waitFor('work.state', (state) => state.stopped === true, 15_000);
  const stopLine = page.locator('.status-host .status-note[data-notice="work-stop"]');
  await expectStable(page, content, async () => { await rpc.call('work.stop'); await stopped; await stopLine.waitFor({ timeout: 10_000 }); });
  await shot('stable-06-notice');
  const resumed = rpc.waitFor('work.state', (state) => state.stopped === false, 15_000);
  await expectStable(page, content, async () => {
    await stopLine.getByRole('button', { name: 'Resume' }).click();
    await resumed;
    await stopLine.waitFor({ state: 'detached', timeout: 10_000 });
  });

  // Phone width: the Chats tab's top row swaps its title for the search in place. The open chat is a
  // pushed screen there (its own top row with Back, no tab bar – shell/views.ts): Back first.
  await size(420, 860);
  await page.locator('.mobile-shell.pushed').waitFor();
  await page.locator('.chat-header [data-cell="back"]').getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.tab-bar').getByRole('button', { name: 'Chats', exact: true }).click();
  await page.locator('.mobile-main .chat-list').waitFor();
  const top = ['.mobile-top', '.mobile-top .frame-header-title', '.mobile-top [data-cell="search"]', '.mobile-top [data-cell="profile"]', '.mobile-main', '.tab-bar'];
  await expectStable(page, top, () => page.locator('.mobile-top').getByRole('button', { name: 'Search chats' }).click());
  await shot('stable-07-phone-search');
  await expectStable(page, top, () => page.keyboard.press('Escape'));
  // The global tabs on the phone: the row's Browser cell (desktop app) pushes them as one sheet over the whole stack.
  const stack = ['.mobile-top', '.mobile-top [data-cell="browser"]', '.mobile-main', '.tab-bar'];
  await expectStable(page, stack, async () => {
    await page.locator('.mobile-top [data-cell="browser"] button').click();
    await page.locator('.mobile-shell > .phone-pane .browser-strip').waitFor();
  });
  const [sheet, screen] = await page.evaluate(() => [document.querySelector('.mobile-shell > .phone-pane').getBoundingClientRect().toJSON(), { width: innerWidth, height: innerHeight }]);
  assert.ok(sheet.x === 0 && sheet.y === 0 && Math.abs(sheet.width - screen.width) < 1 && Math.abs(sheet.height - screen.height) < 1, `the sheet covers the screen (${JSON.stringify(sheet)})`);
  await shot('stable-08-phone-browser');
  await expectStable(page, stack, async () => {
    await page.locator('.phone-pane > .frame-header').getByRole('button', { name: 'Close browser', exact: true }).click();
    await page.locator('.phone-pane').waitFor({ state: 'detached' });
  });
  await size(1280, 820);

  assert.deepEqual(errors, [], 'no renderer exceptions');
  t.diagnostic(`screenshots: ${shots}`);
});
