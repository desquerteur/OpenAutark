// Electron window check of MM7 "Restart now": a backup made by another installation (a headless
// runtime with its own temp profile) is restored in the desktop app – Settings
// › Advanced › Restore: type the folder, Restore, confirm, "Restart now". The runtime restarts in place (the
// window stays open, no reload), applies the restore, and the row then offers the folder field again; the
// backed-up chat is in the chat list and the replaced data stays as a fallback copy.
// Screenshots light and dark; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { startRuntime } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
// Pending calls of the old runtime are dropped when it restarts; that is expected here.
const RESTART_NOISE = /runtime is not running|connection (?:closed|lost)|The app closed/i;

test('restore from a backup and "Restart now" applies it without closing the window', { timeout: 300_000 }, async (t) => {
  const backups = await mkdtemp(path.join(os.tmpdir(), 'workforce-restore-backups-'));
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-restore-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  let app;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await rm(backups, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  // The other installation: one chat, backed up into a temp folder.
  const other = await startRuntime();
  let backup;
  try {
    const manager = (await other.client.call('agents.list')).find((agent) => agent.template === 'manager');
    await other.client.call('chats.create', { title: 'Brought along by the backup', agentIds: [manager.id] });
    backup = await other.client.call('system.backup', { dir: path.join(backups, 'snapshot') });
  } finally {
    await other.stop();
  }

  app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(1280, 820); });
  let loads = 0;
  page.on('load', () => { loads += 1; });

  await page.evaluate(() => { location.hash = '#/settings/about'; });
  const restoreRow = page.locator('#settings-about .set-row', { has: page.locator('.set-row-label', { hasText: /^Restore$/ }) });
  await restoreRow.waitFor({ timeout: 20_000 });
  await restoreRow.locator('input[aria-label="Backup folder"]').fill(backup.path);
  await restoreRow.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.locator('dialog[open] .dialog-actions button', { hasText: 'Restore' }).click();

  const ready = restoreRow;
  await ready.getByRole('button', { name: 'Restart now' }).waitFor({ timeout: 20_000 });
  assert.match(await ready.locator('.set-row-hint').textContent(), /^Ready: /);
  await ready.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'restore-01-ready.png') });
  await ready.getByRole('button', { name: 'Restart now' }).click();
  // Agents still at work ask once more before the restart.
  const again = page.locator('.dialog-actions button', { hasText: 'Restart' });
  if (await again.isVisible().catch(() => false)) await again.click();

  // The runtime restarted in place and applied it: nothing is staged any more – the row offers the folder field again.
  await restoreRow.locator('input[aria-label="Backup folder"]').waitFor({ timeout: 120_000 });
  assert.equal(loads, 0, 'the window was not reloaded – only the runtime restarted');
  assert.equal(await ready.getByRole('button', { name: 'Restart now' }).count(), 0, 'nothing is staged any more');
  await restoreRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'restore-02-restored-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'restore-03-restored-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.evaluate(() => { location.hash = '#/chats'; });
  await page.getByText('Brought along by the backup').first().waitFor({ timeout: 20_000 });
  const names = readdirSync(profile);
  assert.ok(names.some((name) => name.startsWith('before-restore-')), 'the replaced data stays as a fallback copy');
  assert.ok(existsSync(path.join(profile, 'restore-result.json')));
  assert.ok(!names.includes('restore-failed.json'));

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text) && !RESTART_NOISE.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
