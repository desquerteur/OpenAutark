// Electron window check of the chat catch-up (C4) with the demo engine in an isolated profile.
// 40 new messages are made through the runtime RPC while the chat is closed: the manager's answer
// to one message (with an ask block → a to-do for the person) plus 39 chat.send tool posts; a
// finished to-do and a new member add quiet status lines. Then:
//   * opening the chat shows one "New messages" divider before the first new message (the list opens at the newest
//     message – opening at the divider went with the digest, Umbau Einfachheit); the divider stays after markRead
//     cleared the unread count;
//   * scrolled up, an answer that arrives below makes "↓ N new"; a click goes to the newest message and hides it;
//   * the phone layout (640×480, phone width) remounts the chat after markRead – no divider there any more (keeping it
//     over a remount went with the catch-up extras, Umbau Einfachheit); once the person writes there is none either;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
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
const TOOL_POSTS = 39; // + the answer itself = 40 new messages

test('Catch-up: 40 new messages show the divider and "↓ N new"', { timeout: 600_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-catch-up-'));
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
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  /** Where the divider is in the message list: its top relative to the list, and how far the list is from its bottom. */
  const placement = () => page.evaluate(() => {
    const scroller = document.querySelector('.message-scroller');
    const block = document.querySelector('.unread-block');
    if (!scroller || !block) return null;
    return {
      top: block.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      height: scroller.clientHeight,
      fromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  });
  const toDivider = () => page.evaluate(() => document.querySelector('.unread-block')?.scrollIntoView({ block: 'start' }));
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } }); // B-044: past the first-run layer on Home (first-run-window covers it)

  // The chat is closed while everything happens (Home is open), so nothing is marked read.
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.locator('.day-view').waitFor({ timeout: 15_000 });

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const mia = await rpc.call('agents.create', { template: 'video-editor', name: 'Mia', managerId: manager.id });
  const chat = await rpc.call('chats.create', { title: 'Course launch', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks', `chat:${chat.id}`] });
  const todo = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Write the launch post', assigneeKind: 'human' });

  const posts = Array.from({ length: TOOL_POSTS }, (_, i) => `[[tool:chat.send {"text":"Launch update ${i + 1}: edit pass ${i + 1} is finished"}]]`).join('\n');
  const ask = `[[ui:${JSON.stringify({ type: 'choice', question: 'Which thumbnail?', options: ['Bright', 'Dark'] })}]]`;
  const sent = await rpc.call('messages.send', { conversationId: chat.id, body: `Post the launch updates\n${posts}\n${ask}` });
  await rpc.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id
    && message.state === 'final' && message.seq > sent.seq && message.body.includes('chat.send'), 120_000);
  await rpc.call('tasks.complete', { id: todo.id });
  await rpc.call('chats.members', { id: chat.id, add: [mia.id] });
  const before = await rpc.call('chats.get', { id: chat.id });
  assert.ok(before.unread >= 40, `40 new messages are unread (${before.unread})`);

  // Open the chat: the divider; the list opens at the newest message.
  const cleared = rpc.waitFor('conversation.upserted', (summary) => summary.id === chat.id && summary.unread === 0, 30_000);
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.unread-divider').waitFor({ timeout: 15_000 });
  await cleared;
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.unread-divider').count(), 1, 'one divider, kept after markRead');
  const placed = await placement();
  assert.ok(placed && placed.fromBottom < 48, `the list opens at the newest message (${JSON.stringify(placed)})`);

  await toDivider();
  await shot('catch-up-01-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('catch-up-02-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone layout (640×480 and phone width): the remount after markRead shows the chat without a divider.
  await size(640, 480);
  await page.waitForTimeout(800);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  await shot('catch-up-03-640x480');
  assert.ok(await overflow() <= 1, 'no horizontal page scroll at 640×480');
  await size(420, 860);
  await page.waitForTimeout(800);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  await shot('catch-up-04-phone');
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);

  // Scrolled up, the person writes: caught up, the divider is gone; the agent's answer arrives below – "↓ N new" counts
  // it; a click goes to the newest message and hides the pill.
  await size(1280, 820);
  await page.waitForTimeout(600);
  await page.evaluate(() => { document.querySelector('.message-scroller')?.scrollTo(0, 0); });
  await page.waitForTimeout(300);
  const mine = await rpc.call('messages.send', { conversationId: chat.id, body: 'Thanks, all clear' });
  await page.locator('.unread-divider').waitFor({ state: 'detached', timeout: 10_000 });
  await rpc.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id
    && message.state === 'final' && message.seq > mine.seq, 60_000);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.unread-divider').count(), 0, 'no divider after the person wrote');
  const pill = page.locator('.new-pill');
  await pill.waitFor({ timeout: 10_000 });
  const below = Number(/(\d+) new/.exec(((await pill.textContent()) ?? '').trim())?.[1] ?? 0);
  assert.ok(below >= 1, `"↓ N new" counts the answer below (${below})`);
  await shot('catch-up-05-pill');
  await pill.click();
  await pill.waitFor({ state: 'detached', timeout: 5_000 });
  assert.ok((await page.evaluate(() => { const el = document.querySelector('.message-scroller'); return el.scrollHeight - el.scrollTop - el.clientHeight; })) < 48, 'at the newest message');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
