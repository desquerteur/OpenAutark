// End-to-end (F-52): a person of the organisation joins in a real browser on a phone viewport
// against the headless runtime (fake engine). The owner adds Anna, puts her in a chat with an
// agent and gives her a task; her browser opens the invite link (#join=<ticket>) → it asks at once
// and the ticket leaves the address bar → the owner allows it on the decision to-do → the page
// opens the app as Anna: her For you shows her task (not the owner's), her chat list only her chat,
// and the message she sends there reaches the owner as hers.
// Uses an installed Chrome or Edge through playwright-core (never downloads one); skipped without.
// Run: npm run build && node --test test/e2e/pwa-person.test.mjs

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

test('a person joins from an invite link in a phone browser and works in her own app', {
  timeout: 180_000,
  skip: channel ? false : 'No installed Google Chrome or Microsoft Edge was found – this test uses an installed browser and never downloads one.',
}, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const owner = runtime.client;
  await owner.call('pwa.enable', { enabled: true, bind: 'localhost' });
  const agent = (await owner.call('agents.list'))[0];
  // The owner picks what she works with (a new person works with no space's agents by default).
  const anna = await owner.call('people.save', { name: 'Anna Berg', title: 'Designer', scopes: { spaces: 'all', startChats: true, assignAgents: true } });
  const chat = await owner.call('chats.create', { title: 'Launch plan', agentIds: [agent.id], people: [anna.id] });
  await owner.call('chats.create', { title: 'Owner only room', agentIds: [agent.id] });
  await owner.call('tasks.create', { conversationId: chat.id, title: 'Pick the colours', assigneeKind: 'human', assigneeId: anna.id });
  const invite = await owner.call('people.invite', { id: anna.id });

  const browser = await chromium.launch({ channel, headless: true });
  t.after(() => browser.close());
  const errors = [];
  const phone = await (await browser.newContext(PHONE)).newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(invite.url.replace('//localhost:', '//127.0.0.1:'));
  await phone.locator('.access-request', { hasText: 'Waiting to be let in' }).waitFor({ timeout: 30_000 });
  assert.ok(!(await phone.evaluate(() => location.hash)).includes('join='), 'the ticket left the address bar');
  const todo = await until(async () => (await owner.call('todos.list')).find((entry) => entry.title.startsWith('Let ') && entry.title.endsWith('join as Anna Berg · Designer?')), 'the owner\'s decision to-do');
  await owner.call('tasks.complete', { id: todo.id, answer: { choice: 'Allow' } });
  await phone.locator('.mobile-shell').waitFor({ timeout: 60_000 });
  await phone.locator('text=Pick the colours').first().waitFor({ timeout: 30_000 });
  assert.ok(!(await owner.call('todos.list')).some((entry) => entry.title === 'Pick the colours'), 'not on the owner\'s For you');

  await phone.evaluate(() => { location.hash = '#/chats'; });
  await phone.locator('text=Launch plan').first().waitFor({ timeout: 30_000 });
  assert.equal(await phone.locator('text=Owner only room').count(), 0, 'only her chats');
  await phone.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const input = phone.locator('textarea.composer-input');
  await input.waitFor({ timeout: 30_000 });
  await input.fill('Hello from Anna');
  await phone.locator('.send-button[aria-label="Send"]').tap(); // on a phone Enter is a new line
  const stored = await until(async () => (await owner.call('messages.list', { conversationId: chat.id })).find((message) => message.body === 'Hello from Anna'), 'her message on the PC');
  assert.equal(stored.authorId, anna.id);
  assert.equal(stored.authorKind, 'human');
  await phone.screenshot({ path: `${runtime.dataDir}/person-chat.png` }).catch(() => undefined);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal scroll at phone width (${overflow}px)`);
  assert.deepEqual(errors, [], 'no uncaught page errors');
});
