// Real Electron check of the file tab: the "+" page's Files starts at the data folder, a click opens a file in a tab of its
// own, Up goes up; a typed text gets the dot, Ctrl+S writes it; a change on disk is followed while nothing waits and is a
// notice with Reload under typed text; a 1 MB file stays usable; a binary and a very large file say so; the path slot takes a
// typed path; a draft survives leaving the tab; Settings' file cell opens the tab (a right click keeps Open with system); Skills &
// memory opens a skill and a memory; an agent's SYSTEM.md opens; light and dark, 640×480. A temp profile, the demo engine.
// Owns: these user paths. Never: touches the person's profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the file tab: folder list, editor, changes on disk, settings and skills open it', { timeout: 420_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-file-tab-'));
  const out = path.resolve(process.env.SCREENSHOTS ?? path.join(profile, 'shots'));
  await mkdir(out, { recursive: true });
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'workforce-elsewhere-'));
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [root], cwd: root, timeout: 60_000,
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    await rm(elsewhere, { recursive: true, force: true }).catch(() => {});
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.shell, .mobile-shell', { timeout: 60_000 });
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  const dataRoot = (await rpc.call('system.root')).path;

  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 400); win.setContentSize(w, h); }, [width, height]);
    await page.waitForTimeout(400);
  };
  const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
  const scheme = async (value) => { await page.emulateMedia({ colorScheme: value }); await page.waitForTimeout(300); };
  const strip = page.locator('.browser-strip');
  const bar = page.locator('.browser-bar');
  const field = page.locator('textarea.file-field');
  const status = page.locator('.pane-file .pane-foot-text');
  const dirty = () => page.locator('.file-dot.is-dirty').count();
  const shownTitle = () => page.locator('.browser-strip-tab.selected .browser-strip-title').textContent();
  const newTab = async () => { await strip.getByRole('button', { name: 'New tab', exact: true }).click(); await page.locator('.new-tab-row').first().waitFor(); };
  const row = (name) => page.locator('.new-tab .new-tab-row', { has: page.locator('.new-tab-label', { hasText: new RegExp(`^${name.replace(/[.\\]/g, '\\$&')}$`) }) });
  const openPath = async (target) => {
    await bar.getByRole('button', { name: 'Path', exact: true }).click();
    await bar.getByRole('textbox', { name: 'Path', exact: true }).fill(target);
    await page.keyboard.press('Enter');
  };

  await size(1280, 800);
  await page.waitForSelector('.shell');
  const cell = page.locator('.frame-workspace-cell button');
  if ((await cell.getAttribute('aria-expanded')) !== 'true') await cell.click();
  await strip.waitFor();

  // ---- "+" › Files: the data folder as one list, a folder opens here, Up goes back, a file gets a tab of its own
  await newTab();
  await row('Files').click();
  await row('settings.json').waitFor();
  assert.equal(await bar.getByRole('button', { name: 'Path', exact: true }).textContent(), dataRoot);
  assert.equal(await shownTitle(), path.basename(dataRoot));
  await row('Up').waitFor();
  const names = await page.locator('.new-tab-label').allTextContents();
  assert.ok(names.indexOf('agents') < names.indexOf('settings.json'), 'folders first');
  await shot('01-folder-light');
  await row('agents').click();
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'agents');
  assert.equal(await page.locator('.browser-strip-tab').filter({ hasText: path.basename(dataRoot) }).count(), 0, 'the folder tab went on in place');
  await row('Up').click();
  await row('settings.json').waitFor();
  const before = await page.locator('.browser-strip-tab').count();
  await row('settings.json').click();
  await field.waitFor();
  assert.equal(await page.locator('.browser-strip-tab').count(), before + 1);
  assert.equal(await shownTitle(), 'settings.json');
  assert.match(await field.inputValue(), /profile|theme/);
  await shot('02-settings-json-light');
  await scheme('dark'); await shot('03-settings-json-dark'); await scheme('light');

  // ---- typing, the dot in its cell, Ctrl+S; nothing shifts
  const note = path.join(elsewhere, 'note.md');
  await writeFile(note, 'first line\r\nsecond line\r\n');
  await openPath(note);
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'note.md');
  await field.waitFor();
  assert.equal(await field.inputValue(), 'first line\nsecond line\n');
  assert.equal(await dirty(), 0);
  const stableDuring = (action) => expectStable(page, ['.pane-file .file-dot', '.pane-file .pane-foot-action', '.pane-file .pane-foot-text', '.browser-address-form', 'textarea.file-field'], action);
  await stableDuring(async () => {
    await field.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('third line\n');
  });
  assert.equal(await dirty(), 1);
  assert.equal(await status.textContent(), 'Ctrl+S saves');
  await shot('04-dirty-light');
  await stableDuring(async () => {
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.querySelector('.file-dot.is-dirty'));
  });
  assert.equal(await readFile(note, 'utf8'), 'first line\r\nsecond line\r\nthird line\r\n', 'the line ends stay');

  // ---- a change on disk: followed while nothing waits, a notice with Reload under typed text
  await writeFile(note, 'from an agent\n');
  await page.waitForFunction(() => document.querySelector('textarea.file-field')?.value === 'from an agent\n', undefined, { timeout: 8_000 });
  assert.match(await status.textContent(), /Changed on disk, reloaded/);
  await field.click();
  await page.keyboard.type('mine ');
  const reload = page.locator('.pane-file .pane-foot-action').getByRole('button', { name: 'Reload' });
  await stableDuring(async () => {
    await writeFile(note, 'from the agent again\n');
    await reload.waitFor({ timeout: 8_000 });
  });
  assert.match(await status.textContent(), /Changed on disk/);
  assert.match(await field.inputValue(), /mine/);
  await shot('05-changed-light');
  await scheme('dark'); await shot('06-changed-dark'); await scheme('light');
  await stableDuring(async () => {
    await reload.click();
    await page.waitForFunction(() => document.querySelector('textarea.file-field')?.value === 'from the agent again\n');
  });
  assert.equal(await reload.count(), 0);

  // ---- a draft stays when the tab is left and when it is closed
  await field.click();
  await page.keyboard.type('draft ');
  await page.locator('.browser-strip-tab').first().click();
  await field.waitFor({ state: 'detached' });
  await page.locator('.browser-strip-tab', { hasText: 'note.md' }).click();
  await page.waitForFunction(() => /draft/.test(document.querySelector('textarea.file-field')?.value ?? ''));
  assert.equal(await dirty(), 1);
  await page.locator('.browser-strip-tab', { hasText: 'note.md' }).getByRole('button', { name: 'Close note.md' }).click();
  await field.waitFor({ state: 'detached' });
  await newTab();
  await row('Files').click();
  await openPath(note);
  await page.waitForFunction(() => /draft/.test(document.querySelector('textarea.file-field')?.value ?? ''));
  assert.equal(await dirty(), 1, 'the draft came back with the path');

  // ---- 1 MB: loads, and a keystroke stays quick
  const big = path.join(elsewhere, 'big.txt');
  const line = `${'x'.repeat(99)}\n`;
  await writeFile(big, line.repeat(10_500));
  await openPath(big);
  await page.waitForFunction(() => (document.querySelector('textarea.file-field')?.value.length ?? 0) > 1_000_000, undefined, { timeout: 15_000 });
  await field.click();
  await page.keyboard.press('Control+Home');
  const keystroke = await page.evaluate(async () => {
    const area = document.querySelector('textarea.file-field');
    area.focus();
    const started = performance.now();
    for (let index = 0; index < 20; index += 1) {
      document.execCommand('insertText', false, 'y'); // the path of a real key press (setRangeText would rebuild the whole field)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return (performance.now() - started) / 20;
  });
  t.diagnostic(`1 MB file: ${keystroke.toFixed(1)} ms per keystroke and frame`);
  assert.ok(keystroke < 500, `a keystroke in a 1 MB file stays usable (${keystroke.toFixed(1)} ms)`); // generous: this runs on PCs short of memory
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('.file-dot.is-dirty'), undefined, { timeout: 15_000 });
  assert.equal((await readFile(big, 'utf8')).length, line.length * 10_500 + 20);
  await shot('07-one-megabyte-light');

  // ---- a binary and a very large file say so and offer the system's own app
  const binary = path.join(elsewhere, 'picture.bin');
  await writeFile(binary, Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
  await openPath(binary);
  const noEditor = page.locator('.pane-view .workspace-start');
  await noEditor.filter({ hasText: 'not text' }).waitFor();
  await noEditor.getByRole('button', { name: 'Open with system' }).waitFor();
  await shot('08-binary-light');
  const large = path.join(elsewhere, 'large.log');
  await writeFile(large, Buffer.alloc(3 * 1024 * 1024, 0x61));
  await openPath(large);
  await noEditor.filter({ hasText: 'too large' }).waitFor();

  // ---- a path that holds nothing yet is a new file; a typed folder opens as a folder
  const fresh = path.join(elsewhere, 'sub', 'new.md');
  await openPath(fresh);
  await field.waitFor();
  await page.waitForFunction(() => /New file/.test(document.querySelector('.pane-file .pane-foot-text')?.textContent ?? ''));
  await field.click();
  await page.keyboard.type('created');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('.file-dot.is-dirty'));
  assert.equal(await readFile(fresh, 'utf8'), 'created');
  await openPath(elsewhere);
  await row('note.md').waitFor();
  await row('sub').waitFor();
  await openPath(elsewhere + path.sep); // the same folder written another way: the tab stays
  await page.waitForTimeout(300);
  await row('note.md').waitFor();
  assert.equal(await shownTitle(), path.basename(elsewhere));
  await shot('09-elsewhere-folder-light');
  const menu = page.locator('.popover');
  await row('note.md').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open with system' }).waitFor();
  await menu.getByRole('menuitem', { name: 'Show in folder' }).waitFor();
  await shot('10-row-menu-light');
  await page.keyboard.press('Escape');

  // ---- Settings: the page's file cell opens the tab, a right click keeps the system's own app
  await page.evaluate(() => { location.hash = '#/settings/general'; });
  const fileCell = page.locator('[data-cell="open-file"] button');
  await fileCell.waitFor();
  await fileCell.click();
  await field.waitFor();
  assert.equal(await shownTitle(), 'settings.json');
  await page.locator('[data-cell="open-file"]').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open with system' }).waitFor();
  await page.keyboard.press('Escape');
  await shot('11-settings-cell-light');
  await page.evaluate(() => { location.hash = '#/settings/secrets'; });
  await page.waitForFunction(() => document.querySelector('[data-cell="open-file"] button')?.getAttribute('aria-label')?.includes('secrets'));
  await fileCell.click();
  await row('Up').waitFor(); // the secrets folder, or the nearest one that exists on a new profile
  assert.notEqual(await shownTitle(), 'settings.json');

  // ---- Settings › Skills & memory: a skill with its route, the memory tree, both open the tab
  const memories = path.join(dataRoot, 'memory', 'company');
  await mkdir(memories, { recursive: true });
  await writeFile(path.join(memories, 'supplier.md'), '---\ntitle: Supplier\n---\nCalls back on Fridays.\n');
  await page.evaluate(() => { location.hash = '#/settings/skills'; });
  const skill = page.locator('.file-open-row', { hasText: 'Built-in' }).first(); // the app's own: the profile's real home also lists ~/.claude/skills
  await skill.waitFor();
  const skills = await page.locator('.file-open-row .set-row-hint').allTextContents();
  assert.ok(skills.some((hint) => hint.startsWith('Built-in')), 'the built-in route is named');
  await shot('12-skills-memory-light');
  await scheme('dark'); await shot('13-skills-memory-dark'); await scheme('light');
  await skill.click();
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'SKILL.md');
  await field.waitFor();
  assert.match(await field.inputValue(), /^---/);
  const tree = page.locator('#settings-memory .file-tree-row');
  await tree.filter({ hasText: 'company' }).click();
  await tree.filter({ hasText: 'supplier.md' }).click();
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'supplier.md');
  await page.waitForFunction(() => /Fridays/.test(document.querySelector('textarea.file-field')?.value ?? ''));
  await shot('14-memory-open-light');

  // ---- an agent's page: SYSTEM.md and last-prompt.md open the same way
  const agents = await rpc.call('agents.list');
  await page.evaluate((id) => { location.hash = `#/team/${id}`; }, agents[0].id);
  const systemRow = page.locator('.agent-row', { hasText: 'SYSTEM.md' });
  await systemRow.getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'SYSTEM.md');
  await field.waitFor();
  await shot('15-agent-system-light');
  await page.locator('.agent-row', { hasText: 'last-prompt.md' }).getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction(() => document.querySelector('.browser-strip-tab.selected .browser-strip-title')?.textContent === 'last-prompt.md');

  // ---- a small window (the phone layout): the chat's area takes the body above the composer; its Files row opens the data
  // folder there (a file itself opens in the system's app at this width – file-tabs.ts)
  await size(640, 480);
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, (await rpc.call('chats.list'))[0].id);
  const tabsCell = page.locator('.mobile-shell [data-cell="workspace"] button');
  await tabsCell.click();
  const chatArea = page.locator('.chat-area');
  await chatArea.locator('.browser-strip').waitFor();
  await chatArea.locator('.new-tab-row', { hasText: 'Files' }).click();
  await chatArea.locator('[aria-label="Folder"]').waitFor();
  assert.ok(await page.locator('.mobile-shell .composer').isVisible(), 'the composer stays under the area');
  await shot('16-640x480-light');
  await scheme('dark'); await shot('17-640x480-dark'); await scheme('light');
  await tabsCell.click();
  await chatArea.waitFor({ state: 'detached' });
  await size(1280, 800);
  assert.deepEqual(errors, [], 'no renderer errors');
  t.diagnostic(`screenshots: ${out}`);
});
