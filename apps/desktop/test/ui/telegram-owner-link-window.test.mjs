// Electron window check of Chat details › Telegram › "Link my Telegram" (C9) with the demo engine
// in an isolated profile. No bot and no network: after a first start two bridge rows are seeded
// into the profile's database whose bot token is not in the vault (the runtime marks them
// 'error' on resume and never calls Telegram) – one plain, one with a linked owner account.
// Checks: the plain row offers "Link my Telegram"; the code shows (8 characters) with the
// /link hint, Cancel withdraws it; the linked row names the account and Unlink (after the
// confirm dialog) clears it and offers the link again (the owner link is always on now).
// Screenshots light, dark and 640×480; no renderer errors.
// /link itself is covered against the fake Bot API (test/unit/bridges/owner-link.test.ts); a real
// bot stays a manual check.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

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
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  const rpc = await connect(info.port, info.token, 'cli');
  return { app, page, errors, rpc };
}

test('Link my Telegram: code with hint, cancel, linked account and unlink', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-tg-owner-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  let current;
  t.after(async () => {
    current?.rpc?.close?.();
    await current?.app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  current = await launch(profile);
  const agents = await current.rpc.call('agents.list');
  const chat = await current.rpc.call('chats.create', { title: 'Telegram link', agentIds: [agents[0].id] });
  current.rpc.close?.();
  await current.app.close();
  current = undefined;

  const db = new DatabaseSync(path.join(profile, 'workforce.db'));
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO bridges (id, kind, conversation_id, secret_id, external_chat_id, cursor, status, error, created_at, updated_at, owner_user_id, owner_name, owner_linked_at)
    VALUES (?, 'telegram', ?, 'sec_not_in_vault', ?, '0', 'connected', NULL, ?, ?, ?, ?, ?)`);
  insert.run('br_ui_plain', chat.id, '-100777', now, now, null, null, null);
  insert.run('br_ui_owner', chat.id, '-100888', now + 1, now + 1, '4242', 'Sam Owner', now);
  db.close();

  current = await launch(profile);
  const { app, page, errors, rpc } = current;
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const openDetails = async () => {
    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    await page.waitForTimeout(1000);
    if (!await page.locator('.chat-details').first().isVisible().catch(() => false)) await page.locator('.chat-title-button').first().click();
    await page.locator('section[aria-label="Telegram"]').waitFor({ timeout: 15_000 });
  };
  await size(1280, 820);
  await openDetails();

  const section = page.locator('section[aria-label="Telegram"]');
  const plain = section.locator('.bridge-row', { hasText: 'Telegram -100777' });
  const linked = section.locator('.bridge-row', { hasText: 'Telegram -100888' });
  await plain.waitFor({ timeout: 15_000 });
  await linked.locator('.bridge-owner', { hasText: 'Linked to Sam Owner on Telegram' }).waitFor({ timeout: 15_000 });
  assert.ok(!(await section.textContent()).includes('4242'), 'the Telegram user id is never shown');

  await plain.getByRole('button', { name: 'Link my Telegram' }).click();
  const code = plain.locator('.pair-code');
  await code.waitFor({ timeout: 15_000 });
  const shown = (await code.textContent()) ?? '';
  assert.match(shown, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.match((await plain.locator('.bridge-owner small').textContent()) ?? '', new RegExp(`^Send /link ${shown} in this Telegram chat from your own account by .*not as an anonymous admin`));
  await section.scrollIntoViewIfNeeded();
  await shot('tg-owner-01-code-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tg-owner-02-code-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await plain.getByRole('button', { name: 'Cancel' }).click();
  await code.waitFor({ state: 'detached', timeout: 10_000 });
  await plain.getByRole('button', { name: 'Link my Telegram' }).waitFor();

  await linked.getByRole('button', { name: 'Unlink' }).click();
  await page.locator('.dialog-actions').getByRole('button', { name: 'Unlink' }).click();
  await linked.getByRole('button', { name: 'Link my Telegram' }).waitFor({ timeout: 10_000 });
  const rows = await rpc.call('bridges.list', { conversationId: chat.id });
  assert.equal(rows.find((row) => row.id === 'br_ui_owner')?.owner, undefined, 'unlinked in the runtime');

  await size(640, 480); // phone layout re-mounts the details
  await page.waitForTimeout(600);
  await openDetails().catch(() => undefined);
  await section.first().scrollIntoViewIfNeeded().catch(() => undefined);
  await shot('tg-owner-03-640x480');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 640 px (${overflow}px)`);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
