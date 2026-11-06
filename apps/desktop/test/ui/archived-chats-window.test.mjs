// Electron window check of the chat archive (C2) with the demo engine in an isolated test profile:
//   * the chat row's right-click menu › Archive: the confirmation counts the open tasks that keep running;
//   * the chat leaves the main list for the collapsed, muted "Archived" section at the end of the
//     list, which survives a window reload (the snapshot lists archived chats);
//   * the archived row's right-click menu offers "Unarchive", which brings it back;
//   * archived again, the agent still answers there, and its important message (chat.send urgent)
//     brings the chat back by itself with one quiet "Unarchived: …" line;
//   * screenshots light, dark and 640×480; no renderer errors.
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
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

test('Archived: the confirm counts open tasks, the section survives a reload, Unarchive and auto-unarchive bring the chat back', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-archive-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks'] });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'seed Manager exists');
  const chat = await rpc.call('chats.create', { title: 'Offsite plan', agentIds: [manager.id] });
  const rowName = `${manager.name} · Offsite plan`; // B-050 K2: a two-member chat is named after the other member
  await rpc.call('events.subscribe', { topics: [`chat:${chat.id}`] });
  await rpc.call('todos.add', { text: 'Book the train', conversationId: chat.id });
  await rpc.call('todos.add', { text: 'Ask for the budget', conversationId: chat.id });

  const mainRow = page.locator('.chat-list .chat-rows .row-title', { hasText: exactly(rowName) });
  const archivedSection = page.locator('.chat-list .archived-chats');
  const contextMenu = page.locator('.menu[aria-label="Context menu"]');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });

  // Archive from the row's right-click menu: the confirmation counts the two open to-dos.
  await page.evaluate(() => { location.hash = '#/chats'; });
  await mainRow.waitFor({ timeout: 20_000 });
  await mainRow.click({ button: 'right' });
  await contextMenu.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor({ timeout: 10_000 });
  assert.equal((await dialog.locator('.dialog-text').textContent())?.trim(),
    'It leaves your chat list. Work on its 2 open tasks goes on, and it comes back when something needs you.');
  await shot('archive-01-confirm-light');
  await dialog.locator('.dialog-actions button', { hasText: /^Archive$/ }).click();
  await mainRow.waitFor({ state: 'detached', timeout: 10_000 });

  // The collapsed Archived section; it survives a reload (the snapshot lists archived chats).
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await archivedSection.waitFor({ timeout: 20_000 });
  assert.equal(await mainRow.count(), 0, 'not in the main list');
  assert.equal((await archivedSection.locator('.nav-count').textContent())?.trim(), '1');
  const toggle = archivedSection.locator('.section-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const archivedRow = archivedSection.locator('.chat-row.muted-row', { has: page.locator('.row-title', { hasText: exactly(rowName) }) });
  await archivedRow.waitFor({ timeout: 10_000 });
  await shot('archive-02-section-light');

  // Unarchive from the archived row's right-click menu.
  await archivedRow.click({ button: 'right' });
  await contextMenu.getByRole('menuitem', { name: 'Unarchive', exact: true }).click();
  await mainRow.waitFor({ timeout: 10_000 });
  await archivedSection.waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal((await rpc.call('chats.get', { id: chat.id })).archivedAt, undefined);

  // Archived again: the agent keeps working there, and its important message brings the chat back.
  await rpc.call('chats.archive', { id: chat.id });
  await mainRow.waitFor({ state: 'detached', timeout: 10_000 });
  await rpc.call('messages.send', { conversationId: chat.id, body: 'Tell me loudly [[tool:chat.send {"text":"The venue cancelled","urgent":true}]]' });
  const line = await rpc.waitFor('message.created', (message) => message.conversationId === chat.id && message.meta?.status?.type === 'unarchived', 90_000);
  assert.equal(line.body, `Unarchived: important message from ${manager.name}`);
  await mainRow.waitFor({ timeout: 15_000 });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-list, .chat-column').first().waitFor({ timeout: 10_000 });
  await shot('archive-03-back-light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('archive-04-back-dark');
  await rpc.call('chats.archive', { id: chat.id });
  await archivedSection.waitFor({ timeout: 10_000 });
  await shot('archive-05-section-dark');
  await size(640, 480);
  await shot('archive-06-640x480');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 640 px (${overflow}px)`);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
