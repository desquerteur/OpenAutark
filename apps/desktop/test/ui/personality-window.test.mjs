// Electron window check of AF-006 (personality) with the demo engine in an isolated test profile:
//   * Settings › Personality (nav entry data-tour="personality"): a preset chip, the length, the tone select, the free
//     text and "About me" save into settings.json (`personality`, profile.notes); the preview shows the section;
//   * the next answer reads it – the agent's last-prompt.md (written each turn) carries "## My personality" with the tone
//     just chosen, and after a change of the tone in the window the very next answer carries the new one (no restart);
//   * on the agent's page a preset for it alone writes its personality.json and its next answer reads "(set for me)";
//     its role edited there (Save role) replaces its own part of SYSTEM.md, and the next answer reads the new role;
//   * screenshots light, dark and 390×844; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { ask, connect } from '../e2e/lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = process.env.ELECTRON_EXE ?? path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'); // ELECTRON_EXE: another install's binary

test('personality: Settings › Personality and an agent\'s own one reach its next answer – desktop, dark and 390 px', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-personality-'));
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
  await size(1280, 900);
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  await rpc.call('settings.update', { onboarding: { step: 'done' }, profile: { name: 'Alex' } });
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'seed Manager exists');
  const chat = await rpc.call('chats.create', { title: 'Tone check', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: [`chat:${chat.id}`, 'org'] });
  const until = async (check, what, ms = 10_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) assert.fail(`timed out: ${what}`);
      await page.waitForTimeout(150);
    }
  };
  const personality = async () => (await rpc.call('settings.get')).personality;
  /** One answer of the Manager, then the system prompt that answer was built with. */
  const nextPrompt = async (body) => {
    await ask(rpc, chat.id, manager.id, body, { timeoutMs: 90_000 });
    return readFile(path.join(profile, 'agents', manager.id, 'last-prompt.md'), 'utf8');
  };

  // Settings › Personality: its nav entry is the tour's anchor.
  await go('#/settings/personality');
  const view = page.locator('.personality-settings');
  await view.waitFor({ timeout: 20_000 });
  const nav = page.locator('.settings-nav [data-tour="personality"]');
  assert.equal(await nav.getAttribute('aria-current'), 'page');
  await shot('personality-01-settings-light');

  await view.getByRole('button', { name: 'Casual and friendly' }).click();
  await until(async () => (await personality())?.tone === 'casual', 'preset saved');
  assert.equal(await view.getByRole('button', { name: 'Casual and friendly' }).getAttribute('aria-pressed'), 'true');
  await view.getByRole('radio', { name: 'Short' }).click();
  await until(async () => (await personality())?.length === 'short', 'length saved');
  const text = view.getByLabel('How the AI should treat you');
  await text.fill('Call me Alex. Ask before you send anything in my name.');
  await text.blur();
  await until(async () => (await personality())?.instructions === 'Call me Alex. Ask before you send anything in my name.', 'instructions saved');
  const about = view.getByLabel('About me');
  await about.fill('I run a small video studio.');
  await about.blur();
  await until(async () => (await rpc.call('settings.get')).profile.notes === 'I run a small video studio.', 'about me saved');
  await view.locator('.personality-preview summary').click();
  await until(async () => (await view.locator('.personality-preview-text').textContent())?.includes('Tone: casual'), 'preview shows the tone');
  await shot('personality-02-settings-filled-light');

  // The next answer reads it, without a restart.
  let prompt = await nextPrompt('Hello, how are you?');
  for (const line of ['## My personality (how Alex wants me to write', '- Tone: casual and relaxed', '- Length: short', 'Call me Alex. Ask before you send anything in my name.', 'I run a small video studio.']) {
    assert.ok(prompt.includes(line), `first answer misses: ${line}`);
  }

  // The tone changed in the window: the very next answer reads the new one.
  await view.getByRole('combobox', { name: 'Tone' }).click();
  await page.getByRole('option', { name: /^Formal/ }).click();
  await until(async () => (await personality())?.tone === 'formal', 'tone saved');
  prompt = await nextPrompt('And now?');
  assert.ok(prompt.includes('- Tone: formal and polite.'), 'the next answer has the new tone');
  assert.ok(!prompt.includes('casual and relaxed'), 'the old tone is gone');

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('personality-03-settings-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // The agent's page: a preset for it alone, then its role.
  await go(`#/team/${manager.id}`);
  const own = page.locator('.agent-personality');
  await own.waitFor({ timeout: 20_000 });
  await own.scrollIntoViewIfNeeded();
  await own.getByRole('button', { name: 'Factual and brief' }).click();
  const file = path.join(profile, 'agents', manager.id, 'personality.json');
  await until(async () => (await readFile(file, 'utf8').catch(() => '')).includes('"factual"'), 'personality.json written');
  await own.getByRole('combobox', { name: 'Tone' }).waitFor();
  assert.match(await own.getByRole('combobox', { name: 'Tone' }).textContent(), /Factual/);
  await shot('personality-04-agent-light');
  prompt = await nextPrompt('Short status please');
  assert.ok(prompt.includes('- Tone: factual and to the point – no small talk (set for me).'), 'the agent\'s own tone wins');
  assert.ok(prompt.includes('- Length: short'), 'the preset\'s length');

  const role = page.getByLabel(`${manager.name}'s role`);
  await role.scrollIntoViewIfNeeded();
  const before = await role.inputValue();
  assert.match(before, /^## My role/);
  await role.fill(`${before}\n- I also keep the team calendar tidy.`);
  await page.getByRole('button', { name: 'Save role' }).click();
  await until(async () => (await rpc.call('agents.get', { id: manager.id })).instructions.includes('I also keep the team calendar tidy.'), 'role saved');
  const system = await readFile(path.join(profile, 'agents', manager.id, 'SYSTEM.md'), 'utf8');
  assert.ok(system.includes('# How I work') && system.includes('I also keep the team calendar tidy.'), 'SYSTEM.md: the standard stays, the role is new');
  await shot('personality-05-role-light');
  prompt = await nextPrompt('What do you do?');
  assert.ok(prompt.includes('I also keep the team calendar tidy.'), 'the next answer reads the new role');

  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('personality-06-agent-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(390, 844);
  await go('#/settings/personality');
  await view.waitFor({ timeout: 10_000 });
  await shot('personality-07-settings-390');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no sideways scroll at 390 px (${overflow})`);

  assert.deepEqual(errors, [], 'no renderer errors');
});
