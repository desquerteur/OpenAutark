// Electron window check of Settings › Models (the model setup – settings/ModelSetup.tsx) for an installed Codex CLI
// whose sign-in the scan could not tell (runtime accounts/detect.ts loginUnknown: its status command did not answer in
// time) – "Installed · sign-in unknown" with "Check again", which scans again (force) and then shows what the status
// command said ("Not signed in" – the fixed "Codex plan" button signs in, the row offers no second button). The plans
// Claude Code and Codex always keep their rows (others only when found), and "Check again" moves no neighbour
// (expectStable, test/ui/lib/stable.mjs).
// The demo engine never scans this PC (accounts/adoption.ts demo: an empty report), so the window
// cannot reach that state honestly: the scan's answer is replaced in the page – an init script
// rewrites the accounts.detect responses on the runtime MessagePort (before the app captures the
// built-ins, lib/runtime-port.ts) – until "Check again" asks with force, then a report with the
// sign-in answered. Nothing else is changed; the runtime rule itself is unit-tested
// (test/unit/accounts/detect-timeout.test.ts). Nothing is installed or signed in.
// Screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Run: npm run build && node --test test/ui/accounts-detect-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/** Page init script: accounts.detect answers `unknown` until a call with force, then `answered`; calls are counted in window.__wfDetect. */
function fakeDetect(unknown, answered) {
  return `(() => {
    const reports = { unknown: ${JSON.stringify(unknown)}, answered: ${JSON.stringify(answered)} };
    const asked = new Map();
    const calls = [];
    let forced = false;
    Object.defineProperty(window, '__wfDetect', { value: calls });
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (frame, ...rest) {
      if (frame && typeof frame === 'object' && frame.method === 'accounts.detect') {
        if (frame.params && frame.params.force === true) forced = true;
        asked.set(frame.id, forced ? 'answered' : 'unknown');
        calls.push(frame.params ?? null);
      }
      return post.call(this, frame, ...rest);
    };
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, enumerable: true, get() {
      const value = data.call(this);
      if (value && typeof value === 'object' && 'result' in value && asked.has(value.id)) return { ...value, result: { ...reports[asked.get(value.id)], checkedAt: Date.now() } };
      return value;
    } });
  })();`;
}

test('Settings › Models: "Installed · sign-in unknown" with "Check again"', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-detect-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  t.after(async () => {
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  await size(1280, 820);

  const cli = { provider: 'codex', path: 'codex.cmd' };
  await page.addInitScript(fakeDetect(
    { clis: [cli], localServers: [], envKeys: [] },
    { clis: [{ ...cli, loggedIn: false }], localServers: [], envKeys: [] },
  ));
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.evaluate(() => { location.hash = '#/settings/models'; });

  const group = page.locator('#settings-models');
  await group.waitFor({ timeout: 15_000 });
  const codex = group.locator('.cli-row', { has: page.locator('.set-row-label', { hasText: /^Codex$/ }) });
  await codex.locator('.set-row-hint', { hasText: /^Installed · sign-in unknown$/ }).waitFor({ timeout: 15_000 });
  const again = codex.getByRole('button', { name: 'Check again' });
  await again.waitFor({ timeout: 5_000 });
  assert.deepEqual(await group.locator('.cli-row .set-row-label').allTextContents(), ['Claude Code', 'Codex'], 'the two plans always keep their rows; CLIs not found have none');
  await group.locator('.cli-row', { hasText: 'Claude Code' }).locator('.set-row-hint', { hasText: /^Not installed$/ }).waitFor({ timeout: 5_000 });
  assert.equal(await codex.getByRole('button', { name: 'Sign in' }).count(), 0, 'no sign-in offered while it is unknown');
  for (const label of ['Claude plan', 'Codex plan', 'API key', 'Local server']) assert.equal(await group.locator('.model-setup-buttons').getByRole('button', { name: label, exact: true }).count(), 1, label);
  assert.ok((await page.evaluate(() => window.__wfDetect.length)) >= 1, 'the window asked the runtime');
  await codex.scrollIntoViewIfNeeded();
  await shot('detect-01-unknown-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('detect-02-unknown-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, name] of [[640, 480, 'detect-03-unknown-640x480'], [420, 860, 'detect-04-unknown-phone']]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await codex.scrollIntoViewIfNeeded();
    await shot(name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${width} px (${overflow}px)`);
  }
  await size(1280, 820);
  await page.waitForTimeout(400);

  // "Check again": a forced scan; the status command answered this time – and no row moves.
  await expectStable(page, ['#settings-models .cli-row:nth-of-type(1)', '#settings-models .cli-row:nth-of-type(2)', '#settings-models .model-setup-buttons'], async () => {
    await codex.getByRole('button', { name: 'Check again' }).click();
    await codex.locator('.set-row-hint', { hasText: /^Not signed in$/ }).waitFor({ timeout: 15_000 });
  });
  assert.deepEqual(await page.evaluate(() => window.__wfDetect.at(-1)), { force: true }, '"Check again" scans again');
  assert.equal(await codex.getByRole('button', { name: 'Check again' }).count(), 0);
  assert.equal(await codex.getByRole('button', { name: 'Sign in' }).count(), 0, 'the fixed Codex plan button signs in – no second button in the row');
  await shot('detect-05-answered-light');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
