// Owns: Electron checks that the app-change entry points stay removed (profile menu, palette, Plus menu) and of
// feedback from the header's feedback cell: a painted screenshot is sent directly (no browser), an unconfirmed
// response keeps the report on this PC with the reason (the window has no retry control any more – Settings › Feedback
// went; feedback.send sends the same report again).
// Never: publishes an issue or opens the browser; uses an isolated demo profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { feedbackSubmitFixture } from '../e2e/lib/feedback-submit.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('app-change entry points are removed; feedback publishes marked images directly on GitHub without a browser', { timeout: 240_000 }, async (t) => {
  const delivery = await feedbackSubmitFixture();
  t.after(() => delivery.close());
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-change-app-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({ executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, ...delivery.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
  let rpc;
  t.after(async () => {
    rpc?.close?.(); await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  await app.evaluate(({ shell }) => {
    globalThis.__feedbackOpened = [];
    shell.openExternal = async (url) => { globalThis.__feedbackOpened.push(String(url)); };
    shell.showItemInFolder = () => {};
  });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setMinimumSize(320, 320); // exercise phone widths below the normal desktop minimum
    win.setContentSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const hash = (value) => page.evaluate((next) => { location.hash = next; }, value);
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Change this app', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: /Settings/ }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Feedback', exact: true }).count(), 0, 'B-055 Q4: Feedback has its own header cell');
  await page.locator('.frame-feedback-cell').getByRole('button', { name: 'Feedback', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('.palette-input').fill('Change this app');
  assert.equal(await page.locator('.palette-row', { hasText: 'Change this app' }).count(), 0);
  await page.keyboard.press('Escape');
  const first = (await rpc.call('chats.list'))[0];
  await hash(`#/chat/${first.id}`);
  await page.locator('.composer-plus[aria-label="Add"]').click();
  assert.equal(await page.getByRole('menuitem', { name: 'Change this app', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await hash('#/settings');
  await page.locator('.settings-view').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Change this app…', exact: true }).count(), 0);
  assert.equal(await page.locator('[aria-label="Use my changes"]').count(), 0, 'no customize section');
  await shot('change-removed-settings');
  const cell = page.locator('.frame-feedback-cell').getByRole('button', { name: 'Feedback', exact: true });
  await cell.click();
  const dialog = page.locator('.popover.feedback-menu'); // the header cell's menu
  await dialog.getByRole('textbox', { name: 'Your feedback' }).fill('The sidebar width needs attention');
  // B-055 Q4: the screenshot is checked by default; its thumbnail opens "Paint over" (opaque black marks)
  await dialog.locator('.feedback-thumb img').waitFor();
  assert.equal(await dialog.getByRole('checkbox', { name: 'Screenshot' }).isChecked(), true);
  await dialog.getByRole('button', { name: 'Paint over the screenshot' }).click();
  const paint = page.locator('dialog.paint-dialog[open]');
  const canvas = paint.locator('canvas.paint-canvas'); await canvas.waitFor();
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 75); await page.mouse.up();
  assert.equal(await paint.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), true);
  await shot('feedback-marked-light');
  await paint.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.feedback-menu .feedback-thumb img')?.getAttribute('src')?.startsWith('data:image/jpeg'));
  assert.equal(await dialog.getByRole('button', { name: 'Connect GitHub', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.locator('.feedback-done', { hasText: 'Sent.' }).waitFor();
  const saved = (await rpc.call('feedback.list')).find((report) => report.text === 'The sidebar width needs attention');
  assert.ok(saved.screenshotFileId); assert.equal(saved.annotationFileId, undefined, 'B-055: only the painted image'); assert.equal(saved.status, 'sent');
  assert.equal((await delivery.records()).reports.length, 1);
  assert.ok((await delivery.records()).images[0]?.base64, 'the marked image reached GitHub automatically');
  assert.deepEqual(await app.evaluate(() => globalThis.__feedbackOpened), [], 'Send opens no browser');
  const delivered = (await rpc.call('feedback.list')).find((report) => report.id === saved.id);
  assert.equal(delivered.status, 'sent'); assert.ok(delivered.receiptId);
  await shot('feedback-sent-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('feedback-sent-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  // The menu at 640×480 and phone width (a bottom sheet there): no horizontal overflow.
  for (const [width, height, name] of [[640, 480, 'feedback-menu-640x480'], [390, 844, 'feedback-menu-phone']]) {
    await size(width, height);
    await page.waitForTimeout(400); // let the shell switch between desktop and phone layouts
    assert.equal(await page.evaluate(() => innerWidth), width, 'the requested viewport width is real');
    await page.getByRole('button', { name: 'Feedback', exact: true }).first().click();
    const menu = page.locator('.popover.feedback-menu');
    await menu.waitFor({ timeout: 5_000 });
    assert.equal(await menu.evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1), true, 'no horizontal overflow');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal page scroll');
    await shot(name);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  }
  // An unconfirmed response keeps the report on this PC; feedback.send retries the same report and receipt.
  await size(1280, 820); await page.waitForTimeout(400);
  delivery.setFailure(true);
  await cell.click();
  const retry = page.locator('.popover.feedback-menu');
  await retry.getByRole('textbox', { name: 'Your feedback' }).fill('Keep my report after an unconfirmed response');
  await retry.getByRole('button', { name: 'Send', exact: true }).click();
  await retry.locator('.feedback-done', { hasText: 'Saved on this PC.' }).waitFor();
  await retry.locator('.feedback-message').filter({ hasText: /\S/ }).waitFor(); // the reason, in the form's reserved line
  assert.equal(await retry.getByText('Sent.', { exact: true }).count(), 0);
  await shot('feedback-unconfirmed');
  const kept = (await rpc.call('feedback.list')).find((report) => report.text === 'Keep my report after an unconfirmed response');
  assert.ok(kept, 'the report is kept'); assert.notEqual(kept.status, 'sent');
  await retry.locator('.feedback-again').waitFor(); // the result's action where sending works: the same report again
  await page.keyboard.press('Escape');
  delivery.setFailure(false);
  const resent = await rpc.call('feedback.send', { id: kept.id });
  assert.equal(resent.status, 'sent');
  assert.equal((await delivery.records()).reports.length, 2, 'retry does not create a third report');
  assert.deepEqual(await app.evaluate(() => globalThis.__feedbackOpened), [], 'retry opens no browser');
  assert.deepEqual(errors, []); t.diagnostic(`screenshots: ${shots}`);
});
