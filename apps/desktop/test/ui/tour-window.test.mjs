// Electron window check of the feedback tour (B-055 Q5) with the demo engine in an isolated test profile:
//   * a fresh profile shows the first-run layer at its tour step: the poster (the filled example scene with a
//     big Play button), the title row with "Connect to my other device" and Skip (both on screen down to phone width),
//     the caption line and the control bar – no "Step n of 3"; the replay dialog has × and no Connect;
//   * Play runs it (the time grows); nothing in the player moves while it plays (expectStable); Space pauses
//     (the time stands still – nothing runs), → steps 5 s, Home goes back to the start;
//   * seeking on the scrubber shows each part at once: the menu under the feedback cell with the cursor's tip on
//     the cell, the slim waveform with the menu shut, the transcript in the field, the Screenshot tooltip, the
//     "Paint over" editor whose black stroke covers the e-mail and the phone number, "Sent – thank you.";
//   * End shows the end card; Continue writes step 'ai' and shows the AI card ("Step 1 of 2");
//   * the command palette's "Watch how it works" (openTour) replays the same player in a dialog; Esc closes it;
//   * screenshots light, dark, 640×480 and phone width; no horizontal page scroll; no renderer errors.
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
import { DURATION, PAINT_SPAN, SCREENSHOT_TIP, firstOn } from '../../src/ui/tour/timeline.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

