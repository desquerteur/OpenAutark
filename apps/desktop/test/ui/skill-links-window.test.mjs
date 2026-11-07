// Electron window check of Settings › Skills › "Add from link" (AF-007, settings/skill-links.tsx): the Skills overview
// carries data-tour="skills" and the head action; the dialog's link step; the preview of a repository with two skills
// (choose them, files folded, the scripts warning, the place select) and Back. Nothing reaches the network: an init
// script answers skills.previewLink on the runtime MessagePort with a fixed preview (the reading itself is unit-tested,
// test/unit/skills/skill-link-*.test.ts); skills.linkTargets is the real runtime's. Nothing is installed.
// Screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Run: npm run build && node --test test/ui/skill-links-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const PREVIEW = {
  id: 'preview-1', expiresAt: Date.now() + 600_000, problems: [{ route: 'skills/broken', problem: 'SKILL.md has no description and no text' }],
  source: { kind: 'github', url: 'https://github.com/anthropics/skills', repo: 'anthropics/skills' },
  skills: [
    { route: 'skills/docx', name: 'docx', description: 'Create, edit and analyse Word documents.', files: [{ path: 'SKILL.md', size: 9000 }, { path: 'ooxml.md', size: 22000 }], size: 31000, scripts: [], notes: [] },
    { route: 'skills/pdf', name: 'pdf', description: 'Use this skill whenever the user wants to do anything with PDF files: read, fill forms, merge, split.', size: 68568, notes: ['1 file left out (link)'],
      files: [{ path: 'SKILL.md', size: 8000 }, { path: 'forms.md', size: 9000 }, { path: 'scripts/fill_fillable_fields.py', size: 4000, script: true }, { path: 'scripts/check_bounding_boxes.py', size: 3000, script: true }],
      scripts: ['scripts/check_bounding_boxes.py', 'scripts/fill_fillable_fields.py'] },
  ],
};

/** Page init script: skills.previewLink answers PREVIEW (the request is recorded in window.__wfLinks). */
function fakePreview(preview) {
  return `(() => {
    const asked = new Set();
    const calls = [];
    Object.defineProperty(window, '__wfLinks', { value: calls });
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (frame, ...rest) {
      if (frame && typeof frame === 'object' && frame.method === 'skills.previewLink') { asked.add(frame.id); calls.push(frame.params); }
      return post.call(this, frame, ...rest);
    };
    const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
    Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, enumerable: true, get() {
      const value = data.call(this);
      if (value && typeof value === 'object' && ('result' in value || 'error' in value) && asked.has(value.id)) { const { error, ...rest } = value; return { ...rest, result: ${JSON.stringify(preview)} }; }
      return value;
    } });
  })();`;
}

test('Settings › Skills: Add from link – link, preview with two skills, scripts warning, place', { timeout: 180_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-links-'));
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
  await page.addInitScript(fakePreview(PREVIEW));
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await page.evaluate(() => { location.hash = '#/settings/skills'; });

  const group = page.locator('[data-tour="skills"]');
  await group.waitFor({ timeout: 15_000 });
  assert.equal(await group.getAttribute('id'), 'settings-skills', 'the Skills overview carries the tour mark');
  const add = group.getByRole('button', { name: 'Add from link' });
  await add.waitFor({ timeout: 10_000 });
  await add.click();
  const dialog = page.locator('dialog.skill-link');
  await dialog.locator('#skill-link-url').waitFor({ timeout: 5_000 });
  assert.equal(await dialog.getByRole('button', { name: 'Show' }).isDisabled(), true, 'nothing to read yet');
  await dialog.locator('#skill-link-url').fill('https://github.com/anthropics/skills');
  await shot('links-01-link-light');
  await dialog.getByRole('button', { name: 'Show' }).click();

  await dialog.locator('.skill-link-skill').nth(1).waitFor({ timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => window.__wfLinks), [{ url: 'https://github.com/anthropics/skills' }]);
  assert.equal(await dialog.locator('.skill-link-source').textContent(), 'github.com/anthropics/skills');
  assert.equal(await dialog.locator('.skill-link-name').count(), 2, 'one card per skill');
  assert.equal(await dialog.locator('.skill-link-warn').count(), 1, 'only the skill with scripts warns');
  assert.match(await dialog.locator('.skill-link-warn').textContent(), /only saved – nothing runs when installing/);
  const install = dialog.getByRole('button', { name: /^Install/ });
  assert.equal(await install.isDisabled(), true, 'several skills: the person chooses');
  await dialog.getByRole('checkbox', { name: 'Install pdf' }).check();
  assert.equal(await install.isDisabled(), false);
  await dialog.getByRole('checkbox', { name: 'Install docx' }).check();
  assert.equal(await install.textContent(), 'Install 2');
  await dialog.locator('.skill-link-skill').nth(1).locator('summary').click();
  await dialog.locator('.skill-link-tag').first().waitFor({ timeout: 5_000 });
  assert.match(await dialog.locator('.set-select').first().textContent(), /Shared – every agent/, 'the shared library is the first place');
  await shot('links-02-preview-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('links-03-preview-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, name] of [[640, 480, 'links-04-preview-640x480'], [420, 860, 'links-05-preview-phone']]) {
    await size(width, height);
    await page.waitForTimeout(600);
    await shot(name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${width} px (${overflow}px)`);
  }
  await size(1280, 820);
  await dialog.getByRole('button', { name: 'Back' }).click();
  await dialog.locator('#skill-link-url').waitFor({ timeout: 5_000 });

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
