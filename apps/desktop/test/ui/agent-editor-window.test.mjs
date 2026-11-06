// Electron window check of the agent editor, the agent's menu and restore (Umbau Einfachheit) with the demo engine in
// an isolated test profile:
//   * Edit on the agent page opens the small editor (avatar, name, role, instructions); an untouched editor has
//     nothing to save; an emoji avatar with a palette color, then an uploaded image (cropped and scaled in the page,
//     stored as an image file) – each saved as one agents.update; role and instructions (SYSTEM.md) save the same way;
//   * the page title is the agent's menu (the same as a right click on the agent): Message · Browser · Connect
//     Telegram… | Duplicate… · Change reports-to… · Export | Archive; Duplicate… opens the Manager's chat with
//     "Duplicate <name>" in the composer (the skill agent-duplicate does the copy);
//   * Archive (confirmed) moves its reports up to its manager; the sidebar's "Archived (n)" lists it and its right-click
//     menu's Restore brings it back under its old manager;
//   * the editor fits at 390 px (phone width); screenshots light, dark and 390×844; no renderer errors.
// Whom an agent reports to is changed by asking the AI ("Change reports-to…" prepares that request).
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect, waitForNew } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
// A valid 4×4 RGB PNG (four color blocks) – a real image the page can decode, crop and scale.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAHklEQVR4nGO4E9BzJ6BHA4wYUDkneu6c6NEAIxQOAHoSGaEVk4izAAAAAElFTkSuQmCC', 'base64');

