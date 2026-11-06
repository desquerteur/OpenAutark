// Real Electron UI, isolated demo profile. Injects quota responses/events at the MessagePort
// boundary because demo mode never reads personal subscriptions. Verifies live badge updates
// without hover/restart in light, dark, 640x480 and phone layouts, and (B-044) that the details card
// names the windows with the shared labels (ui/lib/limits.ts) and the Codex plan's banked resets;
// not a real-provider test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function quotaTransport() {
  let port;
  const asked = new Set();
  const entry = (remaining) => [{ accountId: 'acc_quota_test', provider: 'codex', label: 'Codex', active: true,
    weeklyRemainingPercent: remaining, weeklyResetsAt: Date.now() + 86_400_000,
    limits: { readAt: Date.now(), stale: false, resets: { available: 2 }, windows: [
      { name: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: Date.now() + 3_600_000 },
      { name: 'weekly', windowMinutes: 10080, usedPercent: 100 - remaining, resetsAt: Date.now() + 86_400_000 },
    ] },
  }];
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (frame, ...rest) {
    if (frame?.method === 'usage.list') { port = this; asked.add(frame.id); }
    return post.call(this, frame, ...rest);
  };
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
  Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() {
    const frame = data.call(this);
    return frame && asked.has(frame.id) && 'result' in frame ? { ...frame, result: entry(72) } : frame;
  } });
  window.__quotaPush = (left) => port.dispatchEvent(new MessageEvent('message', { data: { event: 'usage.updated', data: entry(left) } }));
}

test('quota badges follow 72 → 36 on events without hover or reload', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-quota-ui-'));
  const shots = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({ executablePath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  t.after(async () => {
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(quotaTransport);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  for (const [width, height, scheme, name] of [
    [1280, 820, 'light', 'quota-light'], [1280, 820, 'dark', 'quota-dark'],
    [640, 480, 'light', 'quota-640'], [390, 844, 'dark', 'quota-phone'],
  ]) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 300); win.setSize(w, h);
    }, [width, height]);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => innerWidth), width, 'actual viewport width, including the phone case');
    if (width <= 640) await page.getByRole('button', { name: 'Profile menu' }).filter({ visible: true }).click();
    await page.evaluate(() => window.__quotaPush(72));
    const badge = page.locator('.usage-badge:visible').first();
    await badge.getByText('72%', { exact: true }).waitFor();
    await page.evaluate(() => window.__quotaPush(36));
    await badge.getByText('36%', { exact: true }).waitFor();
    assert.match(await badge.getAttribute('aria-label'), /36% weekly left/);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    if (name === 'quota-light') { // B-044: the details card – shared window labels and the banked resets
      await badge.click();
      const card = page.locator('.usage-card').first();
      await card.getByText('5-hour limit', { exact: true }).waitFor();
      await card.getByText('2 resets available', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(shots, 'quota-details-light.png') });
      await page.keyboard.press('Escape');
    }
    if (width <= 640) await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  t.diagnostic(`screenshots: ${shots}`);
});
