// Owns: the Electron check of AF-003 ("feedback does not work, nothing in the log") against a local fake of the team's
// mailbox (WORKFORCE_FEEDBACK_RECEIVER, unpackaged only): from the header's feedback cell a Bug and an Idea are sent,
// each confirmed with "Sent to the team." and "Report no. …" (the receipt the mailbox holds), both arrive with their
// kind, Settings › Feedback lists both as sent with their number; then the mailbox goes away (server not reachable)
// and Send says "Not sent." with the reason as an alert and offers "Send again"; runtime.log has a line for every
// save, delivery and the failure (with its reason), never the report text.
// Never: contacts Google, Firebase or Teydra's real mailbox, opens a browser or touches the person's profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { feedbackSubmitFixture } from '../e2e/lib/feedback-submit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('AF-003: a Bug and an Idea reach the local mailbox and read as sent with their number; an unreachable server is a clear error', { timeout: 240_000 }, async (t) => {
  const delivery = await feedbackSubmitFixture();
  let mailboxOpen = true;
  t.after(async () => { if (mailboxOpen) await delivery.close(); });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autark-af003-feedback-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  // Our own copy of the receiver file: closing the fixture removes its file, and step 4 needs a receiver whose server is gone.
  const receiverFile = path.join(path.dirname(profile), `${path.basename(profile)}-receiver.json`);
  await copyFile(delivery.receiverFile, receiverFile);
  t.after(() => rm(receiverFile, { force: true }));
  const app = await electron.launch({ executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_FEEDBACK_RECEIVER: receiverFile, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 820));
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  assert.deepEqual(await rpc.call('feedback.status'), { sending: true, receiving: false }, 'the app sends to the local fake mailbox');
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const cell = page.locator('.frame-feedback-cell').getByRole('button', { name: 'Feedback', exact: true });
  const menu = page.locator('.popover.feedback-menu');

  /** Opens the menu, picks the kind, writes the text, presses Send; returns the menu after the result line appeared. */
  const send = async (kind, text) => {
    await cell.click();
    await menu.waitFor();
    const group = menu.getByRole('radiogroup', { name: 'Kind of feedback' });
    await group.getByRole('radio', { name: kind, exact: true }).click();
    assert.equal(await group.getByRole('radio', { name: kind, exact: true }).getAttribute('aria-checked'), 'true');
    await menu.getByRole('textbox', { name: 'Your feedback' }).fill(text);
    await menu.locator('.feedback-thumb img').waitFor(); // the window shot is part of the report
    await shot(`af003-form-${kind.toLowerCase()}`);
    await menu.getByRole('button', { name: 'Send', exact: true }).click();
    await menu.locator('.feedback-done').waitFor();
  };
  const reportOf = async (text) => (await rpc.call('feedback.list')).find((report) => report.text === text);

  // 1. A Bug and an Idea: each confirmed with its number.
  const sentNumbers = [];
  for (const [kind, text] of [['Bug', 'AF-003: the sidebar flickers when I resize'], ['Idea', 'AF-003: please add a compact list view']]) {
    await send(kind, text);
    await menu.locator('.feedback-done.ok', { hasText: 'Sent to the team.' }).waitFor();
    const report = await reportOf(text);
    assert.equal(report.status, 'sent');
    assert.equal(report.kind, kind.toLowerCase());
    const number = report.receiptId.replace(/-/g, '').slice(0, 8).toUpperCase();
    assert.equal((await menu.locator('.feedback-receipt-number').textContent()).trim(), `Report no. ${number}`);
    assert.equal(await menu.getByRole('button', { name: 'Copy the report number' }).count(), 1);
    assert.equal(await menu.locator('.feedback-message').textContent(), '', 'no error');
    sentNumbers.push([kind.toLowerCase(), number, report.receiptId]);
    await shot(`af003-sent-${kind.toLowerCase()}`);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 5_000 });
  }

  // 2. Both arrived at the local mailbox, with their kind, text, screenshot and the same id the sender shows.
  const { reports } = await delivery.records();
  assert.deepEqual(reports.map((report) => [report.kind, report.text]).sort(), [['bug', 'AF-003: the sidebar flickers when I resize'], ['idea', 'AF-003: please add a compact list view']]);
  assert.deepEqual(reports.map((report) => report.docId).sort(), sentNumbers.map(([, , receipt]) => receipt).sort());
  assert.ok(reports.every((report) => report.screenshot?.base64), 'each with its screenshot');

  // 3. Settings › Feedback lists both as sent, with their number.
  await page.evaluate(() => { location.hash = '#/settings/feedback'; });
  await page.locator('.settings-content[data-section="feedback"]').waitFor({ timeout: 10_000 });
  for (const [kind, number] of sentNumbers) {
    await page.getByText(new RegExp(`^${kind === 'bug' ? 'Bug' : 'Idea'} · Sent to the team · No\\. ${number} · `)).waitFor({ timeout: 10_000 });
  }
  await shot('af003-settings-sent');

  // 4. The server goes away: Send says "Not sent." and why, keeps the report and offers "Send again".
  await delivery.close(); mailboxOpen = false;
  await send('Bug', 'AF-003: sent while the server is down');
  await menu.locator('.feedback-done.failed', { hasText: 'Not sent. Your report is saved on this PC.' }).waitFor();
  const alert = menu.getByRole('alert');
  await alert.filter({ hasText: 'the feedback server is not reachable' }).waitFor();
  assert.equal(await menu.getByRole('button', { name: 'Send again', exact: true }).count(), 1);
  assert.equal(await menu.locator('.feedback-receipt').count(), 0, 'no number without delivery');
  assert.equal((await reportOf('AF-003: sent while the server is down')).status, 'local', 'kept on this PC');
  await shot('af003-offline-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('af003-offline-dark'); await page.emulateMedia({ colorScheme: 'light' });

  // 5. The runtime log has every step – and no report text.
  const log = (await readFile(path.join(profile, 'logs', 'runtime.log'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const named = (msg) => log.filter((entry) => entry.msg === msg);
  assert.equal(named('feedback sending is set up').length, 1, 'the start says it can send');
  assert.equal(named('feedback saved').length, 3);
  assert.deepEqual(named('feedback sent').map((entry) => entry.data?.receipt).sort(), sentNumbers.map(([, , receipt]) => receipt).sort());
  const failed = named('feedback send failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'warn');
  assert.equal(failed[0].data?.reason, 'offline');
  assert.equal(named('feedback stays on this PC: sending is not set up in this build').length, 0, 'sending was set up throughout');
  assert.equal(JSON.stringify(log).includes('sidebar flickers'), false, 'no report text in the log');
  assert.deepEqual(await app.evaluate(() => globalThis.__feedbackOpened), [], 'no browser opened');
  assert.deepEqual(errors, []);
  t.diagnostic(`screenshots: ${shots}`);
});
