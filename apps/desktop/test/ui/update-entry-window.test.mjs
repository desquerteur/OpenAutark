// Electron window check of the update entry (SM12) with stubbed update states: main's
// 'update:state' event (IPC.updateState) is sent from the main process – test mode never
// contacts GitHub, so nothing else publishes a state.
//   * 640×480 (a narrow desktop window uses the phone layout): the top bar shows the compact item
//     – "Download" for a manual (macOS-like) update, the retry control after a download error and
//     no retry after a failed check, the progress ring while downloading, nothing when up to date; no
//     horizontal scroll
//   * 1280×820: the rail shows the retry control in 'error' with its reason as tooltip
//   * Settings › Advanced › Version: "Download" for the manual update (its hint says it opens the download page),
//     "Try again" after an error (looked up in the main slot – the rail's update button is named "Download" too)
//   * screenshots light, dark and 640×480; no renderer errors. Nothing is clicked that would open
//     a browser or install anything.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const UPDATE_STATE = 'update:state'; // IPC.updateState in src/shared/api/desktop.ts

const base = { version: '0.2.0', percent: 0, automaticInstall: true };
const MANUAL = { ...base, status: 'available', availableVersion: '0.3.0', automaticInstall: false, downloadURL: 'https://github.com/desquerteur/OpenAutark/releases/latest/download/autark-mac-universal.dmg' };
const FAILED = { ...base, status: 'error', failure: 'download', availableVersion: '0.3.0', message: 'Download failed. Click to try again.' };
const CHECK_FAILED = { ...base, status: 'error', failure: 'check', message: 'Could not check for updates. Retrying automatically.' };
const DOWNLOADING = { ...base, status: 'downloading', availableVersion: '0.3.0', percent: 42 };
const CURRENT = { ...base, status: 'current' };
const DOWNLOADED = { ...base, status: 'downloaded', availableVersion: '0.3.0', percent: 100 };

test('the update entry shows in narrow windows, in the rail on error and in Settings › About', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-update-entry-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
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
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 320); win.setSize(w, h); }, [width, height]);
  const publish = (state) => app.evaluate(({ BrowserWindow }, [channel, value]) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, value);
  }, [UPDATE_STATE, state]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---------------------------------------------------------------- 640×480: compact item
  await size(640, 480);
  await page.locator('.mobile-shell').waitFor({ timeout: 15_000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  const compact = page.locator('.mobile-top .update-control.compact .update-button');
  assert.equal(await compact.count(), 0, 'development state: no update item');

  await publish(MANUAL);
  await compact.waitFor({ timeout: 10_000 });
  assert.equal(await compact.getAttribute('aria-label'), 'Download', 'manual install: the item says Download');
  assert.equal(await compact.getAttribute('title'), 'Download', 'compact item: native tooltip instead of the side pill');
  assert.equal(await compact.isEnabled(), true);
  assert.match((await compact.locator('.icon').getAttribute('style')) ?? '', /download-simple/);
  await shot('update-01-640x480-download');
  assert.ok(await overflow() <= 1, 'no horizontal page scroll at 640 px');

  await publish(FAILED);
  await page.locator('.mobile-top .update-button.status-error').waitFor({ timeout: 10_000 });
  assert.equal(await compact.getAttribute('aria-label'), FAILED.message, 'error: a retry control with the reason');
  assert.match((await compact.locator('.icon').getAttribute('style')) ?? '', /arrow-clockwise/, 'retry icon');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('update-02-640x480-error-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await publish(CHECK_FAILED);
  await compact.waitFor({ state: 'detached', timeout: 10_000 });
  await shot('update-07-640x480-check-failed-quiet');

  await publish(DOWNLOADING);
  await page.locator('.mobile-top .update-button.status-downloading').waitFor({ timeout: 10_000 });
  assert.match((await compact.textContent()) ?? '', /42%/);
  assert.equal(await compact.isDisabled(), true, 'nothing to click while downloading');

  await publish(CURRENT);
  await page.waitForTimeout(300);
  assert.equal(await compact.count(), 0, 'up to date: the item is gone');

  // ---------------------------------------------------------------- 1280×820: rail retry
  await size(1280, 820);
  await page.locator('.rail').waitFor({ timeout: 15_000 });
  await publish(FAILED);
  const rail = page.locator('.rail .update-button.status-error');
  await rail.waitFor({ timeout: 10_000 });
  await rail.hover();
  await page.locator('.rail .rail-tooltip', { hasText: FAILED.message }).waitFor({ timeout: 5_000 });
  await shot('update-03-rail-error-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('update-04-rail-error-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await publish({ ...CHECK_FAILED, availableVersion: '0.3.0' });
  await rail.waitFor({ state: 'detached', timeout: 10_000 });
  await shot('update-08-rail-check-failed-quiet');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('update-09-rail-check-failed-quiet-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone width uses the same quiet rule; a real failed download remains actionable.
  await size(390, 844);
  await page.locator('.mobile-shell').waitFor({ timeout: 15_000 });
  assert.ok(await page.evaluate(() => innerWidth) <= 390, 'actual phone width, not the desktop minimum');
  assert.equal(await compact.count(), 0, 'no retry for a failed check at phone width');
  await shot('update-10-phone-check-failed-quiet');
  assert.ok(await overflow() <= 1, 'no horizontal scroll at phone width');
  await publish(FAILED);
  await compact.waitFor({ timeout: 10_000 });
  assert.equal(await compact.isEnabled(), true, 'real download failure remains actionable at phone width');
  await size(1280, 820);
  await page.locator('.rail').waitFor({ timeout: 15_000 });

  // ---------------------------------------------------------------- Settings › Advanced
  await page.mouse.move(640, 400);
  await page.evaluate(() => { location.hash = '#/settings/about'; });
  const main = page.locator('#settings-about'); // the rail's update button carries the same names (and Voice has its own Download)
  const retry = main.getByRole('button', { name: 'Try again', exact: true });
  await retry.waitFor({ timeout: 15_000 });
  assert.equal(await retry.isEnabled(), true);
  await publish(CHECK_FAILED);
  await rail.waitFor({ state: 'detached', timeout: 10_000 });
  await main.getByText(CHECK_FAILED.message, { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await retry.isEnabled(), true, 'Settings keeps the check failure and manual retry available');
  await publish(MANUAL);
  const download = main.getByRole('button', { name: 'Download', exact: true });
  await download.waitFor({ timeout: 10_000 });
  assert.equal(await main.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
  assert.equal(await main.getByText('Opens the download page', { exact: false }).count(), 1, 'the hint says what the click does');
  await shot('update-05-about-download');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
