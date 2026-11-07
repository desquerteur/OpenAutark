// Electron window check of 21.10. 17:09 (chat without a generic Stop) with the demo engine in an
// isolated profile. The agent's turn hangs on a native tool ([[hang:bash …]]), so it keeps working:
//   * the composer sends, disabled without content – AF-012 (07.11.2026): while the agent works an empty field shows Stop in
//     Send's cell (its own check: composer-stop-window.test.mjs); its Plus menu greys nothing out (04.11.2026); no conversation toggle. A 1:1 preview
//     omits the sender and is named after the agent (B-050 K2: "<agent> · Release"). The live task link opens its detail;
//   * a normal message sent while the agent works goes out and reaches the running turn (journal note
//     'steered'), the turn is not interrupted;
//   * the Send button's right-click menu › "Send as important" sends the draft as 'important' at once and it is
//     steered too;
//   * the chat header's live line opens the working popover, whose last entry is "Stop all agent work": the turn ends,
//     the status line "Agent work stopped" offers Resume, nothing works so the composer shows no Stop; Resume removes the line;
//   * light, dark, 640×480 and phone width (no horizontal page scroll); no renderer errors.
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

test('Chat without Stop: compose, talk and steer while an agent works; the emergency stop and Resume', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-no-stop-'));
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
  // A failed resource names its URL (the console text alone does not).
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()}${message.location()?.url ? ` (${message.location().url})` : ''}`); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Release', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`, 'org', 'system'] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });
  const actions = page.locator('.composer .composer-actions');
  const field = page.locator('.composer-input');

  const previewReady = rpc.waitFor('message.updated', message => message.conversationId === chat.id && message.authorId === manager.id && message.state === 'final', 30_000);
  await rpc.call('messages.send', { conversationId: chat.id, body: 'Check the release notes' });
  const previewMessage = await previewReady;
  const preview = page.locator('.chat-row').filter({ has: page.locator('.row-title', { hasText: new RegExp(`^${manager.name} · Release$`) }) }).locator('.row-preview');
  await preview.filter({ hasText: /^Echo/ }).waitFor();
  assert.ok(!(await preview.textContent()).startsWith(`${manager.name}:`), 'single-chat previews omit the sender');

  // The agent works (a native tool that never ends by itself).
  const taskWorking = rpc.waitFor('agent.activity', (event) => event.active.some((run) => run.agentId === manager.id && run.conversationId === chat.id && run.taskId), 30_000);
  const task = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Ship the release [[hang:bash]]', assigneeKind: 'agent', assigneeId: manager.id });
  await taskWorking;
  await page.locator('.chat-header .chat-live').waitFor({ timeout: 15_000 });
  const taskLink = page.locator('.working-task', { hasText: task.title });
  await taskLink.waitFor();
  await taskLink.click();
  await page.locator('.tasks-detail').waitFor();
  await page.locator('.tasks-detail input').first().waitFor();
  await page.evaluate(id => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.working-task', { hasText: task.title }).waitFor();
  await shot('no-stop-00-task-link');
  const idle = rpc.waitFor('agent.activity', event => !event.active.some(run => run.agentId === manager.id), 15_000);
  await rpc.call('tasks.setStatus', { id: task.id, status: 'cancelled' });
  await idle;

  // Preserve the chat-steering regression separately: task work and a chat turn have different wake groups.
  const working = rpc.waitFor('agent.activity', event => event.active.some(run => run.agentId === manager.id && run.conversationId === chat.id && !run.taskId && run.runId !== previewMessage.runId), 30_000);
  await rpc.call('messages.send', { conversationId: chat.id, body: 'Ship it [[hang:bash {"command":"deploy --long"}]]' });
  const activity = await working;
  const runId = activity.active.find(run => run.agentId === manager.id).runId;

  // AF-012: an empty field while the agent works → Stop in Send's cell; no voice toggle.
  await actions.locator('[data-tour="run-stop"][aria-label="Stop"]').waitFor({ timeout: 15_000 }); // Stop while the agent works
  assert.equal(await actions.locator('.send-button[aria-label="Send"]').count(), 0);
  assert.equal(await actions.locator('[aria-label="Start conversation"]').count(), 0);
  // owner 04.11.2026: the Plus menu greys nothing out with an empty field (the levels then set the draft's level)
  await page.locator('.composer-plus').click();
  const plusMenu = page.getByRole('menu', { name: 'Add' });
  await plusMenu.waitFor({ timeout: 5_000 });
  assert.ok(await plusMenu.locator('[role^="menuitem"]').count() >= 5);
  assert.equal(await plusMenu.locator('[role^="menuitem"]:disabled').count(), 0, 'no entry is greyed out');
  await page.keyboard.press('Escape');
  await plusMenu.waitFor({ state: 'hidden', timeout: 5_000 });
  await page.locator('.working-message').waitFor();
  // B-047 D5: the live block shows its steps without a click.
  await page.locator('.working-message .run-items.live-steps').waitFor();
  await shot('no-stop-01-working-empty-light');

  // A draft enables Send; calls remain in the header.
  await field.fill('Also update the changelog');
  assert.equal(await actions.locator('.send-button[aria-label="Send"]').count(), 1);
  assert.equal(await actions.locator('.composer-talk').count(), 0, 'calls are controlled above the chat');
  assert.equal(await actions.locator('.send-button').isEnabled(), true);
  assert.equal(await actions.locator('[aria-label="Stop"]').count(), 0);
  await shot('no-stop-02-working-draft-light');

  // Sending while it works: the message goes out and reaches the running turn; nothing is interrupted.
  const sent = rpc.waitFor('message.created', (message) => message.conversationId === chat.id && message.body === 'Also update the changelog', 15_000);
  await field.press('Enter');
  const normal = await sent;
  assert.equal(normal.priority ?? 'normal', 'normal');
  const steered = async (count) => {
    for (let i = 0; i < 50; i++) {
      const items = await rpc.call('runs.items', { runId });
      if (items.filter((item) => item.kind === 'note' && item.data?.steered).length >= count) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  assert.ok(await steered(1), 'the normal message was folded into the running turn');
  assert.ok((await rpc.call('agents.list')).some((agent) => agent.id === manager.id && agent.status === 'working'), 'still working');

  // The Send button's right-click menu › Send as important → the draft goes out as important (steered at once).
  await field.fill('Use the staging server first');
  await page.locator('.composer .send-button').click({ button: 'right' });
  const sendMenu = page.locator('.menu[aria-label="Context menu"]');
  await sendMenu.waitFor({ timeout: 5_000 });
  await shot('no-stop-03-important-light');
  const urgentSent = rpc.waitFor('message.created', (message) => message.conversationId === chat.id && message.body === 'Use the staging server first', 15_000);
  await sendMenu.getByRole('menuitemcheckbox', { name: /Send as important/ }).click();
  assert.equal((await urgentSent).priority, 'important');
  assert.ok(await steered(2), 'the important message reached the running turn');

  // Dark and 640×480.
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('no-stop-04-working-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await size(640, 480);
  await page.waitForTimeout(600);
  assert.ok(await overflow() <= 1, `no horizontal page scroll at 640×480 (${await overflow()}px)`);
  await shot('no-stop-05-640x480');
  await size(1280, 820);
  await page.waitForTimeout(600);

  // The emergency stop: the last entry of the live line's working popover (B-048 E4.5).
  const stopped = rpc.waitFor('work.state', (state) => state.stopped === true, 15_000);
  await page.locator('.chat-header .chat-live').click();
  await page.locator('.working-popover[aria-label="Agent work"]').getByRole('button', { name: /Stop all agent work/ }).click();
  await stopped;
  const pill = page.locator('.status-host .status-note[data-notice="work-stop"]');
  await pill.waitFor({ timeout: 10_000 });
  assert.match((await pill.textContent()) ?? '', /Agent work stopped/);
  await page.waitForFunction(() => !document.querySelector('.chat-header .chat-live'), undefined, { timeout: 15_000 });
  assert.equal(await actions.locator('[aria-label="Stop"]').count(), 0, 'nothing works: no Stop in the composer');
  await shot('no-stop-06-stopped-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('no-stop-07-stopped-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Phone width: the status line fits; no horizontal scroll.
  await size(420, 860);
  await page.waitForTimeout(800);
  await page.locator('.mobile-shell .status-note[data-notice="work-stop"]').waitFor({ timeout: 5_000 });
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  await shot('no-stop-08-stopped-phone');
  await size(1280, 820);
  await page.waitForTimeout(800);

  // Resume.
  const resumed = rpc.waitFor('work.state', (state) => state.stopped === false, 15_000);
  await pill.getByRole('button', { name: 'Resume' }).click();
  await resumed;
  await pill.waitFor({ state: 'detached', timeout: 10_000 });
  await shot('no-stop-09-resumed-light');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
