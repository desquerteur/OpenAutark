// Owns: real-window checks of Plus > Secret and the paired mobile PWA, in isolated test data. Owner 04.11.2026: Plus > Secret
// is the composer's secret mode above the text (no dialog): Name | Value rows, a pasted .env splits into rows and each row
// becomes a chip; × or Esc leaves it and stores nothing.
// Never: uses real credentials, the user's profile, or a live model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, chromium } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { detectChannel } from '../../src/runtime/browser/channel.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executablePath = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const VALUE = 'Window-secret-test-value\nwith another line';

test('secret attachment: desktop capture, durable draft, send, four layouts and a paired phone capture', { timeout: 180_000 }, async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-secret-attachments-'));
  const shots = process.env.SCREENSHOTS || path.join(profile, 'screenshots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({ executablePath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' } });
  let rpc, browser;
  t.after(async () => {
    await browser?.close(); rpc?.close(); await app.close().catch(() => {});
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const manager = (await rpc.call('agents.list')).find(agent => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { agentIds: [manager.id] });
  await page.evaluate(id => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.composer').waitFor();
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
  const shot = name => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const barOf = target => target.locator('.composer .secret-band.chat');
  const start = async target => {
    await target.getByRole('button', { name: 'Add', exact: true }).click();
    await target.getByRole('menuitem', { name: 'Secret', exact: true }).click();
    await barOf(target).waitFor();
    assert.equal(await target.locator('dialog[open]').count(), 0, 'no dialog');
  };
  const capture = async (target, value, context) => {
    await start(target);
    await barOf(target).getByLabel('Value 1', { exact: true }).fill(value);
    if (context) await barOf(target).getByRole('textbox', { name: 'Name 1', exact: true }).fill(context);
    await barOf(target).getByRole('button', { name: 'Attach', exact: true }).click();
    await target.locator('.composer .secret-attachments .file-chip').waitFor();
    await barOf(target).waitFor({ state: 'detached' });
    assert.ok(!(await target.content()).includes(value));
  };
  const pasteInto = (locator, text) => locator.evaluate((field, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await size(1280, 820);
  await capture(page, VALUE, 'Support mailbox login');
  await shot('secret-attachment-desktop-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('secret-attachment-desktop-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  const saved = await rpc.call('secrets.list');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].label, 'Support mailbox login', 'named from its description');
  assert.equal(saved[0].description, 'Support mailbox login');
  await page.waitForTimeout(750); // draft debounce is 600 ms
  const draftState = await rpc.call('ui.state');
  assert.deepEqual(draftState.secretDrafts?.[chat.id], [saved[0].id], 'vault reference persists in ui.state');
  await page.reload();
  await page.locator('.composer').waitFor();
  await shot('secret-attachment-reloaded');
  await page.locator('.composer .secret-attachments .file-chip').waitFor();
  await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.message.human .secret-attachments .file-chip').waitFor();
  assert.equal(await page.locator('.composer .secret-attachments .file-chip').count(), 0);
  const messages = await rpc.call('messages.list', { conversationId: chat.id });
  assert.ok(messages.some(message => message.meta.secrets?.includes(saved[0].id)));
  assert.ok(!JSON.stringify(messages).includes(VALUE));

  // A pasted .env splits into rows; each row becomes its own chip, named after its key.
  await start(page);
  await pasteInto(barOf(page).getByRole('textbox', { name: 'Name 1', exact: true }), 'API_KEY=window-one-value\nAPI_TOKEN=window-two-value');
  assert.equal(await barOf(page).locator('.secret-kv-row').count(), 3, 'two rows and the empty one');
  await shot('secret-attachment-rows');
  await barOf(page).getByRole('button', { name: 'Attach', exact: true }).click();
  await barOf(page).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.composer .secret-attachments .file-chip').count(), 2);
  assert.deepEqual((await rpc.call('secrets.list')).map(info => info.label).sort(), ['API_KEY', 'API_TOKEN', 'Support mailbox login']);
  assert.ok(!(await page.content()).includes('window-one-value'));
  await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.composer .secret-attachments .file-chip').length === 0, undefined, { timeout: 10_000 });

  for (const [width, height, name, leave] of [[640, 480, 'compact', 'x'], [420, 860, 'phone-width', 'Escape']]) {
    await size(width, height);
    await start(page);
    await barOf(page).getByLabel('Value 1', { exact: true }).fill(VALUE);
    await shot(`secret-attachment-${name}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (leave === 'x') await barOf(page).getByRole('button', { name: 'Leave secret mode', exact: true }).click();
    else await page.keyboard.press('Escape');
    await barOf(page).waitFor({ state: 'detached' });
  }
  assert.equal((await rpc.call('secrets.list')).length, 3, 'leaving stores no value');

  await rpc.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const link = await rpc.call('pwa.link', { name: 'Secret test phone' });
  browser = await chromium.launch({ channel: process.env.WORKFORCE_PWA_CHANNEL || detectChannel(), headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(`http://localhost:${info.port}/${new URL(link.url).hash}`); // localhost: a secure context, as over adb reverse
  await phone.waitForSelector('.mobile-shell', { timeout: 30_000 });
  await phone.evaluate(id => { location.hash = `#/chat/${id}`; }, chat.id);
  await phone.locator('.composer').waitFor();
  await capture(phone, 'Phone-secret-test-value', 'Phone supplied integration value');
  await phone.screenshot({ path: path.join(shots, 'secret-attachment-paired-pwa.png') });
  await phone.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
  await phone.locator('.message.human .secret-attachments .file-chip').last().waitFor();
  assert.equal((await rpc.call('secrets.list')).length, 4);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
});
