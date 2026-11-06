// Electron window check of the start notice (RC1): the app starts once on a fresh profile (no
// notice), is closed, the stored version is set back to 0.0.1, and on the next start the window
// shows one toast "Updated to <version> · 0 tasks continued"; after a reload it is not shown again.
// Screenshots light, dark and 640×480; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

async function launch(profile) {
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  return { app, page, errors };
}

test('after an update the window shows one start notice', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-notice-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  let current;
  t.after(async () => {
    await current?.app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  current = await launch(profile);
  await current.page.waitForTimeout(1500);
  assert.equal(await current.page.locator('.status-note', { hasText: 'Updated to' }).count(), 0, 'no notice on a first start');
  await current.app.close();
  current = undefined;

  const db = new DatabaseSync(path.join(profile, 'workforce.db'));
  const row = db.prepare("SELECT value FROM kv WHERE ns = 'system' AND key = 'version'").get();
  assert.ok(row, 'the first start stored its version');
  const version = JSON.parse(row.value);
  db.prepare("UPDATE kv SET value = ? WHERE ns = 'system' AND key = 'version'").run(JSON.stringify('0.0.1'));
  db.close();

  current = await launch(profile);
  const { app, page, errors } = current;
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const toast = page.locator('.status-note', { hasText: `Updated to ${version} · 0 tasks continued` });
  await toast.waitFor({ timeout: 20_000 });
  assert.equal(await toast.count(), 1, 'shown once');
  await page.screenshot({ path: path.join(shots, 'notice-01-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'notice-02-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await size(640, 480);
  await page.waitForTimeout(600);
  if (await toast.count()) await page.screenshot({ path: path.join(shots, 'notice-03-640x480.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 640 px (${overflow}px)`);

  await size(1280, 820); // at 640 px the window uses the phone layout (.mobile-shell)
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.waitForTimeout(2000);
  assert.equal(await page.locator('.status-note', { hasText: 'Updated to' }).count(), 0, 'not again after a reload');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
