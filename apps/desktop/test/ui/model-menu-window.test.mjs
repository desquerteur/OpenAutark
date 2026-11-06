// Electron window check of the composer's model chip (Umbau Einfachheit: one searchable list, effort; B-072: no "Auto"
// word – the model that answers now) with the demo engine in an isolated test profile:
//   * before the agent's first turn the chip names the model routing.preview routes it to (ignorePin), never "Auto";
//     its menu has the search field, that model first (checked, "Chosen per task"), the chat models and the effort row
//     (Low · Medium · High · Max) – no routing captions, guide labels or "Always use" pins any more;
//   * picking the demo model stores it as the agent's model in this chat (chats.get settings.models), the chip shows
//     its short name in the same box (nothing beside it moves); an effort is stored and named on the chip; the first
//     item clears both and the chip names the routed model again; a search that matches nothing says "No models";
//   * at 375 px (phone layout) the menu stays on screen and the page has no horizontal scroll;
//   * screenshots light, dark and 375 px; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('model chip: the routed model, a chosen model and effort per chat, search, phone width', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-model-menu-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Video plan', agentIds: [manager.id] });
  const models = (await rpc.call('models.list')).filter((model) => model.available);
  assert.ok(models.length > 0, 'the demo model is there');
  const settingsOf = async () => (await rpc.call('chats.get', { id: chat.id })).settings;
  const until = async (check, what) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await page.waitForTimeout(150)) if (await check()) return;
    assert.fail(`timed out: ${what}`);
  };

  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const chip = page.locator('.composer-actions .model-chip');
  await chip.waitFor({ timeout: 20_000 });
  // Before the first turn: the model the app routes the agent to now, by name (no "Auto").
  const routed = await rpc.call('routing.preview', { agentId: manager.id, conversationId: chat.id, ignorePin: true });
  const routedNames = [routed.modelId, models.find((model) => model.id === routed.modelId)?.name ?? ''];
  await page.waitForFunction(() => document.querySelector('.composer-actions .model-chip .chip-label')?.textContent?.trim(), undefined, { timeout: 10_000 });
  const routedLabel = (await chip.locator('.chip-label').textContent()).trim();
  assert.doesNotMatch(routedLabel, /^Auto/);
  assert.ok(routedNames.some((name) => name.endsWith(routedLabel)), `the chip names the routed model: "${routedLabel}" for ${routedNames.join(' / ')}`);
  const row = ['.composer', '.composer-actions', '.composer .composer-plus', '.composer .ultra-switch', '.composer .model-chip', '.composer .send-button'];

  // The menu: search, the routed model (checked), the chat models, the effort row.
  await chip.click();
  const menu = page.getByRole('menu', { name: 'Model' });
  await menu.waitFor({ timeout: 5_000 });
  assert.equal(await menu.getByRole('textbox', { name: 'Search models' }).count(), 1);
  const auto = menu.locator('[role="menuitemradio"]').first();
  assert.equal(await auto.getAttribute('aria-checked'), 'true');
  assert.equal((await auto.locator('.menu-label > span').textContent()).trim(), routedLabel, 'the first item names the same model');
  assert.equal((await auto.locator('.menu-hint').textContent()).trim(), 'Chosen per task');
  assert.equal(await menu.getByText(/^Auto$/).count(), 0, 'no "Auto" item');
  const choices = (await menu.locator('[role="menuitemradio"] .menu-label > span').allTextContents()).map((text) => text.trim());
  assert.ok(choices.length >= 2, `the routed model and at least one model: ${choices.join(', ')}`);
  assert.ok(await menu.getByRole('group', { name: 'Effort' }).locator('button').count() > 0, 'the effort row');
  assert.equal(await menu.getByText(/Always use|Below quality floor|Above cost guide|Recommended/).count(), 0, 'no routing captions or pins');
  await shot('model-menu-01-open-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('model-menu-02-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // A search that matches nothing.
  await menu.getByRole('textbox', { name: 'Search models' }).fill('zzz-no-such-model');
  await menu.getByText('No models').waitFor({ timeout: 5_000 });
  await menu.getByRole('textbox', { name: 'Search models' }).fill('');

  // Pick the first model: stored for the agent in this chat; the chip keeps its box.
  const first = menu.locator('[role="menuitemradio"]').nth(1);
  const firstName = (await first.locator('.menu-label > span').textContent()).trim();
  await expectStable(page, row, async () => {
    await first.click();
    await until(async () => Boolean((await settingsOf()).models?.[manager.id]), 'the model is stored');
    await page.waitForFunction((name) => document.querySelector('.composer-actions .model-chip .chip-label')?.textContent?.startsWith(name), firstName, { timeout: 5_000 });
  });
  const stored = (await settingsOf()).models[manager.id];
  assert.ok(models.some((model) => model.id === stored), `a listed model: ${stored}`);

  // An effort for it: stored and named on the chip.
  await chip.click();
  await menu.waitFor({ timeout: 5_000 });
  const effortButtons = menu.getByRole('group', { name: 'Effort' }).locator('button');
  const effortLabel = (await effortButtons.first().textContent()).trim();
  await effortButtons.first().click();
  await until(async () => Boolean((await settingsOf()).efforts?.[manager.id]), 'the effort is stored');
  await page.waitForFunction((label) => document.querySelector('.composer-actions .model-chip .chip-label')?.textContent?.includes(label), effortLabel, { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await shot('model-menu-03-chosen-light');

  // The first item (nothing chosen) clears both; the chip names the routed model again.
  await chip.click();
  await menu.waitFor({ timeout: 5_000 });
  await expectStable(page, row, async () => {
    await menu.locator('[role="menuitemradio"]').first().click();
    await until(async () => { const s = await settingsOf(); return !s.models?.[manager.id] && !s.efforts?.[manager.id]; }, 'nothing chosen clears the model and the effort');
    await page.waitForFunction((name) => document.querySelector('.composer-actions .model-chip .chip-label')?.textContent?.trim() === name, routedLabel, { timeout: 5_000 });
  });

  // 375 px: the menu stays on screen, no horizontal page scroll.
  await size(375, 812);
  await page.waitForTimeout(800);
  await page.locator('.composer-actions .model-chip').click();
  await page.getByRole('menu', { name: 'Model' }).waitFor({ timeout: 5_000 });
  const box = await page.getByRole('menu', { name: 'Model' }).boundingBox();
  const width = await page.evaluate(() => innerWidth);
  assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `the menu stays on screen: ${JSON.stringify(box)} in ${width}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 375 px (${overflow}px)`);
  await shot('model-menu-04-375');
  await page.keyboard.press('Escape');
  await size(1280, 820);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
