// Electron window check of the repair screen (23.10.2026) with the demo engine in an isolated profile.
// The profile holds the representative old data (test/unit/repair/old-profile.ts), a copy of it from
// before an earlier update (made by db/upgrade.ts), and a database marked as saved by a newer app:
//   * the window shows the repair screen instead of the app: title, the technical line, Try again,
//     Export diagnostics and one "Before the update to …" copy with Restore; no overlay applies;
//   * a drag strip keeps the frameless window movable; Try again with a problem that comes back
//     returns to the screen with every button enabled and a note (no lock-up);
//   * Export diagnostics writes the file and says where;
//   * Restore asks first, then the runtime restarts on the copy, migrates it and the normal app
//     (the shell with the old chat) comes back;
//   * light, dark, 640×480 and phone width (no horizontal page scroll); no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { openDatabase } from '../../src/runtime/db/upgrade.ts';
import { FIXTURE, writeOldProfile } from '../unit/repair/old-profile.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('repair screen: a newer data schema, diagnostics, restore of the pre-update copy and back to the app', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-repair-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  writeOldProfile(profile);
  openDatabase({ file: path.join(profile, 'workforce.db'), dataDir: profile, version: '0.1.9' }).close(); // the copy '0.1.9-s9'
  const db = new DatabaseSync(path.join(profile, 'workforce.db'));
  db.prepare(`UPDATE meta SET value = '9999' WHERE key = 'schema'`).run();
  db.close();
  await mkdir(path.join(profile, 'custom'), { recursive: true });
  await writeFile(path.join(profile, 'custom', 'theme.css'), ':root { --chrome: #ff00ff; }\n'); // must not apply on the repair screen

  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  t.after(async () => {
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  const theme = (value) => page.evaluate((next) => { document.documentElement.dataset.theme = next; }, value);
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  const card = page.locator('.repair-card');
  await card.waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('#repair-title').textContent(), 'Your data is from a newer version');
  assert.match(await card.locator('.repair-detail').textContent(), /schema 9999/);
  assert.equal(await card.getByRole('button', { name: 'Try again' }).count(), 1);
  const copy = card.locator('.repair-copy');
  assert.equal(await copy.count(), 1);
  assert.match(await copy.locator('span').textContent(), /^Before the update to 0\.1\.9 · /);
  assert.equal(await page.locator('.shell').count(), 0, 'the app is not shown');
  const chrome = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim().toLowerCase());
  assert.notEqual(chrome, '#ff00ff', 'no overlay on the repair screen');

  await size(1280, 820);
  await theme('light'); await shot('repair-01-light');
  await theme('dark'); await shot('repair-02-dark');
  await theme('light');
  await size(640, 480); await shot('repair-03-640x480');
  assert.ok(await overflow() <= 1);
  await size(390, 800); await shot('repair-04-phone');
  assert.ok(await overflow() <= 1, 'no horizontal scroll at phone width');
  await size(1280, 820);
  const strip = await page.evaluate(() => getComputedStyle(document.querySelector('.repair-view'), '::before').height);
  assert.equal(strip, '48px', 'a drag strip of the header row height keeps the frameless window movable');

  // Try again with a problem that comes back (the data is still from a newer version): the screen
  // returns with every button enabled and says so – it never stays locked on "Starting again…".
  await card.getByRole('button', { name: 'Try again' }).click();
  await card.locator('.repair-note', { hasText: 'the same problem came back' }).waitFor({ timeout: 90_000 });
  assert.equal(await card.getByRole('button', { name: 'Try again' }).isEnabled(), true);
  assert.equal(await card.getByRole('button', { name: 'Export diagnostics' }).isEnabled(), true);
  assert.equal(await copy.getByRole('button', { name: 'Restore' }).isEnabled(), true);
  await shot('repair-04b-retry-again');

  await card.getByRole('button', { name: 'Export diagnostics' }).click();
  await card.locator('.repair-note', { hasText: 'Saved to' }).waitFor({ timeout: 15_000 });
  assert.match(await card.locator('.repair-note').textContent(), /diagnostics-.*\.txt/);

  await copy.getByRole('button', { name: 'Restore' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await shot('repair-05-confirm');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await page.locator('.shell').waitFor({ timeout: 90_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  const rpc = await connect(info.port, info.token, 'cli');
  t.after(() => rpc.close?.());
  assert.ok((await rpc.call('chats.list')).some((chat) => chat.id === FIXTURE.chatId), 'the old chat is back');
  assert.equal((await rpc.call('repair.state')).active, false);
  await shot('repair-06-back');
  assert.deepEqual(errors, []);
});