test('feedback tour: poster → play → seek through every part → Continue → AI card; replay in a dialog', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-tour-'));
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
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const noScroll = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${label} (${overflow}px)`);
  };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  assert.deepEqual((await rpc.call('settings.get')).onboarding, { completed: false, step: 'tour' }, 'a new install starts with the tour');

  // The poster: the layer in Home's place, the filled scene, the big Play – no card, no step line.
  const player = page.locator('.first-run-view .tour-player');
  await player.waitFor({ timeout: 20_000 });
  assert.equal(await player.getAttribute('data-phase'), 'poster');
  assert.ok(await page.locator('.first-run-view > .frame-header').isVisible(), 'the frame keeps its header row');
  assert.equal(await page.locator('.first-run-step').count(), 0, 'no "Step n of 3" for the tour');
  assert.equal(await page.locator('.first-run-card').count(), 0);
  assert.ok(await player.getByRole('button', { name: 'Play' }).first().isVisible());
  assert.ok(await player.getByRole('button', { name: 'Skip' }).isVisible());
  const connectButton = player.locator('.tour-top').getByRole('button', { name: 'Connect to my other device' });
  assert.ok(await connectButton.isVisible(), 'the text button beside Skip');
  const [connectBox, skipBox] = [await connectButton.boundingBox(), await player.getByRole('button', { name: 'Skip' }).boundingBox()];
  assert.ok(connectBox.x + connectBox.width <= skipBox.x + 1 && Math.abs((connectBox.y + connectBox.height / 2) - (skipBox.y + skipBox.height / 2)) < 2, 'left of Skip, on its line');
  assert.ok(await player.locator('.tour-scene > .tour-app .tour-feedback-cell').isVisible(), 'the scene shows the feedback cell');
  assert.match(await player.locator('.tour-scene').textContent(), /anna\.meyer@example\.com/, 'example private details in the scene');
  await shot('tour-01-poster-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-02-poster-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Play: the time runs; nothing in the player moves.
  const time = async () => Number(await player.getAttribute('data-time'));
  const frame = ['.tour-top', '.tour-connect', '.tour-skip', '.tour-stage-box', '.tour-caption', '.tour-controls', '.tour-time', '.tour-scrubber', '.tour-control'];
  await expectStable(page, frame, async () => {
    await player.locator('.tour-play').click();
    await page.waitForTimeout(1500);
  });
  assert.equal(await player.getAttribute('data-phase'), 'playing');
  const running = await time();
  assert.ok(running > 800, `the tour runs (${running} ms)`);
  // Space pauses: nothing runs any more; → steps 5 s; Home goes back.
  await page.keyboard.press('Space');
  const paused = await time();
  await page.waitForTimeout(600);
  assert.equal(await time(), paused, 'paused: the time stands still');
  assert.equal(await player.getAttribute('data-phase'), 'paused');
  await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs((await time()) - Math.min(DURATION, paused + 5000)) <= 1, '→ steps 5 s');
  await page.keyboard.press('Home');
  assert.equal(await time(), 0);

  // Seeking on the scrubber: each part shows at once, the scene follows.
  const scrubber = player.locator('.tour-scrubber');
  const seek = async (ms) => {
    const box = await scrubber.boundingBox();
    await page.mouse.click(box.x + (box.width * ms) / DURATION, box.y + box.height / 2);
    await page.waitForTimeout(120);
  };
  const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const scale = async () => (await player.locator('.tour-stage-box').boundingBox()).width / 960;
  // the cursor's tip is the arrow's top-left corner (its svg)
  const tip = async () => { const box = await player.locator('.tour-cursor svg').boundingBox(); return { x: box.x, y: box.y }; };

  await expectStable(page, frame, () => seek(firstOn('menu') + 700));
  const menu = player.locator('.tour-scene .tour-menu');
  await menu.waitFor({ timeout: 2_000 });
  const cell = await player.locator('.tour-scene > .tour-app .tour-feedback-cell').boundingBox();
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox.y >= cell.y + cell.height - 1, 'the menu opens under the cell');
  assert.ok(Math.abs(menuBox.x + menuBox.width - (cell.x + cell.width)) < 3, 'right-aligned with the cell');
  const k = await scale();
  const cellCenter = center(cell), at = await tip();
  assert.ok(Math.hypot(at.x - cellCenter.x, at.y - cellCenter.y) < 8 * k + 3, `the cursor's tip is on the cell (${JSON.stringify(at)} vs ${JSON.stringify(cellCenter)})`);
  const cursorBox = await player.locator('.tour-cursor svg').boundingBox();
  assert.ok(cursorBox.height / k > 45 && cursorBox.height / k < 60, 'a big cursor (≈ 52 scene units)');
  await shot('tour-03-menu-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-04-menu-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await seek(firstOn('wave') + 900);
  assert.ok(await player.locator('.tour-wave').isVisible(), 'the slim waveform under the held cell');
  assert.equal(await player.locator('.tour-scene .tour-menu').count(), 0, 'the menu is shut while held');
  assert.match(await player.locator('.tour-caption').textContent(), /hold to talk|Listening/);
  await shot('tour-05-hold-light');

  await seek(firstOn('tooltip') - 1500);
  assert.match(await player.locator('.tour-textarea').textContent(), /^The calendar stays empty after I connect Google\. And it would be great to drag tasks into tomorrow\.$/);
  await shot('tour-06-transcript-light');

  await seek(firstOn('tooltip') + 1200);
  assert.equal((await player.locator('.tour-tooltip').textContent()).trim(), SCREENSHOT_TIP);
  assert.ok(await player.locator('.tour-checkbox').isVisible(), 'the Screenshot box is checked');
  await shot('tour-07-tooltip-light');

  await seek((PAINT_SPAN.start + PAINT_SPAN.end) / 2);
  const editor = player.locator('.tour-editor');
  await editor.waitFor({ timeout: 2_000 });
  await shot('tour-08-painting-light');
  await seek(PAINT_SPAN.end + 300);
  const covered = await page.evaluate(() => {
    const ink = document.querySelector('.tour-editor .tour-ink polyline');
    const stroke = Number(ink?.getAttribute('stroke-width') ?? 0);
    const rects = ['email', 'phone'].map((key) => document.querySelector(`.tour-editor [data-private="${key}"]`)?.getBoundingClientRect());
    const svg = ink?.ownerSVGElement;
    const k = svg ? svg.getBoundingClientRect().width / 960 : 0;
    const points = (ink?.getAttribute('points') ?? '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
    const origin = svg?.getBoundingClientRect();
    const near = (x, y) => points.some(([px, py], i) => {
      if (i === 0) return false;
      const [ax, ay] = points[i - 1];
      const dx = px - ax, dy = py - ay, len = dx * dx + dy * dy;
      const lx = (x - origin.x) / k, ly = (y - origin.y) / k;
      const u = len ? Math.min(1, Math.max(0, ((lx - ax) * dx + (ly - ay) * dy) / len)) : 0;
      return Math.hypot(lx - ax - u * dx, ly - ay - u * dy) <= stroke / 2;
    });
    const misses = [];
    for (const rect of rects) {
      if (!rect) { misses.push('missing text'); continue; }
      for (let x = rect.left + 1; x < rect.right - 1; x += 1.5) for (let y = rect.top + rect.height * 0.2; y < rect.bottom - rect.height * 0.2; y += 1) if (!near(x, y)) misses.push([x, y]);
    }
    return { points: points.length, misses: misses.length, first: misses[0] ?? null, widths: rects.map((rect) => rect?.width) };
  });
  t.diagnostic(`paint check: ${JSON.stringify(covered)}`);
  assert.ok(covered.points > 50, 'a stroke was painted');
  assert.equal(covered.misses, 0, `the black stroke covers the e-mail and the phone number (${JSON.stringify(covered.first)})`);
  await shot('tour-09-painted-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-10-painted-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await seek(firstOn('sent') + 600);
  assert.equal((await player.locator('.tour-status').textContent()).trim(), 'Sent – thank you.');
  assert.equal(await player.locator('.tour-editor').count(), 0, 'Done closed the editor');
  await shot('tour-11-sent-light');

  // 640×480 and phone width: the scene scales into its box, the controls stay on screen, nothing scrolls sideways;
  // crossing into the phone layout mounts the layer again – the player keeps its place.
  const before = await time();
  for (const [width, height, label] of [[640, 480, '640x480'], [420, 860, 'phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    if (label === '640x480') {
      assert.notEqual(await player.getAttribute('data-phase'), 'poster', 'the remounted player is not back at its poster');
      assert.equal(await time(), before, 'and keeps its place');
    }
    const reachable = await page.evaluate(() => [...document.querySelectorAll('.tour-controls > *')].every((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    }));
    assert.ok(reachable, `every control is on screen and uncovered at ${label}`);
    const top = await page.evaluate(() => {
      const bar = document.querySelector('.first-run-view .tour-top')?.getBoundingClientRect();
      return ['.tour-connect', '.tour-skip'].every((selector) => {
        const box = document.querySelector(`.first-run-view ${selector}`)?.getBoundingClientRect();
        return Boolean(bar && box && box.left >= bar.left - 1 && box.right <= bar.right + 1 && box.top >= bar.top - 1 && box.bottom <= bar.bottom + 1);
      });
    });
    assert.ok(top, `Connect and Skip stay inside the title row at ${label}`);
    await seek((PAINT_SPAN.start + PAINT_SPAN.end) / 2);
    assert.ok(await player.locator('.tour-editor').isVisible(), `the scrubber seeks at ${label}`);
    const stage = await player.locator('.tour-stage-box').boundingBox();
    const scene = await player.locator('.tour-scene').boundingBox();
    assert.ok(scene.width <= stage.width + 1 && scene.height <= stage.height + 1, `the scene fits its box at ${label}`);
    assert.ok(Math.abs(scene.width / scene.height - 1.6) < 0.01, `aspect kept at ${label}`);
    await shot(`tour-12-editor-${label}`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(`tour-12-editor-${label}-dark`);
    await page.emulateMedia({ colorScheme: 'light' });
    await noScroll(label);
  }
  await size(1280, 820);
  await page.waitForTimeout(400);

  // End: the end card with Continue; Continue → the AI card.
  await player.locator('.tour-scrubber').focus();
  await page.keyboard.press('End');
  await player.locator('.tour-end').waitFor({ timeout: 2_000 });
  assert.equal(await player.getAttribute('data-phase'), 'ended');
  assert.match(await player.locator('.tour-end').textContent(), /Only the Teydra team can read your feedback – it is encrypted on your PC\./);
  await shot('tour-13-end-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-14-end-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await player.getByRole('button', { name: 'Continue' }).click();
  await page.locator('.first-run-card[data-card="first-run-ai"]').waitFor({ timeout: 15_000 });
  assert.equal((await page.locator('.first-run-step').textContent())?.trim(), 'Step 1 of 2');
  assert.equal((await rpc.call('settings.get')).onboarding.step, 'ai');
  await shot('tour-15-ai-card-light');

  // Replay from the command palette ("Watch how it works" – Settings › Feedback went): the same player in a dialog;
  // Esc closes it.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.locator('.palette-input').fill('Watch how');
  await page.locator('.palette-row', { hasText: 'Watch how it works' }).first().click();
  const dialog = page.locator('dialog.tour-dialog[open]');
  await dialog.waitFor({ timeout: 5_000 });
  assert.equal(await dialog.locator('.tour-player').getAttribute('data-phase'), 'poster', 'each opening starts at the poster');
  assert.equal(await dialog.getByRole('button', { name: 'Connect to my other device' }).count(), 0, 'the replay only plays');
  await shot('tour-16-dialog-light');
  await dialog.locator('.tour-play').click();
  await page.waitForTimeout(1200);
  assert.ok(Number(await dialog.locator('.tour-player').getAttribute('data-time')) > 500, 'it plays in the dialog');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('tour-17-dialog-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(420, 860);
  await page.waitForTimeout(500);
  await shot('tour-18-dialog-phone');
  await noScroll('dialog phone');
  await size(1280, 820);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal((await rpc.call('settings.get')).onboarding.step, 'ai', 'the replay changes no setting');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
