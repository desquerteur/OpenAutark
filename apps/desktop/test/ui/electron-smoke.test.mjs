// Electron window smoke test (real main + preload + utility-process runtime + built UI) with the
// deterministic demo engine in an isolated test profile – nothing touches the person's data.
// Checks: the window boots (a fresh profile starts on the first-run layer), the runtime connects over the
// MessagePort, onboarding is finished the simple way (onboarding.start over RPC – first-run-window.test.mjs clicks
// through the cards), the Manager's chat answers a message, no renderer errors; saves screenshots (light, dark,
// 640×480) for review.
// Run: npm run test:ui   (SCREENSHOTS=<dir> keeps the screenshots)

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

test('desktop window boots, connects and chats with the demo engine', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-ui-'));
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
  await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(1280, 820); win.center(); });
  await page.locator('.first-run-view').waitFor({ timeout: 20_000 }); // a fresh profile starts on the first-run tour
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'first-run-light.png') });

  // Finish onboarding the simple way: the runtime's own onboarding.start (the Manager's first chat with the app's start
  // text), then open that chat – the layer goes away by itself once the settings say 'done'.
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const { conversationId } = await rpc.call('onboarding.start');
  await page.locator('.first-run-view').waitFor({ state: 'detached', timeout: 20_000 });
  await page.evaluate((id) => { location.hash = `#/chat/${encodeURIComponent(id)}`; }, conversationId);

  // The Manager's chat answers through the runtime.
  const composer = page.locator('textarea').first();
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await composer.fill('Hello from the smoke test');
  await page.locator('button.send-button').first().click();
  await page.getByText(/Echo: .*Hello from the smoke test/).first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(shots, 'chat-light.png') });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'chat-dark.png') });

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(640, 480); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'chat-640x480.png') });

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
