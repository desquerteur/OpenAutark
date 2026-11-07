// AF-015 window check – a call looks like a call – in an isolated test profile with the demo engine and the mock voice
// engine (localStorage 'wf.callEngine' = 'mock': no microphone, no speaker, no speech key; ui/chat/call/call-mock.ts):
//   * the call cell (data-tour="call-button") opens the call view over the whole window: the agent's avatar and name,
//     "Connecting…", then the phases of a call ("Listening", "Working…", "Speaking") with its clock, the wave, captions
//     and the four controls; Mute shows "Microphone off" and is pressed, Unmute takes it back;
//   * Minimize turns it into the small floating window (avatar, name, status, Mute, Hang up), which opens full again;
//   * Hang up closes it, the header cell is "Talk" again and the chat keeps the call card with its length and the
//     transcript behind the disclosure (the person's scripted line and the agent's answer);
//   * at phone width (375 px) the same view fits the narrow window (no horizontal scroll, the controls on screen, the
//     mini window a bar under the header row); with prefers-reduced-motion the ring keeps its size; dark theme; no
//     renderer errors.
// Run: npm run test:ui (needs a fresh build). SCREENSHOTS=<dir> keeps the shots.

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

test('call view: full and mini, phases, mute, hang up, the call card – desktop and phone width', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-callview-'));
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
  page.on('console', (message) => { if (message.type() === 'error' && !/Autofill|DevTools|Electron Security Warning/i.test(message.text())) errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id] });
  await page.evaluate(() => localStorage.setItem('wf.callEngine', 'mock')); // the mock voice engine: no real audio, no key
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.composer').waitFor({ timeout: 15_000 });

  const cell = page.locator('.chat-header [data-tour="call-button"]');
  const full = page.locator('.call-view.full');
  const mini = page.locator('.call-view.mini');
  const status = full.locator('.call-status');
  const phase = async (view, wanted, what) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await page.waitForTimeout(100)) {
      if ((await view.getAttribute('data-phase').catch(() => null)) === wanted) return;
    }
    assert.fail(`timed out: ${what} (${await view.getAttribute('data-phase').catch(() => 'gone')})`);
  };

  // Start: the call view lies over the whole window and connects.
  await cell.locator('button[aria-label="Talk"]').click();
  await full.waitFor({ timeout: 5_000 });
  assert.match(await full.getAttribute('aria-label'), /^Call with /);
  assert.match(await status.textContent(), /Connecting…/);
  const cover = await page.evaluate(() => { const view = document.querySelector('.call-view.full'); return { w: view.offsetWidth, h: view.offsetHeight, iw: innerWidth, ih: innerHeight }; }); // layout size: the 0.2 s fade-in scales it a little
  assert.ok(cover.w >= cover.iw - 1 && cover.h >= cover.ih - 1, 'the call view covers the window');
  await shot('call-view-01-connecting');
  await phase(full, 'listening', 'connected, listening');
  for (const label of ['Mute', 'Audio output', 'Live captions', 'Hang up']) assert.equal(await full.getByRole('button', { name: label, exact: true }).count(), 1, `control ${label}`);
  await phase(full, 'working', 'the person spoke, the agent works');
  await phase(full, 'speaking', 'the agent speaks');
  await page.waitForTimeout(500);
  assert.match(await status.textContent(), /Speaking · \d+:\d{2}/, 'status with the clock');
  assert.equal(await full.getAttribute('data-speaker'), 'agent', 'the ring says the agent speaks');
  assert.match(await full.locator('.call-captions').textContent(), /\S/, 'captions show the line');
  await shot('call-view-02-desktop-speaking');

  // Mute: pressed, "Microphone off"; Unmute takes it back.
  await full.getByRole('button', { name: 'Mute', exact: true }).click();
  assert.equal(await full.getByRole('button', { name: 'Unmute', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.match(await status.textContent(), /Microphone off/);
  await shot('call-view-03-muted');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('call-view-04-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await full.getByRole('button', { name: 'Unmute', exact: true }).click();
  assert.doesNotMatch(await status.textContent(), /Microphone off/);

  // Minimize: the small floating window; a click opens it full again.
  await full.getByRole('button', { name: 'Minimize call' }).click();
  await mini.waitFor({ timeout: 5_000 });
  assert.equal(await full.count(), 0);
  const box = await mini.boundingBox();
  assert.ok(box.width <= 320 && box.height <= 90, `small (${box.width}×${box.height})`);
  await page.waitForTimeout(2500);
  await shot('call-view-05-mini');
  await mini.getByRole('button', { name: 'Open call' }).click();
  await full.waitFor({ timeout: 5_000 });

  // Hang up: the view closes, the cell says Talk again, the chat keeps the card with the transcript.
  await page.waitForTimeout(1500);
  await full.getByRole('button', { name: 'Hang up', exact: true }).click();
  await full.waitFor({ state: 'detached', timeout: 5_000 });
  await cell.locator('button[aria-label="Talk"]').waitFor({ timeout: 10_000 });
  const card = page.locator('.message-scroller .call-card').last();
  await card.waitFor({ timeout: 10_000 });
  for (const end = Date.now() + 10_000; Date.now() < end && !/^\d+:\d{2}$/.test((await card.locator('.call-card-length').textContent()).trim()); await page.waitForTimeout(150));
  assert.match((await card.locator('.call-card-length').textContent()).trim(), /^\d+:\d{2}$/, 'the ended call shows how long it ran');
  assert.match(await card.locator('.call-card-title').textContent(), /^Call with /);
  const toggle = card.locator('.call-transcript-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'the transcript waits behind its disclosure');
  await toggle.click();
  const transcript = await card.locator('.call-transcript-body').textContent();
  assert.match(transcript, /Hi, can you hear me\?/, 'the person\'s line');
  const rows = (await rpc.call('messages.list', { conversationId: chat.id })).filter((message) => Array.isArray(message.meta?.call?.lines));
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0].meta.call.endedAt, 'number', 'the call row ended');
  assert.ok(rows[0].meta.call.lines.some((line) => line.from.startsWith('agent:')), 'with the agent\'s answer');
  await card.scrollIntoViewIfNeeded();
  await shot('call-view-06-card');

  // Phone width: the same view for the narrow screen – here with prefers-reduced-motion (the ring keeps its size).
  await size(375, 812);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(800);
  await cell.locator('button[aria-label="Talk"]').click();
  await full.waitFor({ timeout: 5_000 });
  await phase(full, 'speaking', 'the agent speaks at phone width');
  await page.waitForTimeout(400);
  const fits = await page.evaluate(() => {
    const view = document.querySelector('.call-view.full').getBoundingClientRect();
    const controls = [...document.querySelectorAll('.call-view.full .call-control-button')].map((el) => el.getBoundingClientRect());
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, width: view.width, inside: controls.every((rect) => rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight), count: controls.length };
  });
  assert.ok(fits.overflow <= 1, `no horizontal scroll (${fits.overflow}px)`);
  assert.equal(fits.count, 4);
  assert.ok(fits.inside, 'every control on screen');
  const ring = await full.evaluate((view) => ({ scale: view.style.getPropertyValue('--call-ring'), speaker: view.dataset.speaker, animation: getComputedStyle(view.querySelector('.call-ring')).animationName }));
  assert.equal(ring.scale, '1', 'reduced motion: the ring does not grow');
  assert.equal(ring.speaker, 'agent', 'its colour still says who speaks');
  await shot('call-view-07-phone-speaking');
  await full.getByRole('button', { name: 'Minimize call' }).click();
  await mini.waitFor({ timeout: 5_000 });
  const bar = await mini.boundingBox();
  const header = await page.locator('.chat-header').boundingBox();
  assert.ok(bar.y >= header.y + header.height - 1, 'the bar lies under the header row');
  await shot('call-view-08-phone-mini');
  await mini.getByRole('button', { name: 'Hang up', exact: true }).click();
  await mini.waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator('.message-scroller .call-card').nth(1).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.locator('.message-scroller .call-card').last().scrollIntoViewIfNeeded();
  await shot('call-view-09-phone-card');

  assert.deepEqual(errors, [], 'no renderer errors');
});
