// AF-012 window check (owner 07.11.2026: "Start-Button wird zum Stop-Button") with the demo engine in an isolated profile.
// The agent's turn hangs on a native tool ([[hang:bash …]]), so it keeps working until it is stopped:
//   * while it works and the field is empty, Send's round cell holds Stop (a square, data-tour="run-stop") at exactly
//     Send's place; a draft brings Send back (the message would still reach the running agent);
//   * a click on Stop ends the run: Send is back and the run's block reads "Stopped" well within 2 s, nothing works;
//   * Esc in the empty field stops the next run, and Esc with the focus in the chat outside a field the one after;
//   * light, dark and phone width (no horizontal page scroll); no renderer errors.
// Run: npm run build && node --test test/ui/composer-stop-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

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
const WITHIN_MS = 2000;

test('AF-012: Send turns into Stop while an agent works; click and Esc stop it within 2 s and Send comes back', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-stop-'));
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
  const actions = page.locator('.composer .composer-actions');
  const field = page.locator('.composer-input');
  const send = actions.locator('.send-button[aria-label="Send"]');
  const stop = actions.locator('[data-tour="run-stop"]');
  const box = async (locator) => { const b = await locator.boundingBox(); return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };

  await send.waitFor();
  assert.equal(await stop.count(), 0, 'nothing works: Send');
  const sendBox = await box(send);

  /** Starts a turn that keeps working (a native tool that never ends by itself) and waits for Stop. */
  let n = 0;
  const startWork = async () => {
    n += 1;
    const seen = new Set();
    for (const frame of rpc.events) seen.add(frame.data);
    const working = rpc.waitFor('agent.activity', (event) => !seen.has(event) && event.active.some((run) => run.agentId === manager.id && run.conversationId === chat.id), 30_000);
    await rpc.call('messages.send', { conversationId: chat.id, body: `Ship build ${n} [[hang:bash {"command":"deploy --build ${n}"}]]` });
    const runId = (await working).active.find((run) => run.agentId === manager.id).runId;
    await stop.waitFor({ timeout: 15_000 });
    return runId;
  };
  /** Runs `act` (the Stop) and measures until Send is back and the run's block reads Stopped. */
  const stopped = async (runId, act) => {
    const ended = rpc.waitFor('message.updated', (message) => message.runId === runId && message.state === 'stopped', 15_000);
    // Measured in the page from the click or key press (Playwright's own round trips are not the app's time).
    await page.evaluate(() => {
      const w = window;
      w.__stop = { input: 0, send: 0, shown: 0 };
      const mark = () => { if (!w.__stop.input) w.__stop.input = performance.now(); };
      addEventListener('pointerdown', mark, { capture: true, once: true });
      addEventListener('keydown', mark, { capture: true, once: true });
      const shownBefore = document.querySelectorAll('.working-message.stopped').length;
      const check = () => {
        if (!w.__stop.input) return;
        if (!w.__stop.send && document.querySelector('.composer .send-button[aria-label="Send"]')) w.__stop.send = performance.now();
        if (!w.__stop.shown && document.querySelectorAll('.working-message.stopped').length > shownBefore) w.__stop.shown = performance.now();
        if (w.__stop.send && w.__stop.shown) observer.disconnect();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await act();
    await send.waitFor({ timeout: 10_000 });
    await ended;
    await page.locator('.working-message.stopped', { hasText: 'Stopped' }).last().waitFor({ timeout: 10_000 });
    const { input, send: sendAt, shown } = await page.evaluate(() => window.__stop);
    const back = Math.round(sendAt - input);
    const done = Math.round(Math.max(sendAt, shown) - input);
    t.diagnostic(`Send back after ${back} ms, run stopped and shown after ${done} ms`);
    assert.ok(back < WITHIN_MS, `Send back within ${WITHIN_MS} ms (${back} ms)`);
    assert.ok(done < WITHIN_MS, `stopped within ${WITHIN_MS} ms (${done} ms)`);
    assert.equal(await stop.count(), 0, 'Start again');
    assert.equal((await rpc.call('agents.activity')).filter((run) => run.agentId === manager.id).length, 0, 'nothing works any more');
  };

  // 1. Stop takes Send's place; a draft brings Send back; the click stops.
  const first = await startWork();
  assert.equal(await stop.getAttribute('aria-label'), 'Stop');
  assert.deepEqual(await box(stop), sendBox, 'Stop sits exactly where Send was');
  await shot('stop-01-working-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('stop-02-working-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await field.fill('Also update the changelog');
  await send.waitFor();
  assert.equal(await stop.count(), 0, 'with a draft: Send (it reaches the running agent)');
  await field.fill('');
  await stop.waitFor();
  await stopped(first, () => stop.click());
  await shot('stop-03-stopped-light');

  // 2. Esc in the empty field.
  const second = await startWork();
  await field.focus();
  await stopped(second, () => page.keyboard.press('Escape'));

  // 3. Esc with the focus in the chat, outside a field.
  const third = await startWork();
  await page.locator('.message-scroller').click({ position: { x: 20, y: 20 } });
  await stopped(third, () => page.keyboard.press('Escape'));

  // Phone width: Stop in the same cell, no horizontal scroll.
  await size(420, 860);
  await page.waitForTimeout(600);
  const fourth = await startWork();
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  await shot('stop-04-working-phone');
  await stopped(fourth, () => stop.click());
  await size(1280, 820);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
