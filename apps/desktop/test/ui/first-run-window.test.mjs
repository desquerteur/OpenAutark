// Electron window check of the setup assistant (AF-002: About you → AI → tools → first agent) with the demo engine in an
// isolated test profile:
//   * a new profile opens on Home's place (My day) with the assistant (.first-run-view) at About you ("Step 1 of 4",
//     the step names, one sentence on what it is for), the sidebar and the frame's header row where they always are;
//   * on that step "Connect to my other device" opens the Connect card (this PC's Remote ID with "only this network", the
//     "Connect a PC" row of Settings › Devices) without writing a step; the frame does not move; Back returns to the step;
//   * About you: language, name and company (typing moves nothing); Continue saves them and leads to the AI step;
//   * the AI card is the model setup (settings/ModelSetup.tsx): the rows Claude Code and Codex, the four fixed buttons
//     Claude plan · Codex plan · API key · Local server, the reserved "Open sign-in page" cell and one status line;
//     the scan only fills the rows (nothing moves); API key opens its form inline under the buttons (they stay);
//   * the plan flow on fake runtime answers in the renderer (the demo runtime never installs or signs in for real:
//     the runtime port answers accounts.detect with both CLIs missing and holds accounts.install / add until
//     the test releases them): Codex plan runs install → "Finish signing in in your browser…" → "Open sign-in page"
//     in its reserved cell → the account event → "Codex account signed in"; clicking again adds another account;
//     no accounts.try or accounts.login call is sent, even with an existing account. A failed
//     Claude Code install says why in the same line; busy shows on the pressed button only; nothing moves; the flow
//     survives the remount across the phone layout; Continue is disabled while no model can answer, and "Skip for now"
//     asks first (Cancel stays);
//   * Connect your tools (the rows of Settings › Apps) is skipped; Your first agent shows the Manager; Start creates
//     nobody, completes the onboarding and opens the Manager's chat with the app's start text as the person's own line
//     (once, before the Manager's answer) – and the spotlight tour starts (spotlight-tour-window.test.mjs covers it; Skip
//     here);
//   * My day after the first run while no model can answer: the status line says so with Connect → Settings › Models,
//     which shows the same four buttons; the line goes as soon as a model can answer;
//   * screenshots light, dark, 640×480 and phone width; no horizontal scroll; no renderer errors.
// Run: npm run test:ui   (needs a fresh build)   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

/**
 * Page init script (before the app captures the port built-ins, lib/runtime-port.ts): while window.__planFake.on,
 * the plan flow's runtime calls never reach the runtime – accounts.detect answers "Codex and Claude Code not
 * installed" at once (installed lists the CLIs added later), accounts.install / add / login / try wait until the test releases them (planFake.held),
 * planFake.event pushes a runtime event; while planFake.empty, accounts.list and models.list answer empty lists (a PC
 * where nothing can answer yet).
 */
const PLAN_FAKE = `(() => {
  const post = MessagePort.prototype.postMessage;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const FAKED = new Set(['accounts.detect', 'accounts.install', 'accounts.add', 'accounts.login', 'accounts.try']);
  const fake = { on: false, empty: false, accounts: null, installed: [], calls: [], held: {}, port: null }; // accounts: what accounts.list answers (the signed-in plans)
  const deliver = (port, data) => dispatch.call(port, new MessageEvent('message', { data }));
  fake.event = (event, data) => deliver(fake.port, { event, data });
  Object.defineProperty(window, '__planFake', { value: fake });
  MessagePort.prototype.postMessage = function (frame, ...rest) {
    const method = frame && typeof frame === 'object' ? frame.method : undefined;
    const empty = fake.empty && (method === 'accounts.list' || method === 'models.list');
    const listed = method === 'accounts.list' && fake.accounts;
    if (!fake.on || !(FAKED.has(method) || empty || listed)) return post.call(this, frame, ...rest);
    const port = this;
    fake.port = port;
    fake.calls.push(frame.method);
    const answer = (reply) => setTimeout(() => deliver(port, { id: frame.id, ...reply }), 0);
    if (listed) answer({ result: fake.accounts });
    else if (empty) answer({ result: [] });
    else if (frame.method === 'accounts.detect') answer({ result: { clis: ['codex', 'claude'].map((provider) => ({ provider, ...(fake.installed.includes(provider) ? { path: provider + '.exe' } : {}) })), localServers: [], envKeys: [], checkedAt: Date.now() } });
    else fake.held[frame.method] = answer;
  };
})();`;

