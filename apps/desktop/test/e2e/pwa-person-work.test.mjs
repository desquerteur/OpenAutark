// End-to-end (F-52, wave 2): a person of the organisation at work in a real browser on a phone viewport
// against the headless runtime (fake engine). Anna joins from her invite link (the owner allows it),
// attaches a file in her chat through the composer (it goes up chunked with the chat's id and reaches the
// owner as her attachment, under her name). (Settings › General with her quiet hours and the "Ask my manager" button
// went – Umbau Einfachheit.)
// Uses an installed Chrome or Edge through playwright-core (never downloads one); skipped without.
// Run: npm run build && node --test test/e2e/pwa-person-work.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { detectChannel } from '../../src/runtime/browser/channel.ts';
import { startRuntime } from './lib/runtime-client.mjs';

function installedChannel() {
  try { return detectChannel(); } catch { return undefined; }
}
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' };

async function until(read, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('a person attaches a file in her chat', {
  timeout: 240_000,
  skip: channel ? false : 'No installed Google Chrome or Microsoft Edge was found – this test uses an installed browser and never downloads one.',
}, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const owner = runtime.client;
  await owner.call('pwa.enable', { enabled: true, bind: 'localhost' });
  const agent = (await owner.call('agents.list'))[0];
  const anna = await owner.call('people.save', { name: 'Anna Berg', title: 'Designer', scopes: { spaces: 'all', startChats: true, assignAgents: true }, managerId: 'human' });
  const chat = await owner.call('chats.create', { title: 'Launch plan', agentIds: [agent.id], people: [anna.id] });
  const task = await owner.call('tasks.create', { conversationId: chat.id, title: 'Pick the colours', assigneeKind: 'human', assigneeId: anna.id });
  const ownerNotifications = (await owner.call('settings.get')).notifications;
  const invite = await owner.call('people.invite', { id: anna.id });

  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  const errors = [];
  const phone = await (await browser.newContext(PHONE)).newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(invite.url.replace('//localhost:', '//127.0.0.1:'));
  const todo = await until(async () => (await owner.call('todos.list')).find((entry) => entry.title.startsWith('Let ') && entry.title.includes('Anna Berg')), 'the owner\'s decision to-do');
  await owner.call('tasks.complete', { id: todo.id, answer: { choice: 'Allow' } });
  await phone.locator('.mobile-shell').waitFor({ timeout: 60_000 });

  // A file into her chat, through the composer.
  await phone.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await phone.locator('textarea.composer-input').waitFor({ timeout: 30_000 });
  await phone.locator('input[type=file]').first().setInputFiles({ name: 'colours.txt', mimeType: 'text/plain', buffer: Buffer.from('teal, sand, coal') });
  await phone.locator('.file-chip', { hasText: 'colours.txt' }).first().waitFor({ timeout: 30_000 });
  await phone.locator('.send-button[aria-label="Send"]').tap();
  const sent = await until(async () => (await owner.call('messages.list', { conversationId: chat.id })).find((message) => message.attachments?.length), 'her attachment on the PC');
  assert.equal(sent.authorId, anna.id);
  assert.equal(sent.attachments[0].name, 'colours.txt');
  assert.equal(sent.attachments[0].mime, 'text/plain');

  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal scroll at phone width (${overflow}px)`);
  assert.deepEqual(errors, [], 'no uncaught page errors');
});
