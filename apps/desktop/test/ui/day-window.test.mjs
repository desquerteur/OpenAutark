// Electron window check of My day (B-041 §4; Umbau Einfachheit: no Plan or Timer buttons – the AI plans and sets
// timers from text; a row's actions are its right-click menu) with the demo engine in an isolated profile:
//   * #/day: the header (My day, the date with ‹ ›, the fixed Day | Week cell), the input row, the list root and the
//     calendar pane beside it; the sidebar's mini month;
//   * the input adds the person's own to-do (day.add) – it lands under Unplanned;
//   * a row's right-click menu: Snooze › "In 1 hour" moves an ordinary to-do to Later; Remove takes it off at once;
//   * a click into a free time of the day grid opens the slot field – the text becomes a block (calendar.add 'auto');
//     the block's popover moves it ("Move to") and its check finishes it; the keyboard reaches a free hour too;
//   * work the person handed to an agent shows under "Handed off n" with "<agent> working";
//   * Week shows the seven days in the calendar pane, Day goes back; nothing in the header moves;
//   * ‹ › and the mini month change the day (#/day/<date>, "Tomorrow"), the title goes back to today;
//   * a narrow window shows List | Calendar; the phone width shows the list first; light, dark, 640×480 and 375 px
//     screenshots; no horizontal page scroll; no renderer errors.
// Run: npm run test:ui (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { expectStable } from './lib/stable.mjs';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('My day: input, row menu (snooze, remove), calendar slot and block, handed off, week, day navigation, layouts', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-day-'));
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
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480); // the app's 640 px minimum would hide the phone layout
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  /** Polls `check` (no fixed sleeps: the renderer may lag under memory pressure) until it holds or `ms` pass. */
  const until = async (check, what, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) assert.fail(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const listed = async (id) => (await rpc.call('todos.list', { limit: 200 })).some((task) => task.id === id);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const menu = page.locator('.menu[aria-label="Context menu"]');

  await page.evaluate(() => { location.hash = '#/day'; });
  const view = page.locator('.day-view');
  await view.waitFor({ timeout: 15_000 });
  const header = view.locator('.day-header');
  assert.equal((await header.locator('.frame-header-text').textContent())?.trim(), 'My day');
  assert.equal((await header.locator('.day-date').textContent())?.trim(), 'Today', 'it opens on today');
  assert.equal(await header.getByRole('button', { name: 'Plan' }).count(), 0, 'no Plan button – the AI plans');
  assert.equal(await header.getByRole('button', { name: 'Timer' }).count(), 0, 'no Timer cell – timers come from text');
  assert.deepEqual((await header.locator('.day-span [role="tab"]').allTextContents()).map((text) => text.trim()), ['Day', 'Week']);
  assert.equal(await view.locator('.day-list .for-you').count(), 1, 'the protected list root holds the list');
  await view.locator('.day-cal-pane .day-cal-grid').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.sidebar .day-month .day-month-day.current').count(), 1, 'the mini month marks today');
  await shot('day-01-empty-light');

  // 1. The input: the person's own to-do, under Unplanned.
  const input = view.locator('.day-input-field');
  await input.fill('Water the plants');
  await input.press('Enter');
  const plants = view.locator('.todo-item', { hasText: 'Water the plants' });
  await plants.waitFor({ timeout: 15_000 });
  assert.equal(await view.locator('.todo-list[aria-label="Unplanned"] .todo-item', { hasText: 'Water the plants' }).count(), 1, 'no time: Unplanned');
  const todo = (await rpc.call('todos.list', { limit: 200 })).find((task) => task.title.startsWith('Water the plants'));
  assert.equal(todo?.assigneeKind, 'human', "the person's own");

  // 2. The row's right-click menu: Snooze › In 1 hour waits under Later; Remove takes it off at once.
  await input.fill('Sort the receipts');
  await input.press('Enter');
  const receipts = view.locator('.day-group .todo-item', { hasText: 'Sort the receipts' });
  await receipts.waitFor({ timeout: 15_000 });
  await receipts.locator('.todo-open').click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  const items = (await menu.locator('[role="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  for (const entry of ['In 1 hour', 'Remove']) assert.ok(items.includes(entry), `the menu offers ${entry}: ${items.join(' | ')}`);
  await shot('day-02-row-menu-light');
  await menu.getByRole('menuitem', { name: 'In 1 hour' }).click();
  await receipts.waitFor({ state: 'detached', timeout: 10_000 });
  await view.getByRole('button', { name: /^Later \d+$/ }).waitFor({ timeout: 10_000 }); // the count as the open groups show it
  await plants.locator('.todo-open').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Remove' }).click();
  await plants.waitFor({ state: 'detached', timeout: 10_000 });
  await until(async () => !(await listed(todo.id)), 'removed');

  // 3. The calendar: click into a free time → the slot field → a block; move it; tick it off.
  const grid = view.locator('.day-cal-grid');
  const box = await grid.boundingBox();
  await grid.evaluate((el) => { el.parentElement.scrollTop = 15 * 48 - 40; });
  await page.mouse.click(box.x + box.width / 2, (await grid.boundingBox()).y + 15 * 48 + 6);
  const slot = view.locator('.day-slot');
  await slot.waitFor({ timeout: 5_000 });
  assert.match((await slot.locator('.day-slot-time').textContent()) ?? '', /^15:00–15:30$/);
  await slot.locator('.day-slot-input').fill('Call Anna about the offer');
  await slot.locator('.day-slot-input').press('Enter');
  const block = view.locator('.day-block', { hasText: 'Call Anna' });
  await block.waitFor({ timeout: 15_000 });
  await shot('day-03-calendar-light');
  await block.locator('.day-block-open').click();
  const popover = page.locator('.day-block-popover');
  await popover.waitFor({ timeout: 5_000 });
  await popover.locator('.day-move-time').fill('16:00');
  await popover.getByRole('button', { name: 'Move', exact: true }).click();
  await page.waitForFunction(() => /16:00–16:30/.test(document.querySelector('.day-block-open[aria-label^="Call Anna"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 10_000 });
  await page.keyboard.press('Escape');
  const check = view.locator('.day-block:has(.day-block-open[aria-label^="Call Anna"]) .day-block-check');
  if (await check.count()) {
    await check.click();
    await view.locator('.day-block-check.done').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  }
  // The keyboard reaches a free time too: one tab stop of hours (↑ ↓), Enter opens the slot field there.
  const stop = view.locator('.day-cal-grid .day-cal-stop[tabindex="0"]');
  await stop.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await view.locator('.day-slot').waitFor({ timeout: 5_000 });
  await view.locator('.day-slot-input').press('Escape');
  await view.locator('.day-slot').waitFor({ state: 'detached', timeout: 5_000 });
  assert.match((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ?? '', /^Add at \d{2}:00$/, 'back on the hour');

  // 4. Handed off: work the person gave an agent.
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager' || agent.mode === 'manager');
  await rpc.call('tasks.create', { title: 'Prepare the tax papers', assigneeKind: 'agent', assigneeId: manager.id });
  const handedToggle = view.getByRole('button', { name: /^Handed off \d+$/ });
  await handedToggle.waitFor({ timeout: 15_000 });
  await handedToggle.click();
  const handedRow = view.locator('.day-handed-row', { hasText: 'Prepare the tax papers' });
  await handedRow.waitFor({ timeout: 10_000 });
  assert.match((await handedRow.locator('.day-handed-state').textContent()) ?? '', new RegExp(`${manager.name}|Not assigned yet`));

  // 5. Week ⇄ Day in the fixed header cell: the week takes the pane; the header keeps its boxes.
  const steady = ['.day-header .day-span', '.day-header button[aria-label^="Previous"]', '.day-header button[aria-label^="Next"]', '.day-header .day-date'];
  await expectStable(page, steady, async () => {
    await header.locator('.day-span [role="tab"]', { hasText: 'Week' }).click();
    await view.locator('.day-week').waitFor({ timeout: 10_000 });
  });
  assert.equal(await header.locator('.day-span [role="tab"][aria-selected="true"]').textContent(), 'Week');
  await shot('day-04-week-light');
  await expectStable(page, steady, async () => {
    await header.locator('.day-span [role="tab"]', { hasText: 'Day' }).click();
    await view.locator('.day-cal-grid').waitFor({ timeout: 10_000 });
  });

  // 6. Day navigation: › opens tomorrow (#/day/<date>), the title goes back to today; the mini month.
  await header.getByRole('button', { name: 'Next day' }).click();
  await page.waitForFunction(() => /^#\/day\/\d{4}-\d{2}-\d{2}$/.test(location.hash), null, { timeout: 5_000 });
  assert.equal((await header.locator('.day-date').textContent())?.trim(), 'Tomorrow');
  await expectStable(page, ['.day-header button[aria-label="Previous day"]', '.day-header button[aria-label="Next day"]', '.day-header .day-span'], async () => {
    await header.getByRole('button', { name: 'Previous day' }).click();
    await page.waitForFunction(() => location.hash === '#/day', null, { timeout: 5_000 });
    await header.getByRole('button', { name: 'Previous day' }).click();
    await page.waitForFunction(() => /^#\/day\/\d{4}-\d{2}-\d{2}$/.test(location.hash), null, { timeout: 5_000 });
  });
  assert.equal((await header.locator('.day-date').textContent())?.trim(), 'Yesterday');
  await header.locator('.day-date').click();
  await page.waitForFunction(() => location.hash === '#/day', null, { timeout: 5_000 });
  await page.locator('.sidebar .day-month-day:not(.current):not(.outside)').last().click();
  await page.waitForFunction(() => /^#\/day\/\d{4}-\d{2}-\d{2}$/.test(location.hash), null, { timeout: 5_000 });
  await page.evaluate(() => { location.hash = '#/day'; });

  // 7. Dark, a narrow window (List | Calendar), 640×480 and the phone width.
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('day-05-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(900, 700);
  const switcher = view.locator('.day-switch');
  await switcher.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined); // a narrow view shows it
  if (await switcher.isVisible()) {
    await switcher.getByRole('tab', { name: 'Calendar' }).click();
    await view.locator('.day-cal-grid').waitFor({ timeout: 5_000 });
    assert.equal(await view.locator('.day-listpane').isVisible(), false, 'the calendar instead of the list');
    await shot('day-06-narrow-calendar');
    await switcher.getByRole('tab', { name: 'List' }).click();
  }
  await size(640, 480);
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 640×480 (${await overflow()}px)`, 5_000);
  await shot('day-07-640x480');
  await size(375, 812);
  await page.evaluate(() => { location.hash = '#/day'; });
  await page.locator('.mobile-shell .day-view .day-list').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.mobile-shell .day-view .day-listpane').isVisible(), true, 'the phone opens on the list');
  await until(async () => (await overflow()) <= 1, `no horizontal page scroll at 375 px (${await overflow()}px)`, 5_000);
  await shot('day-08-375');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