test('first run: tour → AI (model setup, plan flow) → About you → the start text and the Manager answers', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-first-run-'));
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
  await page.addInitScript(PLAN_FAKE); // off until the plan flow's part
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const noScroll = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal page scroll at ${label} (${overflow}px)`);
  };

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const settings = () => rpc.call('settings.get');
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager' && !agent.archivedAt);
  assert.ok(manager, 'a fresh profile has the seed Manager');
  const first = await settings();
  assert.deepEqual([first.onboarding.completed, first.onboarding.step, first.onboarding.tour], [false, 'profile', 'new'], 'About you first, the tour not shown yet');
  const agentsBefore = (await rpc.call('agents.list')).filter((agent) => !agent.archivedAt).length;

  // The layer in Home's place, inside the frame.
  const layer = page.locator('.first-run-view');
  await layer.waitFor({ timeout: 20_000 });
  assert.ok(await page.locator('.sidebar').isVisible(), 'the frame stays');
  const profileCard = layer.locator('.first-run-card[data-card="first-run-profile"]');
  await profileCard.waitFor({ timeout: 10_000 });
  assert.equal((await layer.locator('.first-run-step').textContent())?.trim(), 'Step 1 of 4');
  assert.deepEqual(await layer.locator('.first-run-step-name').allTextContents(), ['About you', 'Connect an AI', 'Connect your tools', 'Your first agent']);
  assert.match(await profileCard.locator('.first-run-purpose').textContent(), /^Your agents speak with you in this language/);

  // "Connect to my other device" on the first step: the Connect card in the cards' column; Back returns to the step.
  const connectButton = profileCard.getByRole('button', { name: 'Connect to my other device' });
  assert.ok(await connectButton.isVisible(), 'the text button in the first step\'s action row');
  const connectCard = page.locator('.first-run-card[data-card="first-run-connect"]');
  await expectStable(page, ['.first-run-view > .frame-header', '.sidebar'], async () => {
    await connectButton.click();
    await connectCard.waitFor({ timeout: 10_000 });
  });
  await connectCard.locator('.remote-id', { hasText: /^\d{3} \d{3} \d{3}$/ }).waitFor({ timeout: 15_000 });
  await connectCard.locator('.set-row-hint', { hasText: 'only this network (meeting server off)' }).waitFor({ timeout: 10_000 });
  assert.equal(await connectCard.locator('.remote-connect-row').getByRole('textbox', { name: 'Remote ID or address of the other PC' }).count(), 1);
  assert.equal(await connectCard.getByRole('button', { name: 'Copy' }).count(), 1);
  assert.equal((await settings()).onboarding.step, 'profile', 'opening the card writes no step');
  await shot('first-run-00a-connect-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-00b-connect-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, label] of [[640, 480, '640x480'], [420, 860, 'phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    await connectCard.waitFor({ timeout: 5_000 }); // the card stays open across the phone layout
    await shot(`first-run-00c-connect-${label}`);
    await noScroll(`connect ${label}`);
  }
  await size(1280, 820);
  await page.waitForTimeout(400);
  await connectCard.getByRole('button', { name: 'Back' }).click();
  await profileCard.waitFor({ timeout: 10_000 });

  // About you: language, name and company; typing moves nothing; Continue saves them.
  await expectStable(page, ['.first-run-card', '.first-run-actions'], async () => {
    await profileCard.getByLabel('Your name').fill('Test Person');
    await profileCard.getByLabel('Company').fill('Test GmbH');
  });
  assert.equal(await profileCard.locator('textarea').count(), 0, 'no first-request field');
  await shot('first-run-00d-profile-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-00e-profile-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, label] of [[640, 480, '640x480'], [420, 860, 'phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    await shot(`first-run-00f-profile-${label}`);
    await noScroll(`profile ${label}`);
  }
  await size(1280, 820);
  await page.waitForTimeout(400);
  await profileCard.getByRole('button', { name: 'Continue' }).click();
  await layer.locator('.first-run-card[data-card="first-run-ai"]').waitFor({ timeout: 10_000 });
  assert.equal((await settings()).onboarding.step, 'ai');
  assert.deepEqual([(await settings()).profile.name, (await settings()).profile.company], ['Test Person', 'Test GmbH'], 'saved on Continue');
  assert.equal((await page.locator('.first-run-step').textContent())?.trim(), 'Step 2 of 4');

  // AI card: the model setup – rows, the four buttons, the reserved link cell and the status line; the scan fills the
  // rows without moving anything.
  const ai = page.locator('.first-run-card[data-card="first-run-ai"]');
  await ai.waitFor({ timeout: 15_000 });
  const frame = ['.first-run-card', '.first-run-card .model-setup-buttons', '.first-run-card .model-setup-status', '.first-run-actions'];
  await expectStable(page, frame, async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('.first-run-card .cli-row .set-row-hint')].every((hint) => hint.textContent !== 'Looking…'), undefined, { timeout: 60_000 });
  });
  for (const label of ['Claude Code', 'Codex']) assert.equal(await ai.locator('.cli-row .set-row-label', { hasText: label }).count(), 1, label);
  const buttons = ai.locator('.model-setup-buttons');
  for (const label of ['Claude plan', 'Codex plan', 'API key', 'Local server']) assert.equal(await buttons.getByRole('button', { name: label, exact: true }).count(), 1, label);
  assert.equal(await buttons.locator('.first-run-link.inert').count(), 1, 'the link cell is reserved before any sign-in');
  const continueButton = ai.getByRole('button', { name: 'Continue' });
  await ai.locator('.first-run-actions button.primary:enabled').waitFor({ timeout: 10_000 }); // the demo model answers
  await shot('first-run-01-ai-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-02-ai-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // API key opens its form inline under the buttons; the buttons stay where they are; a second press closes it.
  const apiKey = buttons.getByRole('button', { name: 'API key', exact: true });
  const buttonFrame = ['.first-run-card .model-setup-buttons', '.first-run-card .model-setup-plan', '.first-run-card .model-setup-status'];
  await expectStable(page, buttonFrame, async () => { await apiKey.click(); await page.waitForTimeout(200); });
  assert.equal(await apiKey.getAttribute('aria-pressed'), 'true');
  await shot('first-run-03-api-key-form');
  await expectStable(page, buttonFrame, async () => { await apiKey.click(); await page.waitForTimeout(200); });
  assert.equal(await apiKey.getAttribute('aria-pressed'), 'false');

  // From here the plan flow's runtime calls get fake answers in the page – and the next scan finds both CLIs missing
  // and nothing that can answer (planFake.empty, until the plan signs in). Crossing the phone layout mounts the
  // card again, which scans again.
  await page.evaluate(() => { window.__planFake.on = true; window.__planFake.empty = true; });
  await size(420, 860);
  await page.waitForTimeout(600);
  await size(1280, 820);
  await page.waitForFunction(() => window.__planFake.calls.includes('accounts.detect'), undefined, { timeout: 10_000 });
  await page.waitForTimeout(800); // the scan's account list and models are in
  await ai.locator('.first-run-actions button.primary:disabled').waitFor({ timeout: 5_000 }); // nothing can answer: Continue waits
  assert.equal(await continueButton.isDisabled(), true, 'one usable provider is needed');
  // AF-002: skipping the AI is possible only on purpose – one confirm; Cancel stays on the step.
  await ai.getByRole('button', { name: 'Skip for now' }).click();
  const skipAsk = page.getByRole('dialog', { name: 'Go on without an AI?' });
  await skipAsk.waitFor({ timeout: 5_000 });
  await shot('first-run-03-skip-ai-confirm');
  await skipAsk.getByRole('button', { name: 'Cancel', exact: true }).click();
  await skipAsk.waitFor({ state: 'hidden', timeout: 5_000 });
  assert.equal((await settings()).onboarding.step, 'ai', 'Cancel keeps the AI step');
  await shot('first-run-03-no-model-light');
  const release = (method, reply) => page.evaluate(([m, r]) => { const answer = window.__planFake.held[m]; delete window.__planFake.held[m]; answer(r); }, [method, reply]);
  const pushEvent = (event, data) => page.evaluate(([e, d]) => window.__planFake.event(e, d), [event, data]);
  const detects = () => page.evaluate(() => window.__planFake.calls.filter((method) => method === 'accounts.detect').length);
  const waitHeld = (method) => page.waitForFunction((m) => Boolean(window.__planFake.held[m]), method, { timeout: 10_000 });
  const status = ai.locator('.model-setup-status');
  const waitStatus = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('.first-run-card .model-setup-status')?.textContent ?? ''), pattern.source, { timeout: 10_000 });
  const plansFrame = [...frame, '.first-run-card .model-setup-plan', '.first-run-card .model-setup-plan + .model-setup-plan', '.first-run-card .model-setup-buttons .first-run-link', '.first-run-actions button.primary'];
  const codex = buttons.locator('button.model-setup-plan', { hasText: 'Codex plan' });
  const claude = buttons.locator('button.model-setup-plan', { hasText: 'Claude plan' });
  await expectStable(page, plansFrame, async () => { await codex.click(); await waitStatus(/^Installing Codex – this takes about a minute…$/); });
  assert.equal(await codex.getAttribute('aria-busy'), 'true', 'busy on the pressed button');
  assert.equal(await claude.getAttribute('aria-busy'), null, 'and on that one only');
  await shot('first-run-04a-plan-installing');
  await waitHeld('accounts.install');
  await expectStable(page, plansFrame, async () => { await release('accounts.install', { result: { ok: true } }); await waitHeld('accounts.add'); await waitStatus(/^Finish signing in in your browser…$/); });
  assert.equal(await ai.locator('button.first-run-link').count(), 0, 'no page yet: the inert placeholder holds the cell');
  const fakeAccount = { id: 'acc_fake_codex', provider: 'codex', label: 'Codex', auth: 'cli', state: 'needs_login', priority: 0, rotation: false, enabled: true, detected: false, createdAt: Date.now() };
  await expectStable(page, plansFrame, async () => {
    await release('accounts.add', { result: { ...fakeAccount, signInUrl: 'https://auth.openai.com/oauth/authorize?test=1' } });
    await ai.locator('button.first-run-link').waitFor({ timeout: 5_000 });
  });
  assert.ok(await ai.getByRole('button', { name: 'Open sign-in page' }).isVisible(), 'the page the sign-in printed is offered');
  await shot('first-run-04b-plan-sign-in-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-04c-plan-sign-in-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  // the window crossing the phone layout mounts the card again: the sign-in being finished stays (line, link, busy)
  await size(420, 860);
  await page.waitForTimeout(500);
  await ai.locator('button.first-run-link').waitFor({ timeout: 5_000 });
  assert.equal(await status.textContent(), 'Finish signing in in your browser…', 'the flow survives the remount');
  await shot('first-run-04c-plan-sign-in-phone');
  await noScroll('plan sign-in phone');
  await size(1280, 820);
  await page.waitForTimeout(500);
  await ai.locator('button.first-run-link').waitFor({ timeout: 5_000 });
  assert.equal(await codex.getAttribute('aria-busy'), 'true', 'still busy after the remount');
  // the sign-in finished in the browser: the Codex row becomes its account row (with the plan's two limit bars – the
  // rows above the buttons grow by them once; the buttons, the link cell and the line keep their order)
  const scansBefore = await detects();
  // The finished flow scans again; the fake lists must already contain the signed-in account.
  await page.evaluate((account) => { window.__planFake.empty = false; window.__planFake.accounts = [account]; window.__planFake.installed = ['codex']; }, { ...fakeAccount, state: 'ok' });
  await pushEvent('account.upserted', { ...fakeAccount, state: 'ok' });
  await waitStatus(/^Codex account signed in$/);
  await ai.locator('.account-row.plan.provider-codex .account-limits').waitFor({ timeout: 5_000 });
  assert.equal(await ai.locator('.cli-row', { hasText: 'Codex' }).count(), 0, 'the Codex CLI row gave way to the account row');
  assert.ok(await ai.locator('.model-setup-status.ok').isVisible(), 'the success line is green');
  await page.waitForFunction((count) => window.__planFake.calls.filter((method) => method === 'accounts.detect').length > count, scansBefore, { timeout: 10_000 }); // the finished flow scanned again
  await ai.locator('.first-run-actions button.primary:enabled').waitFor({ timeout: 10_000 }); // a model can answer again
  await page.waitForTimeout(500);
  await shot('first-run-04d-plan-works-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-04e-plan-works-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, label] of [[640, 480, '640x480'], [420, 860, 'phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    await shot(`first-run-04f-plan-works-${label}`);
    await noScroll(`plan ${label}`);
    assert.equal(await status.textContent(), 'Codex account signed in', `the line stays at ${label}`);
  }
  await size(1280, 820);
  await page.waitForTimeout(300);
  // A second click with a working account must start another account's sign-in, with no answer test or re-login.
  await expectStable(page, plansFrame, async () => { await codex.click(); await waitHeld('accounts.add'); await waitStatus(/^Finish signing in in your browser…$/); });
  assert.deepEqual(await page.evaluate(() => window.__planFake.calls.filter((method) => method === 'accounts.try' || method === 'accounts.login')), []);
  const secondAccount = { ...fakeAccount, id: 'acc_fake_codex_2', label: 'Codex 2' };
  await release('accounts.add', { result: { ...secondAccount, signInUrl: 'https://auth.openai.com/oauth/authorize?test=2' } });
  await ai.locator('button.first-run-link').waitFor({ timeout: 5_000 });
  await pushEvent('account.upserted', { ...fakeAccount, state: 'ok' });
  assert.equal(await status.textContent(), 'Finish signing in in your browser…', 'the existing account cannot finish the new sign-in');
  await page.evaluate((list) => { window.__planFake.accounts = list; }, [{ ...fakeAccount, state: 'ok' }, { ...secondAccount, state: 'ok' }]);
  await pushEvent('account.upserted', { ...secondAccount, state: 'ok' });
  await waitStatus(/^Codex account signed in$/);
  assert.equal(await ai.locator('.account-row.plan.provider-codex').count(), 2, 'both accounts remain connected');
  assert.deepEqual(await page.evaluate(() => window.__planFake.calls.filter((method) => method === 'accounts.try' || method === 'accounts.login')), [], 'neither sign-in sent a model turn or replaced an account');
  // Claude plan: a failed install says why in the same line, red; nothing moves.
  await expectStable(page, plansFrame, async () => { await claude.click(); await waitStatus(/^Installing Claude Code – this takes about a minute…$/); });
  await waitHeld('accounts.install');
  const scansFailed = await detects();
  await expectStable(page, plansFrame, async () => {
    await release('accounts.install', { error: { code: 'unavailable', message: 'Could not install Claude Code. Check your connection and try again.' } });
    await waitStatus(/^Could not install Claude Code\. Check your connection and try again\.$/);
  });
  assert.ok(await ai.locator('.model-setup-status.error').isVisible(), 'the reason is red');
  assert.equal(await claude.getAttribute('aria-busy'), null, 'the flow ended');
  await shot('first-run-04g-plan-install-failed-light');
  const cardHeight = () => page.evaluate(() => document.querySelector('.first-run-card')?.getBoundingClientRect().height);
  const aiHeight = await cardHeight();
  await page.waitForFunction((count) => window.__planFake.calls.filter((method) => method === 'accounts.detect').length > count, scansFailed, { timeout: 10_000 });
  await page.evaluate(() => { window.__planFake.on = false; });
  await page.waitForTimeout(300);

  // Continue → Connect your tools (the rows of Settings › Apps) → Skip → Your first agent.
  await continueButton.click();
  const tools = page.locator('.first-run-card[data-card="first-run-connectors"]');
  await tools.waitFor({ timeout: 15_000 });
  assert.equal((await settings()).onboarding.step, 'connectors');
  assert.equal((await page.locator('.first-run-step').textContent())?.trim(), 'Step 3 of 4');
  await tools.locator('#settings-apps').waitFor({ timeout: 10_000 });
  await shot('first-run-05-tools-light');
  await tools.getByRole('button', { name: 'Skip', exact: true }).click();
  const about = page.locator('.first-run-card[data-card="first-run-agent"]');
  await about.waitFor({ timeout: 15_000 });
  assert.equal((await settings()).onboarding.step, 'agent');
  assert.equal((await page.locator('.first-run-step').textContent())?.trim(), 'Step 4 of 4');
  assert.match(await about.locator('.first-run-agent.lead .first-run-agent-name').textContent(), /^Manager/, 'the Manager is introduced');
  t.diagnostic(`card heights: AI ${aiHeight}px, first agent ${await cardHeight()}px`);
  await shot('first-run-06-agent-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-06-agent-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  for (const [width, height, label] of [[640, 480, '640x480'], [420, 860, 'phone']]) {
    await size(width, height);
    await page.waitForTimeout(500);
    await shot(`first-run-07-agent-${label}`);
    await noScroll(label);
  }
  await size(1280, 820);
  await page.waitForTimeout(400);

  // Start: the profile is saved, nobody is created, the Manager's chat opens with the start text and it answers; the
  // spotlight tour starts (Skip here – spotlight-tour-window.test.mjs goes through it).
  await about.getByRole('button', { name: 'Start' }).click();
  await page.locator('dialog.spotlight[data-step="welcome"]').waitFor({ timeout: 20_000 });
  await page.locator('dialog.spotlight .spotlight-skip').click();
  await page.locator('dialog.spotlight').waitFor({ state: 'detached', timeout: 10_000 });
  // After a skipped tour each area shows a first-visit hint once (spotlight-tour-window.test.mjs checks them): here they
  // count as shown, so the checks below meet no hint.
  await rpc.call('settings.update', { onboarding: { hints: ['day', 'tasks', 'chats', 'chat', 'team', 'settings', 'apps', 'skills', 'secrets', 'devices', 'pane'] } });
  await page.waitForFunction(() => location.hash.startsWith('#/chat/'), undefined, { timeout: 20_000 });
  const chatId = await page.evaluate(() => decodeURIComponent(location.hash.slice('#/chat/'.length)));
  const done = await settings();
  assert.deepEqual([done.profile.name, done.profile.company], ['Test Person', 'Test GmbH']);
  assert.deepEqual([done.onboarding.completed, done.onboarding.step, done.onboarding.tour], [true, 'done', 'skipped']);
  assert.equal((await rpc.call('agents.list')).filter((agent) => !agent.archivedAt).length, agentsBefore, 'only the Manager: nobody was created');
  await page.locator('article.message.agent').first().waitFor({ timeout: 90_000 }); // the Manager's turn
  const messages = await rpc.call('messages.list', { conversationId: chatId, limit: 20 });
  const own = messages.filter((message) => message.authorKind === 'human');
  assert.equal(own.length, 1, "the start text is the person's own line, once");
  assert.match(own[0].body, /^Automatic message from the app, not typed by me: I just installed Autark, entered Test Person and Test GmbH and clicked Start\. .*my personal manager/);
  const answer = messages.find((message) => message.authorId === manager.id);
  assert.ok(answer, 'the Manager answered');
  assert.ok(own[0].createdAt <= answer.createdAt, 'the start text came before the answer');
  await shot('first-run-08-manager-chat-light');

  // My day (Home) after the first run while no model can answer – the status line says so with Connect (the signals
  // are emptied by pushed runtime events and refilled after); Connect leads to Settings › Models.
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.locator('.day-view').waitFor({ timeout: 10_000 });
  const demoAccounts = await rpc.call('accounts.list');
  const demoModels = await rpc.call('models.list');
  await page.evaluate(([list]) => { for (const account of list) window.__planFake.event('account.removed', { id: account.id }); window.__planFake.event('models.updated', []); }, [[...demoAccounts, fakeAccount, secondAccount]]); // the faked plans too
  const band = page.locator('[data-notice="no-ai"]');
  await band.waitFor({ timeout: 5_000 });
  assert.match(await band.textContent(), /No AI is connected yet – your team can't start\./);
  await shot('first-run-09-home-no-ai-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('first-run-10-home-no-ai-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await band.getByRole('button', { name: 'Connect' }).click();
  await page.waitForFunction(() => location.hash === '#/settings/models', undefined, { timeout: 5_000 });
  const modelsGroup = page.locator('#settings-models');
  await modelsGroup.waitFor({ timeout: 10_000 });
  for (const label of ['Claude plan', 'Codex plan', 'API key', 'Local server']) {
    assert.equal(await modelsGroup.locator('.model-setup-buttons').getByRole('button', { name: label, exact: true }).count(), 1, `Settings › Models: ${label}`);
  }
  await shot('first-run-11-settings-models');
  await page.evaluate(([list, all]) => { for (const account of list) window.__planFake.event('account.upserted', account); window.__planFake.event('models.updated', all); }, [demoAccounts, demoModels]);
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.locator('.day-view').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-notice="no-ai"]').count(), 0, 'gone as soon as a model can answer');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
