// Electron window check of "Team activity" (C1) with the demo engine in an isolated test profile:
//   * the Manager opens a room without the human (chat.create) and finishes a task there; the human
//     leaves another chat; a to-do creates the hidden To-do chat;
//   * after a window reload the collapsed "Team activity" section still lists both rooms (they are
//     not in the main list) and the To-do chat appears in no list;
//   * the command palette finds the room (hint "Team activity") but never the To-do chat;
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

test('Team activity: agent rooms stay listed after a reload; the To-do chat is in no list', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-team-'));
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
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // B-044: past the first-run layer on Home (first-run-window covers it)
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks'] });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'seed Manager exists');
  const first = (await rpc.call('chats.list'))[0];

  // The Manager opens a room without the human and finishes a task there.
  await rpc.call('messages.send', { conversationId: first.id, body: `Open a room [[tool:chat.create {"title":"Launch research","agentIds":["${manager.id}"]}]]` });
  const room = await rpc.waitFor('conversation.upserted', (chat) => chat.title === 'Launch research', 90_000);
  await rpc.call('messages.send', { conversationId: first.id, body: `Plan it [[tool:tasks.create {"title":"Compare venues","chatId":"${room.id}","doneWhen":"Three venues compared"}]]` });
  const task = await rpc.waitFor('task.upserted', (item) => item.title === 'Compare venues', 90_000);
  assert.equal(task.conversationId, room.id);
  await rpc.call('tasks.complete', { id: task.id });

  // The human leaves another chat; a to-do creates the To-do chat.
  const left = await rpc.call('chats.create', { title: 'Old project', agentIds: [manager.id] });
  await rpc.call('messages.send', { conversationId: left.id, body: 'Notes about the quarterly offsite' });
  await rpc.call('chats.members', { id: left.id, remove: ['human'] });
  await rpc.call('todos.add', { text: 'Sign the delivery note' });

  // A reload loads the chat snapshot afresh (no conversation.upserted from this connection).
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await go('#/chats');
  const teamSection = page.locator('.chat-list .team-activity');
  await teamSection.waitFor({ timeout: 20_000 });
  const toggle = teamSection.locator('.section-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await teamSection.locator('.row-title', { hasText: exactly('Launch research') }).waitFor({ timeout: 15_000 });
  assert.equal(await teamSection.locator('.row-title', { hasText: exactly('Old project') }).count(), 1, 'the room the human left is under Team activity');
  const mainRows = page.locator('.chat-list .chat-rows .row-title');
  // B-050 K1/K2: the first chat is the default 1:1 with the Manager – untitled, named after it.
  assert.ok(await mainRows.filter({ hasText: exactly(first.title || manager.name) }).count() >= 1, 'the main list still has the first chat');
  assert.equal(await mainRows.filter({ hasText: exactly('Launch research') }).count(), 0, 'agent rooms are not in the main list');
  assert.equal(await page.locator('.chat-list .row-title').filter({ hasText: exactly('To-do') }).count(), 0, 'To-do is in no list');
  await shot('team-01-sidebar-light');

  // The palette finds the room, never the To-do chat.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const palette = page.locator('.palette-input');
  await palette.waitFor({ timeout: 10_000 });
  await palette.fill('To-do');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.palette-label').filter({ hasText: exactly('To-do') }).count(), 0, 'the To-do chat is not offered');
  await palette.fill('Launch');
  const roomEntry = page.locator('.palette-row', { has: page.locator('.palette-label', { hasText: exactly('Launch research') }) });
  await roomEntry.waitFor({ timeout: 10_000 });
  assert.equal((await roomEntry.locator('.menu-hint').textContent())?.trim(), 'Team activity');
  await shot('team-02-palette-light');
  await page.keyboard.press('Escape');

  await go('#/chats');

  // Opening the room from Team activity.
  await teamSection.locator('.chat-row-open', { has: page.locator('.row-title', { hasText: exactly('Launch research') }) }).click();
  await page.waitForFunction((id) => location.hash.includes(id), room.id, { timeout: 10_000 });
  await shot('team-04-room-light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('team-05-room-dark');
  await size(640, 480);
  await shot('team-06-room-640x480');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
