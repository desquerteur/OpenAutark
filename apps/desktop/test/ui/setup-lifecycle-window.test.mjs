// Electron window check of the onboarding lifecycle (AF-002 setup assistant: About you → AI → tools → first agent) with
// the demo engine in an isolated test profile:
//   * the assistant goes step by step and each step writes its step; "Back" goes to the step before; another window
//     moving the step on is followed; the rail's My day (#/day) keeps it on screen, another place shows the line
//     "Setup is not finished yet." with Continue setup (back to the assistant);
//   * the last step can hire one more agent; Start completes the onboarding and opens the Manager's first chat with the
//     app's start text as the person's line, once, and starts the spotlight tour (Esc: skipped); My day shows no setup line;
//   * Team's Add menu offers "Start setup again" (its confirm's Cancel changes nothing); Settings › General › Getting
//     started's "Run setup again" asks the same confirm, then resets onboarding (step 'profile', not completed) and shows
//     the assistant on Home from its first step;
//   * screenshots light, dark and phone width; no horizontal scroll; no renderer errors.
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
test('setup steps and Back; Start → the Manager\'s chat and the tour, no setup line; "Run setup again" brings the assistant back', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-setup-lifecycle-'));
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
  const go = (hash) => page.evaluate((target) => { location.hash = target; }, hash);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const step = async () => (await page.locator('.first-run-step').textContent())?.trim();

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const onboarding = async () => { const value = (await rpc.call('settings.get')).onboarding; return { completed: value.completed, step: value.step }; };
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager' && !agent.archivedAt);
  assert.ok(manager, 'a fresh profile has the seed Manager');
  /** The saved step, once the window's write has landed (the card shows at once; the write follows). */
  const savedStep = async (want) => { for (let i = 0; i < 50; i += 1) { const now = (await onboarding()).step; if (now === want) return now; await page.waitForTimeout(100); } return (await onboarding()).step; };
  /** Dismisses a first-visit hint if one shows within a moment (the tour was skipped, so hints are due). */
  const noHint = async () => {
    const hint = page.locator('dialog.spotlight.spotlight-hint');
    await hint.waitFor({ timeout: 2_500 }).then(() => hint.locator('.spotlight-next').click(), () => undefined);
    await page.locator('dialog.spotlight').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  };

  // About you → Continue → AI; the rail's My day keeps the assistant on screen; another place shows the setup line.
  const profileCard = page.locator('.first-run-card[data-card="first-run-profile"]');
  const ai = page.locator('.first-run-card[data-card="first-run-ai"]');
  const tools = page.locator('.first-run-card[data-card="first-run-connectors"]');
  const agentCard = page.locator('.first-run-card[data-card="first-run-agent"]');
  await profileCard.waitFor({ timeout: 30_000 });
  assert.equal(await step(), 'Step 1 of 4');
  await page.locator('.rail').getByRole('button', { name: 'My day' }).click();
  await page.waitForFunction(() => location.hash === '#/day', undefined, { timeout: 5_000 });
  await profileCard.waitFor({ timeout: 5_000 }); // AF-002: before, #/day showed My day and the setup was gone
  await go('#/team');
  const reminder = page.locator('[data-notice="setup-open"]');
  await reminder.waitFor({ timeout: 10_000 });
  assert.match(await reminder.textContent(), /Setup is not finished yet\./);
  await shot('lifecycle-00-setup-line');
  await reminder.getByRole('button', { name: 'Continue setup' }).click();
  await profileCard.waitFor({ timeout: 10_000 });
  assert.equal(await reminder.count(), 0, 'no line on My day itself');
  await profileCard.getByRole('button', { name: 'Continue' }).click();
  await ai.waitFor({ timeout: 15_000 });
  assert.equal(await savedStep('ai'), 'ai');
  assert.equal(await step(), 'Step 2 of 4');
  await ai.locator('.first-run-actions button.primary:enabled').waitFor({ timeout: 60_000 }); // the demo model answers
  assert.equal(await ai.getByRole('button', { name: 'Skip for now' }).count(), 0, 'a model answers: nothing to skip');

  // Back to About you; another window moving on is followed; then on to the tools and the first agent.
  await ai.getByRole('button', { name: 'Back' }).click();
  await profileCard.waitFor({ timeout: 15_000 });
  assert.equal(await savedStep('profile'), 'profile');
  await rpc.call('settings.update', { onboarding: { step: 'connectors' } }); // another window moved on: this one follows
  await tools.waitFor({ timeout: 15_000 });
  await tools.getByRole('button', { name: 'Back' }).click();
  await ai.waitFor({ timeout: 15_000 });
  await ai.getByRole('button', { name: 'Continue' }).click();
  await tools.waitFor({ timeout: 15_000 });
  await tools.getByRole('button', { name: 'Continue' }).click();
  await agentCard.waitFor({ timeout: 15_000 });
  assert.equal(await savedStep('agent'), 'agent');
  await shot('lifecycle-01-agent-light');

  // Hire another agent too: agents.create, the new agent shows on the card.
  const before = (await rpc.call('agents.list')).length;
  await agentCard.getByRole('button', { name: 'Hire another agent too' }).click();
  await agentCard.getByLabel('Role').fill('Researcher');
  await agentCard.getByRole('button', { name: 'Hire', exact: true }).click();
  await agentCard.locator('.first-run-agent:not(.lead)').waitFor({ timeout: 15_000 });
  assert.equal((await rpc.call('agents.list')).length, before + 1, 'one hire');

  // Start: the Manager's first chat opens with the start text as the person's line, once; the tour starts – Esc closes it.
  await agentCard.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/chat/'), undefined, { timeout: 20_000 });
  const chatId = await page.evaluate(() => decodeURIComponent(location.hash.slice('#/chat/'.length)));
  await page.locator('dialog.spotlight .spotlight-next').waitFor({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.locator('dialog.spotlight').waitFor({ state: 'detached', timeout: 10_000 });
  assert.deepEqual(await onboarding(), { completed: true, step: 'done' }, 'Start completes the onboarding');
  assert.equal((await rpc.call('settings.get')).onboarding.tour, 'skipped', 'Esc counts as skipped');
  // After a skipped tour each area shows a first-visit hint once (spotlight-tour-window.test.mjs checks them): here they
  // count as shown, so the steps below meet no hint.
  await rpc.call('settings.update', { onboarding: { hints: ['day', 'tasks', 'chats', 'chat', 'team', 'settings', 'apps', 'skills', 'secrets', 'devices', 'pane'] } });
  const human = (await rpc.call('messages.list', { conversationId: chatId, limit: 20 })).filter((message) => message.authorKind === 'human');
  assert.equal(human.length, 1, "the start text, once, as the person's line");
  assert.match(human[0].body, /^Automatic message/);

  // Home (My day): no setup line.
  await go('#/home');
  await page.locator('.day-view').waitFor({ timeout: 15_000 });
  await noHint();
  assert.equal(await page.locator('[data-notice="setup"], [data-notice="setup-open"]').count(), 0, 'no setup line');
  await shot('lifecycle-02-home-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('lifecycle-03-home-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Team's Add › Start setup again asks first (Cancel keeps everything).
  await go('#/team');
  const add = page.locator('.sidebar [data-cell="add"]');
  await add.waitFor({ timeout: 15_000 });
  await noHint();
  await add.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Start setup again' }).click();
  const ask = page.getByRole('dialog', { name: 'Start setup again?' });
  await ask.waitFor({ timeout: 5_000 });
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await ask.waitFor({ state: 'hidden', timeout: 5_000 });
  assert.deepEqual(await onboarding(), { completed: true, step: 'done' }, 'Cancel changes nothing');
  // Settings › General › Getting started: "Run setup again" is the same confirmed flow; it brings the assistant back on Home.
  await go('#/settings/general');
  const group = page.locator('#settings-getting-started');
  await group.waitFor({ timeout: 10_000 });
  await noHint();
  await group.scrollIntoViewIfNeeded();
  await shot('lifecycle-03b-getting-started');
  await group.getByRole('button', { name: 'Run setup again' }).click();
  await ask.waitFor({ timeout: 5_000 });
  await ask.getByRole('button', { name: 'Start setup', exact: true }).click();
  await page.locator('.first-run-view').waitFor({ timeout: 20_000 });
  assert.match(await page.evaluate(() => location.hash), /^#\/(home)?$/, 'on Home');
  assert.equal(await step(), 'Step 1 of 4');
  assert.deepEqual(await onboarding(), { completed: false, step: 'profile' });
  await shot('lifecycle-04-again-light');

  // Phone width: the layer, no horizontal scroll.
  await size(420, 860);
  await page.waitForTimeout(800);
  await shot('lifecycle-05-phone');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll at phone width (${overflow}px)`);
  await size(1280, 820);

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
