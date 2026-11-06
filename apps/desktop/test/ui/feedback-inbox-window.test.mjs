// Owns: the real-window feedback privacy notice and owner's inbox: encrypted fetch, readable text/image,
// stable selection, a visible right-click menu in the dialog, deletion, empty/error states and narrow themes.
// Never: uses a real account, reaches Google or touches the person's profile. Needs a current local build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { feedbackSubmitFixture } from '../e2e/lib/feedback-submit.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('feedback privacy is available before sending; the team inbox reads text and images in a stable dialog', { timeout: 240_000 }, async (t) => {
  const delivery = await feedbackSubmitFixture();
  const receiver = await readFile(delivery.receiverFile, 'utf8');
  await writeFile(delivery.receiverFile, ''); // begin with sending not set up
  const profile = await mkdtemp(path.join(os.tmpdir(), 'wf-feedback-inbox-window-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  let app;
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await delivery.close();
    await app?.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  }, { timeout: 30_000 });
  app = await electron.launch({ executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, ...delivery.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 320); win.setContentSize(w, h);
  }, [width, height]);
  await size(1120, 780);
  const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
  const menu = page.locator('.popover.feedback-menu');
  const privacy = page.getByRole('dialog', { name: 'Feedback privacy', exact: true });
  const inbox = page.getByRole('dialog', { name: 'Feedback inbox', exact: true });
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

  await feedback.click(); await menu.waitFor();
  await menu.getByText('Save keeps this report on your PC. Nothing is sent.', { exact: false }).waitFor();
  assert.equal(await menu.getByRole('button', { name: 'Inbox', exact: true }).count(), 0, 'no team key: no inbox control');
  await menu.getByRole('button', { name: 'Feedback privacy', exact: true }).click();
  await privacy.waitFor(); await menu.waitFor({ state: 'detached' });
  for (const text of ['Who receives it.', 'What is sent.', 'Google Cloud Firestore', 'Storage.', 'Your rights.']) {
    assert.ok((await privacy.textContent()).includes(text), `privacy details include ${text}`);
  }
  assert.equal(delivery.docs.size, 0, 'reading privacy does not send a report');
  await shot('feedback-privacy-light');
  await size(390, 720);
  await page.waitForFunction(() => innerWidth === 390 && innerHeight === 720);
  await privacy.waitFor();
  await shot('feedback-privacy-phone');
  await page.emulateMedia({ colorScheme: 'dark' });
  await size(640, 480);
  await page.waitForFunction(() => innerWidth === 640 && innerHeight === 480);
  await privacy.waitFor();
  await shot('feedback-privacy-small-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(1120, 780);
  await page.waitForFunction(() => innerWidth === 1120 && innerHeight === 780);
  await privacy.waitFor();
  await privacy.locator('.dialog-footer').getByRole('button', { name: 'Close', exact: true }).click(); await privacy.waitFor({ state: 'hidden' });

  await writeFile(delivery.receiverFile, receiver);
  await rpc.call('feedback.setup', { project: delivery.project, apiKey: delivery.apiKey, serviceAccountPath: delivery.serviceAccountFile });
  await feedback.click(); await menu.waitFor();
  await menu.getByText('Text, selected screenshot and app/system details are sent encrypted to Teydra Lab.', { exact: false }).waitFor();
  await menu.getByRole('button', { name: 'Inbox', exact: true }).waitFor();
  await menu.getByRole('button', { name: 'Feedback privacy', exact: true }).click(); await privacy.waitFor();
  assert.equal(delivery.docs.size, 0, 'configured privacy read still sends nothing');
  await privacy.locator('.dialog-footer').getByRole('button', { name: 'Close', exact: true }).click();

  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3050a0'; ctx.fillRect(0, 0, 48, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const file = await rpc.call('files.upload', { name: 'test-feedback.png', mime: 'image/png', dataBase64: image });
  const report = await rpc.call('feedback.create', { kind: 'bug', text: 'A window test report with its screenshot.', screenshotFileId: file.id });
  await rpc.call('feedback.send', { id: report.id });
  assert.ok(delivery.log.some((entry) => entry.startsWith('create ')), 'the sender uploaded an encrypted report');
  await feedback.click(); await menu.waitFor();
  await menu.getByRole('button', { name: 'Inbox', exact: true }).click();
  await inbox.waitFor(); await menu.waitFor({ state: 'detached' });
  await inbox.locator('.feedback-inbox-text').getByText(report.text, { exact: true }).waitFor();
  await inbox.getByRole('img', { name: 'Feedback screenshot' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.feedback-inbox-image img')?.naturalWidth === 48);
  assert.equal(delivery.docs.size, 0, 'opened and saved on the team PC, then deleted from mailbox');
  const received = (await rpc.call('feedback.inboxList'))[0];
  assert.equal((await rpc.call('feedback.inboxScreenshot', { id: received.id })).dataBase64, image);
  await inbox.getByRole('button', { name: 'Refresh', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.feedback-inbox-refresh')?.disabled);
  await shot('feedback-inbox-light');

  const second = await rpc.call('feedback.create', { kind: 'idea', text: 'A second report without an attachment.' });
  await rpc.call('feedback.send', { id: second.id });
  await expectStable(page, ['.feedback-inbox', '.feedback-inbox-list', '.feedback-inbox-refresh'], async () => {
    await inbox.getByRole('button', { name: 'Refresh', exact: true }).click();
    await inbox.locator('.feedback-inbox-row').filter({ hasText: second.text }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.feedback-inbox-refresh')?.disabled);
  });
  assert.equal(await inbox.locator('.feedback-inbox-text').textContent(), report.text, 'refresh preserves selection');
  const secondRow = inbox.locator('.feedback-inbox-row').filter({ hasText: second.text });
  await expectStable(page, ['.feedback-inbox', '.feedback-inbox-list', '.feedback-inbox-refresh'], async () => {
    await secondRow.click();
    await inbox.locator('.feedback-inbox-text').getByText(second.text, { exact: true }).waitFor();
  });
  await secondRow.click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Context menu', exact: true });
  await context.waitFor();
  assert.equal(await context.evaluate((element) => element.closest('dialog')?.getAttribute('aria-label')), 'Feedback inbox', 'context menu lives in the modal top layer');
  await context.getByRole('menuitem', { name: 'Read', exact: true }).click();
  await context.waitFor({ state: 'detached' });

  // Missing local screenshot is shown as an error, while report text remains readable.
  const imageFile = path.join(profile, 'feedback-inbox', `${received.id}.png`);
  await rename(imageFile, `${imageFile}.held`);
  await inbox.locator('.feedback-inbox-row').filter({ hasText: report.text }).click();
  await inbox.getByText('This report has no screenshot.', { exact: true }).waitFor();
  await rename(`${imageFile}.held`, imageFile);
  await secondRow.click();
  await inbox.locator('.feedback-inbox-row').filter({ hasText: report.text }).click();
  await inbox.getByRole('img', { name: 'Feedback screenshot' }).waitFor();

  for (const [theme, width, height, name] of [['dark', 1120, 780, 'dark'], ['light', 640, 480, 'small'], ['dark', 390, 720, 'phone']]) {
    await page.emulateMedia({ colorScheme: theme });
    await size(width, height);
    await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
    await inbox.waitFor();
    await inbox.locator('.feedback-inbox-text').getByText(report.text, { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.feedback-inbox-refresh')?.disabled);
    await inbox.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const bounds = await inbox.boundingBox();
    t.diagnostic(`${name}: ${JSON.stringify(bounds)}`);
    await shot(`feedback-inbox-${name}`);
    assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, `${name}: inbox fits window`);
  }
  await size(1120, 780);
  await page.waitForFunction(() => innerWidth === 1120 && innerHeight === 780);
  await inbox.locator('.feedback-inbox-text').getByText(report.text, { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.feedback-inbox-refresh')?.disabled);
  await inbox.getByRole('button', { name: 'Delete', exact: true }).click();
  await inbox.locator('.feedback-inbox-text').getByText(second.text, { exact: true }).waitFor();
  await inbox.getByRole('button', { name: 'Delete', exact: true }).click();
  await inbox.getByText('No reports yet.', { exact: true }).waitFor();
  assert.deepEqual(await rpc.call('feedback.inboxList'), []);
  await shot('feedback-inbox-empty');
  await inbox.getByRole('button', { name: 'Close', exact: true }).click();
  await inbox.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});
