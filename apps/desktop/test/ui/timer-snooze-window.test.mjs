// Electron window check of the timer to-do's Snooze menu (F03) with the demo engine in an
// isolated profile: a typed reminder becomes a timer to-do in My day; Snooze opens a small menu
// (10 minutes, 1 hour, tomorrow at the start of work – B-041: settings.day.workStart, 08:00 by
// default); "In 10 minutes" lets the to-do wait – it leaves the open groups for Later without a
// receipt. Screenshots light, dark and phone width; no renderer errors.
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

test('timer to-do: Snooze menu lets it wait and leave the list', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-snooze-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const todo = await rpc.call('tasks.create', { title: 'Stretch', assigneeKind: 'human', widget: { type: 'timer', label: 'Stretch', at: new Date(Date.now() + 20 * 60_000).toISOString() } });
  assert.equal(todo.widget?.type, 'timer');
  await page.evaluate(() => { location.hash = '#/day'; });
  const item = page.locator(`.day-group .todo-item[data-task-id="${todo.id}"]`);
  await item.waitFor({ timeout: 15_000 });
  await item.locator('.todo-open').click();
  const snooze = item.getByRole('button', { name: 'Snooze' });
  await snooze.waitFor({ timeout: 10_000 });
  await snooze.click();
  const menu = page.getByRole('menu', { name: 'Snooze' });
  await menu.waitFor();
  const labels = (await menu.locator('.menu-label > span').allTextContents()).map((text) => text.trim());
  assert.deepEqual(labels.slice(0, 2), ['In 10 minutes', 'In 1 hour']);
  assert.match(labels[2] ?? '', /^Tomorrow 0?8[:.]00/, `tomorrow at the start of work (${labels[2]})`);
  await shot('snooze-01-menu-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('snooze-02-menu-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await menu.locator('.menu-item', { hasText: 'In 10 minutes' }).click();
  await item.waitFor({ state: 'detached', timeout: 15_000 });
  const task = await rpc.call('tasks.get', { id: todo.id });
  assert.equal(task.status, 'waiting');
  assert.equal(task.waitingOn?.reason, 'Snoozed');
  if (task.conversationId) {
    const receipts = (await rpc.call('messages.list', { conversationId: task.conversationId })).filter((message) => message.kind === 'answer');
    assert.equal(receipts.length, 0, 'no receipt for a snooze');
  }
  await shot('snooze-03-after-light');

  // Phone width: the menu fits (after the "Snoozed until …" toast is gone).
  await page.locator('.status-note[data-notice^="toast-"]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  const second = await rpc.call('tasks.create', { title: 'Drink water', assigneeKind: 'human', widget: { type: 'timer', label: 'Drink water', at: new Date(Date.now() + 30 * 60_000).toISOString() } });
  await size(420, 860);
  await page.waitForTimeout(600);
  const phoneItem = page.locator(`.todo-item[data-task-id="${second.id}"]`);
  await phoneItem.waitFor({ timeout: 15_000 });
  await phoneItem.locator('.todo-open').click();
  await phoneItem.getByRole('button', { name: 'Snooze' }).click();
  await page.getByRole('menu', { name: 'Snooze' }).waitFor();
  await shot('snooze-04-phone');
  await page.keyboard.press('Escape');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
