// Electron window check of Chat details › Members › "Connect external agent" (C8) with the demo
// engine in an isolated profile: the name form, the token shown once with the `/ws` address (with
// Copy and Done – gone after Done), the member row "Research-Bot · External agent", and Remove (after the confirm
// dialog) taking it out of the chat and revoking the token. Screenshots light, dark and 640×480;
// no horizontal page scroll; no renderer errors.
// The socket side is covered by test/unit/bridges/external-agents.test.ts and
// test/e2e/external-agent.test.mjs.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

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

test('Connect external agent: name, token once, member row, remove', { timeout: 240_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-ext-agent-'));
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
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const agents = await rpc.call('agents.list');
  const chat = await rpc.call('chats.create', { title: 'Outside help', agentIds: [agents[0].id] });

  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const members = page.locator('section[aria-label="Members"]');
  const openDetails = async () => {
    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    await page.waitForTimeout(1000);
    if (!await page.locator('.chat-details').first().isVisible().catch(() => false)) await page.locator('.chat-title-button').first().click();
    await members.waitFor({ timeout: 15_000 });
  };
  await size(1280, 820);
  await openDetails();

  await members.getByRole('button', { name: 'Connect external agent' }).click();
  await members.getByLabel('Name').fill('Research Bot');
  await members.getByRole('button', { name: 'Connect' }).click();
  const token = members.locator('.bridge-field input[readonly]');
  await token.waitFor({ timeout: 15_000 });
  assert.match(await token.inputValue(), /^wfx_[A-Za-z0-9_-]{43}$/);
  const note = (await members.locator('.bridge-field small').textContent()) ?? '';
  assert.match(note, /Shown only this once/);
  assert.match(note, /ws:\/\/localhost:\d+\/ws/, 'the address the agent connects to');
  await members.scrollIntoViewIfNeeded();
  await shot('ext-agent-01-token-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('ext-agent-02-token-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await members.getByRole('button', { name: 'Done' }).click();
  await token.waitFor({ state: 'detached', timeout: 10_000 });
  const row = members.locator('.details-member', { hasText: 'Research-Bot' });
  await row.waitFor({ timeout: 10_000 });
  assert.match((await row.textContent()) ?? '', /External agent/);
  const stored = (await rpc.call('chats.get', { id: chat.id })).members.find((member) => member.memberId.startsWith('ext:api:'));
  assert.ok(stored && stored.kind === 'external', 'the member is stored as an external agent');
  await shot('ext-agent-03-row-light');

  await row.click({ button: 'right' }); // the member's right-click menu
  await page.locator('.menu[aria-label="Context menu"]').getByRole('menuitem', { name: /Remove from chat/ }).click();
  await page.locator('.dialog-actions').getByRole('button', { name: 'Remove' }).click();
  await row.waitFor({ state: 'detached', timeout: 10_000 });
  const after = (await rpc.call('chats.get', { id: chat.id })).members.filter((member) => member.memberId.startsWith('ext:api:') && !member.leftAt);
  assert.equal(after.length, 0, 'removed in the runtime');

  await size(640, 480); // phone layout re-mounts the details
  await page.waitForTimeout(600);
  await openDetails().catch(() => undefined);
  await members.first().scrollIntoViewIfNeeded().catch(() => undefined);
  await shot('ext-agent-04-640x480');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at 640 px (${overflow}px)`);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
