// Electron window check of the onboarding lifecycle (first run: tour → AI → About you) with the demo engine in an
// isolated test profile:
//   * the first-run layer goes card by card (AI → About you) and each card writes its step; "Back" goes to the card
//     before; another window moving the step on is followed;
//   * About you's Start creates nobody, completes the onboarding and opens the Manager's first chat with the app's
//     start text as the person's line, once; My day shows no setup line;
//   * Team's Add menu offers "Start setup again" (its confirm's Cancel changes nothing); the command palette's
//     "Set up team again" asks the same confirm, then resets onboarding (step 'ai', not completed) and shows the layer
//     on Home from its first card;
//   * screenshots light, dark and phone width; no horizontal scroll; no renderer errors.
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

test('first-run cards and Back; Start → the Manager\'s chat, no setup line; "Set up team again" brings the layer back', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-setup-lifecycle-'));
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
  const step = async () => (await page.locator('.first-run-step').textContent())?.trim();

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const onboarding = async () => (await rpc.call('settings.get')).onboarding;
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager' && !agent.archivedAt);
  assert.ok(manager, 'a fresh profile has the seed Manager');
  await rpc.call('settings.update', { onboarding: { step: 'ai' } }); // past the feedback tour (tour-window covers it)

  // AI card → Continue (keeps what is set) → About you.
  const ai = page.locator('.first-run-card[data-card="first-run-ai"]');
  const about = page.locator('.first-run-card[data-card="first-run-about"]');
  await ai.waitFor({ timeout: 30_000 });
  assert.equal(await step(), 'Step 1 of 2');
  await ai.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 60_000 }); // the demo model answers
  await ai.getByRole('button', { name: 'Continue' }).click();
  await about.waitFor({ timeout: 15_000 });
  assert.equal((await onboarding()).step, 'about');
  assert.equal(await step(), 'Step 2 of 2');
  await shot('lifecycle-01-about-light');

  // Back to the AI card; another window moving on is followed; Back and Continue again.
  await about.getByRole('button', { name: 'Back' }).click();
  await ai.waitFor({ timeout: 15_000 });
  assert.equal((await onboarding()).step, 'ai');
  await rpc.call('settings.update', { onboarding: { step: 'about' } }); // another window moved on: this one follows
  await about.waitFor({ timeout: 15_000 });
  await about.getByRole('button', { name: 'Back' }).click();
  await ai.waitFor({ timeout: 15_000 });
  await ai.getByRole('button', { name: 'Continue' }).click();
  await about.waitFor({ timeout: 15_000 });

  // Start: nobody is created, the Manager's first chat opens with the start text as the person's line, once.
  const before = (await rpc.call('agents.list')).length;
  await about.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/chat/'), undefined, { timeout: 20_000 });
  const chatId = await page.evaluate(() => decodeURIComponent(location.hash.slice('#/chat/'.length)));
  assert.equal((await rpc.call('agents.list')).length, before, 'nobody created');
  assert.deepEqual(await onboarding(), { completed: true, step: 'done' }, 'Start completes the onboarding');
  const human = (await rpc.call('messages.list', { conversationId: chatId, limit: 20 })).filter((message) => message.authorKind === 'human');
  assert.equal(human.length, 1, "the start text, once, as the person's line");
  assert.match(human[0].body, /^Automatic message: /);

  // Home (My day): no "is setting up your team with you" line.
  await go('#/home');
  await page.locator('.day-view').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-notice="setup"]').count(), 0, 'no setup line');
  await shot('lifecycle-02-home-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('lifecycle-03-home-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Team's Add › Start setup again asks first (Cancel keeps everything).
  await go('#/team');
  const add = page.locator('.sidebar [data-cell="add"]');
  await add.waitFor({ timeout: 15_000 });
  await add.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Start setup again' }).click();
  const ask = page.getByRole('dialog', { name: 'Start setup again?' });
  await ask.waitFor({ timeout: 5_000 });
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await ask.waitFor({ state: 'hidden', timeout: 5_000 });
  assert.deepEqual(await onboarding(), { completed: true, step: 'done' }, 'Cancel changes nothing');
  // The palette's "Set up team again" is the same confirmed flow: it brings the layer back on Home.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const palette = page.locator('.palette-input');
  await palette.waitFor({ timeout: 10_000 });
  await palette.fill('Set up team');
  await page.locator('.palette-row', { has: page.locator('.palette-label', { hasText: exactly('Set up team again') }) }).click();
  await ask.waitFor({ timeout: 5_000 });
  await ask.getByRole('button', { name: 'Start setup', exact: true }).click();
  await page.locator('.first-run-view').waitFor({ timeout: 20_000 });
  assert.match(await page.evaluate(() => location.hash), /^#\/(home)?$/, 'on Home');
  assert.equal(await step(), 'Step 1 of 2');
  assert.deepEqual(await onboarding(), { completed: false, step: 'ai' });
  await shot('lifecycle-04-again-light');

  // Phone width: the layer, no horizontal scroll.
  await size(420, 860);
  await page.waitForTimeout(800);
  await shot('lifecycle-05-phone');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at phone width (${overflow}px)`);
  await size(1280, 820);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
