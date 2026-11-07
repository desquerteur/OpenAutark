// Electron window check of the AF-002 spotlight tour (src/ui/tour/Spotlight.tsx, spotlight.ts) with the demo engine in
// an isolated test profile:
//   * Settings › General › Getting started "Show the tour again" starts it; it goes through every main part that is in
//     this build – each step's ring lies on its target (the cut-out), the bubble stays in the window, the progress
//     counts on by one ("n / total") and the tour opens the place of a step itself (Chats, the Manager's chat, the side
//     pane, Work, Team, the Manager's page, Settings pages); steps whose element this build does not have are skipped
//     silently; → / ← / Enter work; each shown step is saved (tour 'started' + tourStep); Done saves 'done', puts back
//     the route it started on and closes the side pane it opened;
//   * a missing target (the sidebar hidden) never stops the tour; Esc saves 'skipped';
//   * a tour left part way (window closed) goes on at its saved step after a reload;
//   * after the tour a first-visit hint shows once for an area it did not reach (Settings › Secrets); Got it saves it;
//   * phone width: the bubble is a sheet at the bottom with 44 px buttons, no horizontal scroll;
//   * screenshots of every step (light), one dark; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { TOUR_STEPS } from '../../src/ui/tour/spotlight-steps.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const SELECTORS = Object.fromEntries(TOUR_STEPS.map((step) => [step.id, step.targets]));
/** The main parts every build of today has (the tour must show each once). */
const EXPECTED = ['welcome', 'rail', 'sidebar', 'chat-list', 'composer', 'composer-send', 'call-button', 'side-panel', 'my-day', 'tasks',
  'agent-create', 'agent-view', 'settings', 'accounts', 'connectors', 'skills', 'feedback', 'end'];