test('agent editor: avatars, role and instructions, the title menu, duplicate, archive and restore – desktop and 390 px', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-agent-editor-'));
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
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' } });
  await rpc.call('events.subscribe', { topics: ['org'] });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const lena = await rpc.call('agents.create', { name: 'Lena', role: 'Marketing lead', managerId: manager.id });
  const ravi = await rpc.call('agents.create', { name: 'Ravi', role: 'Writer', managerId: lena.id });
  const pia = await rpc.call('agents.create', { name: 'Pia', role: 'Producer', managerId: manager.id });
  const get = async (id) => (await rpc.call('agents.list', { includeArchived: true })).find((agent) => agent.id === id);

  const editor = page.locator('form.agent-editor');
  const openEditor = async (agentId) => {
    await go(`#/team/${agentId}`);
    await page.locator('.agent-identity').getByRole('button', { name: 'Edit' }).click();
    await editor.waitFor({ timeout: 10_000 });
  };
  const save = async () => {
    await editor.getByRole('button', { name: 'Save' }).click();
    await editor.waitFor({ state: 'detached', timeout: 10_000 });
  };

  // An untouched editor has nothing to save.
  await openEditor(lena.id);
  assert.equal(await editor.getByRole('button', { name: 'Save' }).isDisabled(), true, 'Save is off without changes');
  for (const label of ['Name', 'Role', 'Instructions']) assert.equal(await editor.getByLabel(label, { exact: true }).count(), 1, label);
  await shot('agent-editor-01-open-light');

  // Emoji avatar with a palette color.
  await editor.getByRole('radio', { name: 'Emoji', exact: true }).click();
  await editor.locator('.avatar-emoji-pick', { hasText: '🎬' }).click();
  await editor.getByRole('radio', { name: 'Color 5', exact: true }).click();
  await save();
  await rpc.waitFor('agent.upserted', (agent) => agent.id === lena.id && agent.avatar.kind === 'emoji', 15_000);
  assert.deepEqual((await get(lena.id)).avatar, { kind: 'emoji', value: '🎬', color: 4 });
  assert.equal(await page.locator('.agent-identity .avatar-emoji', { hasText: '🎬' }).count(), 1, 'the emoji shows at once');

  // Image avatar: cropped and scaled in the page, stored as an image file.
  await openEditor(lena.id);
  await editor.getByRole('radio', { name: 'Image', exact: true }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), editor.getByRole('button', { name: 'Upload image' }).click()]);
  await chooser.setFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG });
  await editor.locator('.avatar-picker-preview img').waitFor({ timeout: 15_000 });
  await shot('agent-editor-02-image-light');
  await save();
  await rpc.waitFor('agent.upserted', (agent) => agent.id === lena.id && agent.avatar.kind === 'image', 15_000);
  const imageAvatar = (await get(lena.id)).avatar;
  assert.match(imageAvatar.value, /^[a-f0-9]{64}$/);
  const file = await rpc.call('files.get', { id: imageAvatar.value });
  assert.equal(file.mime, 'image/png');
  await page.locator('.agent-identity .avatar img').waitFor({ timeout: 15_000 });

  // Role and instructions: one save; fields the person did not touch stay.
  await openEditor(lena.id);
  await editor.getByLabel('Role', { exact: true }).fill('Head of marketing');
  await editor.getByLabel('Instructions', { exact: true }).fill('Plan the launch campaigns. Keep posts short.');
  await save();
  await rpc.waitFor('agent.upserted', (agent) => agent.id === lena.id && agent.role === 'Head of marketing', 15_000);
  const edited = await get(lena.id);
  assert.equal(edited.avatar.kind, 'image', 'the avatar stays');
  assert.equal(edited.managerId, manager.id, 'it still reports to the Manager');
  const core = await rpc.call('agents.core', { id: lena.id }).catch(() => null);
  if (core && typeof core === 'object' && 'instructions' in core) assert.match(String(core.instructions), /Keep posts short/);
  await page.locator('.agent-role', { hasText: 'Head of marketing' }).waitFor({ timeout: 10_000 });

  // The title is the agent's menu.
  const titleMenu = page.locator('.agent-header .title-menu');
  await titleMenu.click();
  const menu = page.getByRole('menu', { name: 'Lena menu' });
  await menu.waitFor({ timeout: 5_000 });
  const items = (await menu.locator('[role="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  assert.deepEqual(items, ['Message', 'Browser', 'Open in side panel', 'Connect Telegram…', 'Duplicate…', 'Change reports-to…', 'Export', 'Archive']);
  await shot('agent-editor-03-title-menu-light');

  // Duplicate…: "set up with AI" – the Manager's chat opens with "Duplicate Lena" in the composer (nothing is sent).
  await menu.getByRole('menuitem', { name: 'Duplicate…', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/chat/'), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('textarea.composer-input')?.value.includes('Duplicate Lena'), undefined, { timeout: 10_000 });

  // Archive (confirmed) → its report moves up → the sidebar's Archived (n) → Restore: back under its old manager.
  await go(`#/team/${lena.id}`);
  await page.locator('.agent-name', { hasText: /^Lena/ }).first().waitFor({ timeout: 10_000 });
  await titleMenu.click();
  await menu.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await page.locator('dialog[open] .dialog-actions button', { hasText: 'Archive' }).click();
  await rpc.waitFor('agent.removed', (data) => data.id === lena.id, 15_000).catch(async () => {
    assert.ok((await get(lena.id)).archivedAt, 'Lena is archived');
  });
  assert.equal((await get(ravi.id)).managerId, manager.id, "Lena's report moved up to the Manager");
  const archived = page.locator('.team-archived');
  await archived.locator('.team-archived-toggle', { hasText: 'Archived (1)' }).waitFor({ timeout: 10_000 });
  await archived.locator('.team-archived-toggle').click();
  const row = archived.locator('.team-row.archived', { hasText: 'Lena' });
  await row.waitFor({ timeout: 5_000 });
  await shot('agent-editor-04-archived-light');
  const lenaBack = waitForNew(rpc, 'agent.upserted', (agent) => agent.id === lena.id && agent.archivedAt === undefined, 15_000);
  await row.click({ button: 'right' });
  await page.locator('.menu[aria-label="Context menu"]').getByRole('menuitem', { name: 'Restore', exact: true }).click();
  await lenaBack;
  assert.equal((await get(lena.id)).managerId, manager.id, 'restored under its old manager');
  await archived.waitFor({ state: 'detached', timeout: 10_000 });

  // Dark.
  await page.emulateMedia({ colorScheme: 'dark' });
  await openEditor(pia.id);
  await shot('agent-editor-05-editor-dark');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone width: the editor fits.
  await size(390, 844);
  await page.waitForTimeout(600);
  await openEditor(pia.id);
  const overflow = await page.evaluate(() => {
    const form = document.querySelector('form.agent-editor');
    return { page: document.documentElement.scrollWidth - innerWidth, form: form ? form.scrollWidth - form.clientWidth : -1 };
  });
  assert.ok(overflow.page <= 0 && overflow.form <= 0, `no horizontal overflow at 390 px: ${JSON.stringify(overflow)}`);
  await editor.getByRole('radio', { name: 'Emoji', exact: true }).click();
  await shot('agent-editor-06-phone-editor');
  await editor.locator('.avatar-emoji-pick', { hasText: '💡' }).click();
  await save();
  await rpc.waitFor('agent.upserted', (agent) => agent.id === pia.id && agent.avatar.kind === 'emoji' && agent.avatar.value === '💡', 15_000);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
