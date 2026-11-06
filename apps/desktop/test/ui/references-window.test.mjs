// Electron window check of the references (Umbau Einfachheit: "Remember why…" in the message menu) with the demo
// engine in an isolated test profile:
//   * the person's own message's right-click menu holds Reply, Copy, Edit, Remember why…, Delete; the agent's answer
//     offers no "Remember why…";
//   * Remember why… opens the one-field dialog with the message quoted; Keep is off until a reason is typed; Keep
//     stores the message as an example and the reason – knowledge items of scope 'reference' from that message –
//     and closes the dialog;
//   * no references settings (rights, export) any more: Settings has no Knowledge group;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Owns: these window assertions. Never: a real engine, account or network (demo engine, test profile).
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

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

test('references: Remember why… on an own message keeps the example and the reason; light/dark/small/phone', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-references-'));
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
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await size(1280, 820);
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  // The chat: the person's message and the Manager's answer.
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Pricing', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  const own = await rpc.call('messages.send', { conversationId: chat.id, body: 'We keep the price and add a second revision round instead of a discount.' });
  const answer = await rpc.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.state === 'final', 60_000);
  const item = (id) => page.locator(`[data-message-id="${id}"]`);
  await item(answer.id).locator('.message-content').waitFor({ timeout: 15_000 });
  await item(own.id).locator('.message-content').waitFor({ timeout: 15_000 });
  const menu = page.locator('[role="menu"]').last();
  const menuItems = async () => (await menu.locator('[role="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());

  // The agent's answer: no Remember why….
  await item(answer.id).locator('.message-content').click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  assert.equal((await menuItems()).includes('Remember why…'), false, "not on the agent's answer");
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);

  // The person's own message: Reply, Copy, Edit, Remember why…, Delete.
  await item(own.id).locator('.message-content').click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  assert.deepEqual(await menuItems(), ['Reply', 'Copy', 'Edit', 'Remember why…', 'Delete']);
  await shot('references-01-menu-light');
  await menu.getByRole('menuitem', { name: 'Remember why…' }).click();
  const dialog = page.locator('dialog.remember-why[open]');
  await dialog.waitFor({ timeout: 5_000 });
  assert.match(await dialog.locator('.remember-quote').textContent(), /second revision round/, 'the message is quoted');
  const keep = dialog.getByRole('button', { name: 'Keep', exact: true });
  assert.equal(await keep.isDisabled(), true, 'Keep waits for a reason');
  await dialog.locator('#remember-why-text').fill('A discount trains customers to wait for the next one.');
  assert.equal(await keep.isDisabled(), false);
  await shot('references-02-remember-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('references-03-remember-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await keep.click();
  await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  assert.equal(await page.locator('dialog.remember-why[open]').count(), 0, 'the dialog closed');

  // Kept: knowledge items of scope 'reference' – the example (the message) and the reason.
  let kept = [];
  for (let i = 0; i < 50; i += 1) {
    kept = (await rpc.call('knowledge.list', { scope: 'reference', limit: 50 })).items ?? [];
    if (kept.length >= 2) break;
    await page.waitForTimeout(100);
  }
  const bodies = kept.map((entry) => entry.body).join('\n');
  assert.ok(kept.length >= 2, `the example and the reason are kept (${kept.length})`);
  assert.match(bodies, /second revision round/, 'the message is the example');
  assert.match(bodies, /A discount trains customers to wait/, 'the reason is kept');

  // No references settings any more.
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.locator('.settings-view').waitFor({ timeout: 10_000 });
  const groups = (await page.locator('section.set-group > header h3').allTextContents()).map((title) => title.trim());
  assert.equal(groups.some((title) => /reference|knowledge/i.test(title)), false, `no references or knowledge group: ${groups.join(' | ')}`);

  // Small window and phone width: the chat without horizontal scroll.
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  for (const [name, width, height] of [['references-04-640x480', 640, 480], ['references-05-phone', 420, 860]]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await shot(name);
    const extra = await overflow();
    assert.ok(extra <= 1, `no horizontal page scroll at ${width}×${height} (${extra}px)`);
  }
  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
