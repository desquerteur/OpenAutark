// Electron window check of the calm My day list (F04, B-041 groups) with the demo engine in an
// isolated profile, on My day (#/day):
//   * a reminder in 5 minutes sits under Today and shows its ring time with a quiet countdown
//     ("17:00 · in 5 min");
//   * a reminder three days ahead and a snoozed one wait under a collapsed "Later 2" – they are
//     not in the list and the rail badge does not count them; opened, Later shows them with their
//     times ("Snoozed until …");
//   * when the 5-minute reminder rings (its timer schedule run now – the real fire path) it gets
//     the ringing accent on its check and moves to the top of Needs you;
//   * screenshots light, dark and 375 px (phone layout); no horizontal page scroll; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const DAY = 86_400_000;

test('My day: ring time and countdown, a collapsed Later the badge skips, a ringing to-do moves to Needs you', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-later-'));
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
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const form = await rpc.call('tasks.create', { title: 'Sign the form', assigneeKind: 'human', dueAt: Date.now() + 2 * 60_000 });
  const stretch = await rpc.call('tasks.create', { title: 'Stretch', assigneeKind: 'human', widget: { type: 'timer', label: 'Stretch', at: new Date(Date.now() + 5 * 60_000).toISOString() } });
  assert.equal(stretch.widget?.type, 'timer');

  await page.evaluate(() => { location.hash = '#/day'; });
  const home = page.locator('.day-view');
  const todayList = home.locator('.todo-list[aria-label="Today"]');
  const row = (id) => home.locator(`.todo-item[data-task-id="${id}"]`);
  await row(stretch.id).waitFor({ timeout: 15_000 });
  await row(form.id).waitFor({ timeout: 15_000 });
  const when = (await row(stretch.id).locator('.due-text').textContent())?.trim() ?? '';
  assert.match(when, /^\S+.* · in [45] min$/, `ring time and countdown (${when})`);
  assert.equal(await todayList.locator(`:scope > .todo-item[data-task-id="${stretch.id}"]`).count(), 1, 'a reminder within 12 h is part of Today');
  const badge = page.locator('.rail .rail-badge');
  const before = (await badge.count()) ? (await badge.textContent())?.trim() : undefined;

  // Later: a reminder three days ahead and a snoozed one.
  const far = await rpc.call('tasks.create', {
    title: 'Water the plants', assigneeKind: 'human',
    widget: { type: 'timer', label: 'Water the plants', at: new Date(Date.now() + 3 * DAY).toISOString() },
  });
  const nap = await rpc.call('tasks.create', { title: 'Drink water', assigneeKind: 'human', widget: { type: 'timer', label: 'Drink water', at: new Date(Date.now() + 20 * 60_000).toISOString() } });
  await rpc.call('todos.snooze', { id: nap.id, minutes: 30 });
  const toggle = home.getByRole('button', { name: 'Later 2' });
  await toggle.waitFor({ timeout: 15_000 });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'collapsed');
  assert.equal(await home.locator(`.day-group [data-task-id="${far.id}"], .day-group [data-task-id="${nap.id}"]`).count(), 0, 'not in the open groups');
  if (before !== undefined) assert.equal((await badge.textContent())?.trim(), before, 'the badge skips Later');
  await shot('later-01-collapsed-light');

  await toggle.click();
  const laterList = home.locator('.todo-later > .todo-list');
  await laterList.locator(`[data-task-id="${nap.id}"]`).waitFor({ timeout: 10_000 });
  assert.equal(await laterList.locator(':scope > .todo-item').count(), 2);
  const snoozed = laterList.locator(`[data-task-id="${nap.id}"] .due-text.snoozed`);
  await page.waitForFunction((id) => /^Snoozed until /.test(document.querySelector(`.todo-later [data-task-id="${id}"] .due-text.snoozed`)?.textContent ?? ''), nap.id, { timeout: 10_000 });
  assert.match((await snoozed.textContent()) ?? '', /^Snoozed until /);
  assert.ok(((await laterList.locator(`[data-task-id="${far.id}"] .due-text`).textContent()) ?? '').trim().length > 0, 'the far reminder shows its time');
  await shot('later-02-open-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('later-03-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // It rings: the scheduler runs the reminder's timer now (schedules/fire.ts sets needs_you).
  const ring = (await rpc.call('schedules.list')).find((schedule) => schedule.taskId === stretch.id && schedule.kind === 'timer');
  assert.ok(ring, 'the reminder has its ring');
  await rpc.call('schedules.runNow', { id: ring.id });
  await page.waitForFunction((id) => {
    const first = document.querySelector('.day-view .todo-list[aria-label="Needs you"] > .todo-item');
    return first?.getAttribute('data-task-id') === id && !!first.querySelector('.day-check.ringing');
  }, stretch.id, { timeout: 15_000 });
  assert.equal(await row(stretch.id).locator('.sr-only', { hasText: 'Needs you now' }).count(), 1, 'the state is not colour alone');
  await shot('later-04-ringing-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('later-05-ringing-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone width: the same list and Later row, no horizontal scroll.
  await size(375, 812);
  await page.waitForTimeout(600);
  await page.evaluate(() => { location.hash = '#/day'; });
  await page.locator('.todo-later-toggle').first().waitFor({ timeout: 15_000 });
  await page.locator(`.todo-item[data-task-id="${stretch.id}"] .day-check.ringing`).first().waitFor({ timeout: 15_000 });
  assert.ok((await overflow()) <= 1, `no horizontal page scroll at 375 px (${await overflow()}px)`);
  const tabBadge = page.locator('.mobile-shell .tab-badge');
  if (before !== undefined && await tabBadge.count()) assert.equal((await tabBadge.textContent())?.trim(), before, 'the phone tab badge skips Later too');
  await shot('later-06-375');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
