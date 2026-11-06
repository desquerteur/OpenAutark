// Electron window check of where backups live (23.10.2026, privacy card: out of the agents' workspace) and that a
// backup is made at all in the desktop app (whose data folder is Electron's userData – Chromium's own entries are left
// out) – with the demo engine in an isolated profile, over two starts of the same profile:
//   1. Settings › Advanced › "Back up" writes into <data>/backups/<stamp> – the row says when and how big ("Show in
//      folder" keeps its place, disabled until then); nothing lands in <workspace>/backups; Electron's caches are not in it;
//   2. the next start: Restore with that folder stages it ("Ready: <data>/backups/<stamp>" with Restart now); the
//      restore is not applied (no restart). (Moving backups out of an old workspace went – Umbau Einfachheit.)
// Screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Run: npm run build && node --test test/ui/backup-move-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  return { app, page, errors, size };
}

const relevant = (errors) => errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));

test('backups go to the data folder without Electron\'s own entries; the next start stages a restore from there', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-backup-move-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  let current;
  t.after(async () => {
    await current?.app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  const workspaceBackups = path.join(profile, 'workspace', 'backups');
  const dataBackups = path.join(profile, 'backups');

  // 1. Back up: into <data>/backups.
  current = await launch(profile);
  let { page, size } = current;
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  await page.evaluate(() => { location.hash = '#/settings/about'; });
  const backupRow = page.locator('#settings-about .set-row', { has: page.locator('.set-row-label', { hasText: /^Back up$/ }) });
  await backupRow.waitFor({ timeout: 20_000 });
  assert.match(await backupRow.locator('.set-row-hint').textContent(), /All data into the data folder, with encrypted secrets and the agents' website logins, not the AI sign-ins; keep it private/);
  // "Show in folder" keeps its place, disabled until the backup exists.
  assert.equal(await backupRow.getByRole('button', { name: 'Show in folder' }).isDisabled(), true);
  await backupRow.getByRole('button', { name: 'Back up', exact: true }).click();
  await backupRow.locator('button:has-text("Show in folder"):not([disabled])').waitFor({ timeout: 60_000 });
  assert.match((await backupRow.locator('.set-row-hint').textContent()) ?? '', /^Saved \d{1,2}:\d{2}.* · .+$/, 'the hint says when and how big');
  const stamps = readdirSync(dataBackups).filter((name) => existsSync(path.join(dataBackups, name, 'manifest.json')));
  assert.equal(stamps.length, 1, 'one backup in <data>/backups');
  const made = path.join(dataBackups, stamps[0]);
  assert.equal(await page.locator('input[aria-label="Backup folder"]').inputValue(), '', 'a backup never fills the Restore field');
  assert.equal(path.dirname(path.resolve(made)), path.resolve(dataBackups), `the backup is in <data>/backups (${made})`);
  assert.ok(existsSync(path.join(made, 'manifest.json')), 'with its manifest');
  for (const entry of ['Cache', 'Code Cache', 'GPUCache', 'Local Storage', 'Network', 'lockfile']) assert.ok(!existsSync(path.join(made, entry)), `no ${entry} in the backup`);
  assert.ok(!existsSync(workspaceBackups), 'nothing in the agents\' workspace');
  await backupRow.scrollIntoViewIfNeeded();
  await shot('backup-01-made-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('backup-02-made-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(relevant(current.errors).length, 0, `no renderer errors in the first start: ${relevant(current.errors)}`);
  await current.app.close();
  current = undefined;

  // 2. The next start: Restore with that folder stages it.
  current = await launch(profile);
  ({ page, size } = current);
  await page.evaluate(() => { location.hash = '#/settings/about'; });
  const restoreRow = page.locator('#settings-about .set-row', { has: page.locator('.set-row-label', { hasText: /^Restore$/ }) });
  await restoreRow.waitFor({ timeout: 20_000 });
  await restoreRow.locator('input[aria-label="Backup folder"]').fill(made);
  await restoreRow.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.locator('dialog[open] .dialog-actions button', { hasText: 'Restore' }).click();
  const ready = restoreRow;
  await restoreRow.getByRole('button', { name: 'Restart now' }).waitFor({ timeout: 20_000 });
  assert.equal(path.resolve((await ready.locator('.set-row-hint').textContent())?.trim().replace(/^Ready: /, '') ?? ''), path.resolve(made), 'the folder is staged');
  await ready.scrollIntoViewIfNeeded();
  await shot('backup-04-restore-ready-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('backup-05-restore-ready-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, name] of [[640, 480, 'backup-06-640x480'], [420, 860, 'backup-07-phone']]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await ready.scrollIntoViewIfNeeded();
    await shot(name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${width} px (${overflow}px)`);
  }

  t.diagnostic(`screenshots: ${shots}`);
  assert.deepEqual(relevant(current.errors), [], 'no renderer errors');
});
