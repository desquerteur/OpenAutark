// AF-016 window check (owner 07.11.2026: "Prompt-Warteschlange wie bei Codex") with the demo engine in an isolated profile.
// While the agent works (its turn hangs on a native tool):
//   * three prompts are lined up three ways – Ctrl+Enter (the other one than the default "Send now"), the Send caret's
//     "Add to queue", and Enter after the default was switched to "Add to queue" in the same menu; none goes out;
//   * they show as a compact list right above the composer; one is edited in place, the last is dragged to the top
//     with its grip (pointer drag), and the order is saved in the runtime;
//   * Stop ends the work and the queue stays (paused after Stop); Resume lets them go out one after another, each
//     after the agent's answer to the one before; the list is gone at the end;
//   * light, dark, phone width (no horizontal scroll); no renderer errors.
// Run: npm run build && node --test test/ui/composer-queue-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

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

test('AF-016: queue three prompts while an agent works, edit and reorder them, then they go out one after another', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-queue-'));
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
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()}${message.location()?.url ? ` (${message.location().url})` : ''}`); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Release', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, 'org'] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  const field = page.locator('.composer-input');
  const list = page.locator('.queue-list');
  const rows = list.locator('.queue-row');
  const caret = page.locator('.composer [data-tour="composer-queue"]');
  const texts = async () => (await rows.locator('.queue-text').allTextContents()).map((text) => text.trim());
  const human = async () => (await rpc.call('messages.list', { conversationId: chat.id, limit: 50 })).filter((message) => message.authorKind === 'human').map((message) => message.body);

  // The agent works.
  const working = rpc.waitFor('agent.activity', (event) => event.active.some((run) => run.agentId === manager.id && run.conversationId === chat.id), 30_000);
  await rpc.call('messages.send', { conversationId: chat.id, body: 'Ship it [[hang:bash {"command":"deploy --long"}]]' });
  await working;
  await page.locator('.composer [data-tour="run-stop"]').waitFor({ timeout: 15_000 });

  // 1. Ctrl+Enter: the other one than the default ("Send now") – into the queue.
  await field.fill('Update the changelog');
  await field.press('Control+Enter');
  await list.waitFor();
  assert.deepEqual(await texts(), ['Update the changelog']);
  // 2. The caret's "Add to queue".
  await field.fill('Tag the release');
  await caret.click();
  await page.getByRole('menu', { name: 'Send options' }).getByRole('menuitem', { name: /Add to queue/ }).click();
  await rows.nth(1).waitFor();
  // 3. Default switched to "Add to queue" in the same menu, then Enter.
  await caret.click();
  const options = page.getByRole('menu', { name: 'Send options' });
  await options.waitFor();
  await shot('queue-01-menu-light');
  await options.getByRole('menuitemcheckbox', { name: /Add to queue/ }).click();
  await page.waitForFunction(() => true);
  await field.fill('Write the announcement');
  await field.press('Enter');
  await rows.nth(2).waitFor();
  assert.deepEqual(await texts(), ['Update the changelog', 'Tag the release', 'Write the announcement']);
  assert.deepEqual(await human(), ['Ship it [[hang:bash {"command":"deploy --long"}]]'], 'nothing went out while the agent works');
  assert.equal((await rpc.call('settings.get')).preferences.whileWorking, 'queue', 'the default is saved');
  await shot('queue-02-three-light');

  // Edit the second in place.
  await rows.nth(1).locator('.queue-text').click();
  const edit = list.locator('.queue-edit');
  await edit.fill('Tag the release v1.2');
  await edit.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.queue-row .queue-text')].some((el) => el.textContent?.includes('v1.2')));

  // Drag the third to the top with its grip.
  const grip = rows.nth(2).locator('.queue-grip');
  const from = await grip.boundingBox();
  const top = await rows.nth(0).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - ((from.y - top.y + 8) * i) / 8);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.queue-row .queue-text')?.textContent?.includes('announcement'));
  const order = ['Write the announcement', 'Update the changelog', 'Tag the release v1.2'];
  assert.deepEqual(await texts(), order);
  assert.deepEqual((await rpc.call('queue.get', { conversationId: chat.id })).items.map((item) => item.body), order, 'the order is saved in the runtime');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('queue-03-reordered-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(420, 860);
  await page.waitForTimeout(600);
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  await shot('queue-04-phone');
  await size(1280, 820);
  await page.waitForTimeout(400);

  // Stop: the work ends, the queue stays.
  await page.locator('.composer [data-tour="run-stop"]').click();
  await list.locator('.queue-paused', { hasText: 'Paused after Stop' }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  assert.equal((await human()).length, 1, 'Stop holds the queue');
  await shot('queue-05-paused-light');

  // Resume: one after another, each after the agent's answer.
  await list.getByRole('button', { name: 'Resume' }).click();
  await list.waitFor({ state: 'detached', timeout: 60_000 });
  const done = rpc.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.state === 'final' && /announcement|changelog|v1\.2/.test(message.body) && /v1\.2/.test(message.body), 60_000);
  await done;
  const messages = (await rpc.call('messages.list', { conversationId: chat.id, limit: 50 })).filter((message) => message.state === 'final' || message.authorKind === 'human');
  assert.deepEqual(messages.filter((message) => message.authorKind === 'human').map((message) => message.body).slice(1), order, 'sent in the queue\'s order');
  const sequence = messages.map((message) => (message.authorKind === 'human' ? `you:${message.body}` : 'agent')).slice(1);
  for (let i = 0; i < order.length; i++) {
    const at = sequence.indexOf(`you:${order[i]}`);
    assert.ok(at >= 0 && sequence[at + 1] === 'agent', `the agent answered "${order[i]}" before the next went out (${sequence.join(' | ')})`);
  }
  await shot('queue-06-done-light');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
