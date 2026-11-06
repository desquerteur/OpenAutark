// Electron window check of reply, edit and delete (C6) with the demo engine in an isolated profile:
//   * Reply (the agent's answer's right-click menu) puts "Replying to <Manager>" above the composer
//     field; Esc cancels it, Reply again and Enter sends – the sent message shows the quote line
//     above its body, and a click on the quote highlights the quoted answer;
//   * the agent's answer's menu offers Reply and Copy; the person's message Reply, Copy, Edit, Remember why…, Delete;
//   * Edit swaps the body for the inline editor: Esc cancels (body unchanged), Ctrl+Enter saves –
//     the new body and "edited" show; the runtime's notice for agents is not shown;
//   * Delete asks first; Cancel keeps it, Delete leaves "Message deleted" at its place and the
//     reply's quote then reads "Deleted message";
//   * phone width (420×860, the mobile shell): a long touch press opens the message menu (Reply,
//     Copy, Edit, Remember why… – F-52, the person's own message – and Delete); the reply chip, the
//     quote line and the inline editor fit the width; no horizontal page scroll;
//   * screenshots light, dark and phone; no renderer errors.
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

test('Reply, edit and delete: quote chip, inline editor, tombstone, long-press menu at phone width', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-reply-edit-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480); // the app's 640 px minimum would keep the window wider than a phone
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  const answerAfter = (seq) => rpc.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id
    && message.state === 'final' && message.seq > seq, 60_000);
  const item = (id) => page.locator(`[data-message-id="${id}"]`);
  const menu = page.locator('.menu[aria-label="Context menu"]');
  const menuItems = async () => (await menu.locator('[role="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  /** The message's right-click menu, then one of its entries. */
  const act = async (id, label) => {
    await item(id).locator('.message-content').click({ button: 'right' });
    await menu.waitFor({ timeout: 5_000 });
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
  };

  const first = await rpc.call('messages.send', { conversationId: chat.id, body: 'Plan the launch for Friday' });
  const answer = await answerAfter(first.seq);
  await item(answer.id).locator('.message-content').waitFor({ timeout: 15_000 });

  // The agent's answer: Reply and Copy only.
  await item(answer.id).locator('.message-content').click({ button: 'right' });
  await menu.waitFor({ timeout: 5_000 });
  assert.deepEqual(await menuItems(), ['Reply', 'Start thread', 'Copy'], "no Edit or Delete on the agent's answer");
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);

  // Reply → chip; Esc cancels; Reply again → Enter sends with the quote.
  await act(answer.id, 'Reply');
  const chip = page.locator('.composer .reply-quote.in-composer');
  await chip.waitFor({ timeout: 5_000 });
  assert.match((await chip.textContent()) ?? '', new RegExp(`Replying to ${manager.name}`));
  await page.locator('.composer-input').press('Escape');
  await chip.waitFor({ state: 'detached', timeout: 5_000 });
  await act(answer.id, 'Reply');
  await chip.waitFor({ timeout: 5_000 });
  await shot('reply-01-chip-light');
  await page.locator('.composer-input').fill('Make it shorter');
  const sent = rpc.waitFor('message.created', (message) => message.conversationId === chat.id && message.authorId === 'human' && message.body === 'Make it shorter', 15_000);
  await page.locator('.composer-input').press('Enter');
  const reply = await sent;
  assert.equal(reply.replyTo, answer.id, 'sent as a reply');
  await chip.waitFor({ state: 'detached', timeout: 5_000 });
  const quote = item(reply.id).locator('.reply-quote');
  await quote.waitFor({ timeout: 5_000 });
  assert.match((await quote.textContent()) ?? '', new RegExp(manager.name));
  await answerAfter(reply.seq);
  await quote.locator('.reply-quote-jump').click();
  await page.waitForSelector(`[data-message-id="${answer.id}"].flash`, { timeout: 5_000 });

  // Edit: Esc cancels, Ctrl+Enter saves; "edited" shows, the notice for agents does not.
  await act(first.id, 'Edit');
  const editor = item(first.id).locator('.message-edit-input');
  await editor.waitFor({ timeout: 5_000 });
  await editor.fill('Plan the launch for Saturday');
  await editor.press('Escape');
  await editor.waitFor({ state: 'detached', timeout: 5_000 });
  assert.match((await item(first.id).locator('.message-content').textContent()) ?? '', /for Friday/, 'cancelled: unchanged');
  await act(first.id, 'Edit');
  await editor.waitFor({ timeout: 5_000 });
  await shot('reply-02-editing-light');
  await editor.fill('Plan the launch for Monday');
  await editor.press('Control+Enter');
  await editor.waitFor({ state: 'detached', timeout: 5_000 });
  await page.waitForFunction((id) => document.querySelector(`[data-message-id="${id}"] .message-content`)?.textContent?.includes('for Monday'), first.id, { timeout: 5_000 });
  assert.equal(await item(first.id).locator('.edited-marker').count(), 1, '"edited" by the time');
  assert.equal(await page.getByText(/was edited/).count(), 0, "the agents' notice is not shown");

  // Delete: Cancel keeps it, Delete leaves the tombstone; the reply's quote reads "Deleted message".
  const doomed = await rpc.call('messages.send', { conversationId: chat.id, body: 'Wrong chat, sorry' });
  await answerAfter(doomed.seq);
  const quoting = await rpc.call('messages.send', { conversationId: chat.id, body: 'About that', replyTo: doomed.id });
  await answerAfter(quoting.seq);
  await act(doomed.id, 'Delete');
  await page.locator('.dialog-actions .button.secondary').click();
  await page.locator('.dialog-actions').waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await item(doomed.id).count(), 1, 'Cancel keeps it');
  await act(doomed.id, 'Delete');
  await page.locator('.dialog-actions .danger-fill').click();
  await item(doomed.id).waitFor({ state: 'detached', timeout: 5_000 });
  await page.getByText('Message deleted').first().waitFor({ timeout: 5_000 });
  await page.waitForFunction((id) => document.querySelector(`[data-message-id="${id}"] .reply-quote`)?.textContent?.includes('Deleted message'), quoting.id, { timeout: 5_000 });
  await shot('reply-03-deleted-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('reply-04-deleted-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone width: a long touch press opens the menu; chip, quote and editor fit.
  await size(420, 860);
  await page.waitForTimeout(800);
  const target = item(reply.id).locator('.message-content');
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, 'the reply is on screen');
  await page.evaluate(([id, x, y]) => {
    const element = document.querySelector(`[data-message-id="${id}"] .message-content`);
    element?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
  }, [reply.id, box.x + 10, box.y + 10]);
  await menu.waitFor({ timeout: 3_000 });
  assert.deepEqual(await menuItems(), ['Reply', 'Start thread', 'Copy', 'Edit', 'Remember why…', 'Delete']);
  await shot('reply-05-menu-phone');
  await menu.getByRole('menuitem', { name: 'Reply' }).click();
  await chip.waitFor({ timeout: 5_000 });
  const fits = (selector) => page.evaluate((query) => [...document.querySelectorAll(query)].every((element) => {
    const rect = element.getBoundingClientRect();
    return rect.right <= document.documentElement.clientWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  }), selector);
  assert.ok(await fits('.reply-quote'), 'the chip and the quote lines fit the phone width');
  await shot('reply-06-chip-phone');
  await page.locator('.composer-input').press('Escape');
  await item(first.id).locator('.message-content').scrollIntoViewIfNeeded();
  const firstBox = await item(first.id).locator('.message-content').boundingBox();
  await page.evaluate(([id, x, y]) => {
    document.querySelector(`[data-message-id="${id}"] .message-content`)
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
  }, [first.id, firstBox.x + 10, firstBox.y + 10]);
  await menu.waitFor({ timeout: 3_000 });
  await menu.getByRole('menuitem', { name: 'Edit' }).click();
  await editor.waitFor({ timeout: 5_000 });
  assert.ok(await fits('.message-edit'), 'the inline editor fits the phone width');
  await shot('reply-07-editing-phone');
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  await editor.press('Escape');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
