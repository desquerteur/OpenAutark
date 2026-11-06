// Owns: the Electron check of feedback where this build cannot send (settings audit 23.10.2026):
// no operator endpoint → the panel offers Save (not Send), says reports stay on this PC, saves the
// report locally and never attempts a delivery (opened from the header's feedback cell – Settings has no Feedback
// group any more). Light, dark, 640×480 and phone width. Needs a build without WORKFORCE_FEEDBACK_ORIGIN (the default `npm run build`).
// Never: publishes anything or opens the browser; uses an isolated demo profile.
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

test('feedback without a configured sender: Save keeps the report on this PC and says so', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-feedback-local-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const env = { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' };
  delete env.WORKFORCE_FEEDBACK_ORIGIN; // no operator endpoint for this start
  const app = await electron.launch({ executablePath: electronPath, args: [root], cwd: root, timeout: 60_000, env });
  let rpc;
  t.after(async () => {
    rpc?.close?.(); await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  await app.evaluate(({ shell }) => {
    globalThis.__feedbackOpened = [];
    shell.openExternal = async (url) => { globalThis.__feedbackOpened.push(String(url)); };
  });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(320, 320);
    win.setContentSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  assert.equal((await rpc.call('feedback.status')).sending, false, 'this start has no operator endpoint');
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const cell = page.locator('.frame-feedback-cell').getByRole('button', { name: 'Feedback', exact: true });
  await cell.waitFor({ timeout: 15_000 });
  await cell.click();
  const dialog = page.locator('.popover.feedback-menu'); // the header cell's menu
  await dialog.getByRole('textbox', { name: 'Your feedback' }).fill('The sidebar width needs attention');
  await dialog.getByRole('button', { name: 'Save', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).count(), 0, 'no Send that cannot deliver');
  assert.equal(await dialog.getByText('public on GitHub', { exact: false }).count(), 0, 'no GitHub promise');
  await shot('feedback-local-panel-light');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.locator('.feedback-done', { hasText: 'Saved on this PC – sending is not set up.' }).waitFor();
  assert.equal(await dialog.locator('.feedback-message').textContent(), '', 'saving is no error');
  assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).count(), 0);
  const saved = (await rpc.call('feedback.list')).find((report) => report.text === 'The sidebar width needs attention');
  assert.equal(saved?.status, 'local');
  assert.equal(saved?.receiptId, undefined, 'no submission was attempted');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('feedback-local-saved-dark');
  await page.keyboard.press('Escape');
  for (const [width, height, name] of [[640, 480, 'feedback-local-640x480'], [390, 844, 'feedback-local-phone']]) {
    await size(width, height);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => innerWidth), width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal page scroll');
    await shot(name);
  }
  assert.deepEqual(await app.evaluate(() => globalThis.__feedbackOpened), [], 'nothing opens a browser');
  assert.deepEqual(errors, []); t.diagnostic(`screenshots: ${shots}`);
});