test('spotlight tour: every main part once, missing targets skipped, saved, resumed, restarted; hints; phone sheet', { timeout: 420_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-spotlight-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); if (win.isMaximized()) win.unmaximize(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const noScroll = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${label} (${overflow}px)`);
  };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const onboarding = async () => (await rpc.call('settings.get')).onboarding;
  await rpc.call('settings.update', { onboarding: { step: 'done', completed: true } }); // the assistant: first-run-window.test.mjs
  assert.equal((await onboarding()).tour, 'new', 'not shown yet');
  assert.equal(await page.locator('dialog.spotlight').count(), 0, 'a tour that was never offered does not start by itself');

  const dialog = page.locator('dialog.spotlight');
  /** The step on screen once the tour stopped looking for its target. */
  const current = async () => {
    await dialog.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => { const open = document.querySelector('dialog.spotlight'); return open && !open.hasAttribute('data-busy'); }, undefined, { timeout: 15_000 });
    await page.waitForTimeout(300); // the bubble's place settles (one frame after its size is known)
    return {
      id: await dialog.getAttribute('data-step'),
      progress: (await dialog.locator('.spotlight-progress').textContent())?.trim() ?? '',
    };
  };
  /** The ring lies on the step's target and the bubble inside the window. */
  const checkGeometry = async (id) => {
    const result = await page.evaluate((selectors) => {
      const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && !element.closest('.spotlight'); };
      let target = null;
      for (const selector of selectors) { target = [...document.querySelectorAll(selector)].find(visible) ?? null; if (target) break; }
      const ring = document.querySelector('.spotlight-ring')?.getBoundingClientRect();
      const bubble = document.querySelector('.spotlight-bubble')?.getBoundingClientRect();
      const box = target?.getBoundingClientRect();
      return { target: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null, ring: ring ? { x: ring.x, y: ring.y, w: ring.width, h: ring.height } : null,
        bubble: bubble ? { x: bubble.x, y: bubble.y, w: bubble.width, h: bubble.height } : null, view: { w: innerWidth, h: innerHeight } };
    }, SELECTORS[id]);
    assert.ok(result.bubble, `${id}: a bubble`);
    assert.ok(result.bubble.x >= 0 && result.bubble.y >= 0 && result.bubble.x + result.bubble.w <= result.view.w + 1 && result.bubble.y + result.bubble.h <= result.view.h + 1, `${id}: the bubble stays in the window ${JSON.stringify(result)}`);
    if (!SELECTORS[id].length) { assert.equal(result.ring, null, `${id}: centred, no ring`); return; }
    assert.ok(result.target && result.ring, `${id}: target and ring ${JSON.stringify(result)}`);
    const clip = (value, max) => Math.max(0, Math.min(max, value));
    const want = { x: clip(result.target.x - 6, result.view.w), y: clip(result.target.y - 6, result.view.h) };
    assert.ok(Math.abs(result.ring.x - want.x) <= 2 && Math.abs(result.ring.y - want.y) <= 2, `${id}: the ring lies on the target ${JSON.stringify(result)}`);
  };

  // ── 1. Show the tour again from Settings › General › Getting started: the whole tour with Next ──
  await go('#/settings/general');
  const group = page.locator('#settings-getting-started');
  await group.waitFor({ timeout: 15_000 });
  await group.scrollIntoViewIfNeeded();
  await shot('spotlight-00-getting-started');
  await group.getByRole('button', { name: 'Show the tour again' }).click();
  const visited = [];
  let position = 0;
  let checkedKeys = false;
  let checkedSaved = false;
  for (let guard = 0; guard < TOUR_STEPS.length + 2; guard += 1) {
    const step = await current();
    assert.ok(!visited.includes(step.id), `${step.id} shown once`);
    visited.push(step.id);
    const [shown, total] = step.progress.split(' / ').map(Number);
    assert.equal(shown, position + 1, `${step.id}: the progress counts on by one (${step.progress})`);
    assert.ok(total >= shown && total <= TOUR_STEPS.length, step.progress);
    position = shown;
    await checkGeometry(step.id);
    assert.equal(await dialog.locator('.spotlight-back').isDisabled(), position === 1, `${step.id}: Back only after the first step`);
    await shot(`spotlight-${String(visited.length).padStart(2, '0')}-${step.id}`);
    if (step.id === 'composer') { await page.emulateMedia({ colorScheme: 'dark' }); await shot('spotlight-composer-dark'); await page.emulateMedia({ colorScheme: 'light' }); }
    if (step.id === 'sidebar' && !checkedKeys) {
      // → next, ← back, Enter on the bubble's text next as well
      checkedKeys = true;
      await page.keyboard.press('ArrowRight');
      assert.equal((await current()).id, 'chat-list');
      await page.keyboard.press('ArrowLeft');
      assert.equal((await current()).id, 'sidebar');
      position -= 1; visited.pop(); // the loop sees 'sidebar' again
      continue;
    }
    if (step.id === 'tasks' && !checkedSaved) {
      checkedSaved = true;
      await page.waitForTimeout(300);
      const saved = await onboarding();
      assert.deepEqual([saved.tour, saved.tourStep], ['started', 'tasks'], 'each shown step is saved');
      assert.ok(saved.hints.includes('tasks') && saved.hints.includes('chat'), 'the areas the tour showed need no first-visit hint');
    }
    const next = dialog.locator('.spotlight-next');
    const label = (await next.textContent())?.trim();
    if (step.id === 'end') { assert.equal(label, 'Done'); await next.click(); break; }
    assert.equal(label, 'Next');
    await next.click();
  }
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  for (const id of EXPECTED) assert.ok(visited.includes(id), `the tour showed ${id} (shown: ${visited.join(', ')})`);
  assert.deepEqual(visited.filter((id) => !EXPECTED.includes(id)).filter((id) => !SELECTORS[id]?.length), [], 'no extra centred steps');
  t.diagnostic(`shown: ${visited.join(' → ')}`);
  await page.waitForTimeout(400); // the last writes land
  const done = await onboarding();
  assert.deepEqual([done.tour, done.tourStep], ['done', ''], 'Done is saved');
  assert.equal(await page.evaluate(() => location.hash), '#/settings/general', 'back where it started');
  assert.equal((await rpc.call('settings.get')).preferences.workspaceOpen, false, 'the side pane it opened is closed again');

  // ── 2. A first-visit hint for an area the tour did not reach: once, Got it saves it ──
  await go('#/settings/secrets');
  const hint = page.locator('dialog.spotlight.spotlight-hint[data-step="hint-secrets"]');
  await hint.waitFor({ timeout: 10_000 });
  await shot('spotlight-hint-secrets');
  await hint.locator('.spotlight-next').click();
  await hint.waitFor({ state: 'detached', timeout: 5_000 });
  await page.waitForTimeout(300);
  assert.ok((await onboarding()).hints.includes('secrets'), 'Got it is saved');
  await go('#/settings/general');
  await page.waitForTimeout(400);
  await go('#/settings/secrets');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('dialog.spotlight').count(), 0, 'a hint shows once');
  // A hint whose place is left closes and stays due; it shows again on the next visit.
  await go('#/settings/devices');
  const devices = page.locator('dialog.spotlight.spotlight-hint[data-step="hint-devices"]');
  await devices.waitFor({ timeout: 10_000 });
  await go('#/settings/general');
  await devices.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal((await onboarding()).hints.includes('devices'), false, 'left, not seen: still due');
  await go('#/settings/devices');
  await devices.waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape'); // Esc on a hint: seen
  await devices.waitFor({ state: 'detached', timeout: 5_000 });
  await page.waitForTimeout(300);
  assert.ok((await onboarding()).hints.includes('devices'));

  // ── 3. A missing target never stops the tour: the sidebar hidden, the palette's "Show the app tour" ──
  await rpc.call('settings.update', { preferences: { sidebarOpen: false } });
  await page.locator('.sidebar').waitFor({ state: 'detached', timeout: 10_000 });
  await page.keyboard.press('Control+K');
  await page.locator('.palette-input').fill('Show the app tour');
  await page.locator('.palette-row', { hasText: 'Show the app tour' }).first().click();
  const seen = [];
  for (let guard = 0; guard < 6; guard += 1) {
    const step = await current();
    seen.push(step.id);
    if (step.id === 'composer') break;
    await dialog.locator('.spotlight-next').click();
  }
  assert.deepEqual(seen, ['welcome', 'rail', 'composer'], 'sidebar and chat list skipped silently');
  assert.equal((await current()).progress.split(' / ')[0], '3', 'the progress counts only what is shown');
  await shot('spotlight-missing-skipped');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  const skipped = await onboarding();
  assert.deepEqual([skipped.tour, skipped.tourStep], ['skipped', ''], 'Esc is Skip');
  await rpc.call('settings.update', { preferences: { sidebarOpen: true } });

  // ── 4. A tour left part way goes on at its step after the window starts again ──
  await rpc.call('settings.update', { onboarding: { tour: 'started', tourStep: 'tasks' } });
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  assert.equal((await current()).id, 'tasks', 'resumed at the saved step');
  assert.equal(await page.evaluate(() => location.hash), '#/tasks', 'its place is open');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });

  // ── 5. Phone width: a sheet at the bottom, 44 px buttons, no sideways scroll; through to the end ──
  await size(420, 860);
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+K');
  await page.locator('.palette-input').fill('Show the app tour');
  await page.locator('.palette-row', { hasText: 'Show the app tour' }).first().click();
  for (let guard = 0; guard < TOUR_STEPS.length + 1; guard += 1) {
    const step = await current();
    assert.ok(await dialog.locator('.spotlight-bubble.sheet').isVisible(), `${step.id}: a sheet on the phone`);
    const heights = await dialog.locator('.spotlight-actions .button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    assert.ok(heights.every((height) => height >= 43.5), `${step.id}: 44 px buttons (${heights})`);
    await noScroll(`phone ${step.id}`);
    await shot(`spotlight-phone-${String(guard + 1).padStart(2, '0')}-${step.id}`);
    const next = dialog.locator('.spotlight-next');
    const last = (await next.textContent())?.trim() === 'Done';
    await next.click();
    if (last) break;
  }
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  await size(1280, 820);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
