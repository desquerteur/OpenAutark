// AF-013 Electron window check of access modes with the demo engine in an isolated test profile:
//   * a new chat's composer shows the agent's mode in its mode cell (data-tour="permission-mode"): Full access by default;
//   * read only (set on the agent, kept in agents/<id>/access.json): the agent's files.write is refused, no file appears;
//   * a click on the cell switches this chat to the next mode (Ask first, a chat override); the agent's write now opens the
//     approval dialog in the window; "Allow once" lets it write; Deny refuses the next one;
//   * Shift+Tab in the message field switches to the next mode (Project); nothing in the action row moves;
//   * the agent page shows Access with the agent's own mode;
//   * screenshots light, dark and 375 px (no horizontal scroll); no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const exists = (file) => stat(file).then(() => true, () => false);

test('access modes: the mode cell, read only refuses a write, ask opens the approval dialog', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-access-'));
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
  const chat = await rpc.call('chats.create', { title: 'Access check', agentIds: [manager.id] });
  const until = async (what, check, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(150)) { const value = await check(); if (value) return value; }
    assert.fail(`timed out: ${what}`);
  };
  /** The person sends the directives; resolves with the agent's final answer. */
  const agentDoes = async (body) => {
    const sent = await rpc.call('messages.send', { conversationId: chat.id, body });
    return until('the agent\'s answer', async () => {
      const messages = await rpc.call('messages.list', { conversationId: chat.id, limit: 50 });
      return messages.find((message) => message.authorId === manager.id && message.seq > sent.seq && message.state === 'final')?.body;
    });
  };
  const target = (name) => path.join(profile, 'workspace-out', name);
  const write = (name) => `[[tool:files.write ${JSON.stringify({ path: target(name), content: 'hello' })}]]`;

  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const cell = page.locator('.composer-actions .access-mode-cell[data-tour="permission-mode"]');
  await cell.waitFor({ timeout: 20_000 });
  await until('the default mode', async () => (await cell.textContent())?.includes('Full access'));
  await shot('access-full-light');

  // Read only on the agent: kept in its folder, the write is refused, no file.
  await rpc.call('access.set', { agentId: manager.id, mode: 'read' });
  await until('the cell follows', async () => (await cell.textContent())?.includes('Read only'));
  const kept = JSON.parse(await readFile(path.join(profile, 'agents', manager.id, 'access.json'), 'utf8'));
  assert.equal(kept.mode, 'read');
  const refused = await agentDoes(`Write it ${write('read.txt')}`);
  assert.match(refused, /My access does not allow this/);
  assert.equal(await exists(target('read.txt')), false, 'read only: no file was written');

  // A click: this chat asks first (a chat override); the write opens the dialog; Allow once writes it.
  const box = async () => (await cell.boundingBox());
  const before = await box();
  await cell.click();
  await until('ask in this chat', async () => (await cell.textContent())?.includes('Ask first'));
  assert.deepEqual(await box(), before, 'the cell keeps its box');
  const effective = await rpc.call('access.get', { agentId: manager.id, conversationId: chat.id });
  assert.deepEqual([effective.mode, effective.source, effective.agentMode], ['ask', 'chat', 'read']);
  const asking = agentDoes(`Write it ${write('ask.txt')}`);
  const dialog = page.locator('dialog.access-request');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  assert.match(await dialog.textContent(), /asks for approval[\s\S]*Change [\s\S]*ask\.txt/);
  assert.equal(await dialog.getByRole('button', { name: /Always for/ }).count(), 1);
  await shot('access-dialog-light');
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  const allowed = await asking;
  assert.doesNotMatch(allowed, /does not allow|declined/);
  assert.equal(await readFile(target('ask.txt'), 'utf8'), 'hello', 'allowed once: written');
  const denying = agentDoes(`Write it ${write('deny.txt')}`);
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Deny' }).click();
  assert.match(await denying, /declined/);
  assert.equal(await exists(target('deny.txt')), false);

  // Shift+Tab in the field: the next mode.
  const field = page.locator('.composer-input');
  await field.click();
  await page.keyboard.press('Shift+Tab');
  await until('project in this chat', async () => (await cell.textContent())?.includes('Project'));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('composer-input')), true, 'the focus stays in the field');

  // The agent page: Access with the agent's own mode.
  await page.evaluate((id) => { location.hash = `#/team/${id}`; }, manager.id);
  const section = page.locator('section.agent-section[aria-label="Access"]');
  await section.waitFor({ timeout: 20_000 });
  assert.match(await section.textContent(), /Mode[\s\S]*Reads files and the web, changes nothing/);
  await shot('access-agent-page-light');

  // Dark and phone width.
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await cell.waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  await rpc.call('settings.update', { preferences: { theme: 'dark' } }).catch(() => undefined);
  await shot('access-cell-dark');
  await size(375, 760);
  await page.waitForTimeout(600);
  await cell.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scroll at 375 px');
  await shot('access-cell-375');
  assert.deepEqual(errors.filter((text) => !/favicon|ResizeObserver/.test(text)), [], 'no renderer errors');
});
