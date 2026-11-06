// Electron window check of B-048 E4.5 (the chat header's working popover) with the demo engine in an
// isolated profile. Two agents of a group chat work on hanging tasks ([[hang:bash]]):
//   * the runtime's activity carries what each run runs on (model, modelName, effort, engine);
//   * the header's live line opens the popover OVER the content: header, title, live line, message
//     list and composer keep their boxes (open, row expanded, closed again);
//   * one row per working member: avatar, name, "model · effort" (exactly the activity's), the live
//     note and the task; a row expands to the run's live steps; "Stop all agent work" is the last entry;
//   * the live block's byline shows the same "model · effort";
//   * the name opens the agent's page (the popover closes);
//   * light, dark, 640×480 (the popover stays on screen, no horizontal page scroll) and phone width
//     (a bottom sheet on screen); no renderer errors.
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
/** The UI's effort words (src/ui/chat/live-text.ts EFFORT_LABEL). */
const EFFORT = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Max' };
const modelText = (run) => `${run.modelName}${run.effort ? ` · ${EFFORT[run.effort]}` : ''}`;
/** Exactly this text (a name may be a substring of another). */
const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

test('working popover: who works on which model, live steps on expand, over the content; byline model; agent page', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-working-popover-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const [win] = BrowserWindow.getAllWindows();
    win.setMinimumSize(320, 480);
    win.setSize(w, h);
  }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  /** The popover's box lies inside the window. */
  const onScreen = async (what) => {
    // below 720 px the popover is a bottom sheet: its slide-in (mobile.css wf-sheet-in) ends before it is measured
    await page.locator('.working-popover').evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const box = await page.locator('.working-popover').boundingBox();
    const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5,
      `the popover stays on screen ${what}: ${JSON.stringify({ box, view })}`);
  };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const ava = await rpc.call('agents.create', { name: 'Quill', role: 'Writer', managerId: manager.id });
  const chat = await rpc.call('chats.create', { title: 'Launch plan', agentIds: [manager.id, ava.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'tasks', `chat:${chat.id}`, 'org', 'system'] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });

  // Both agents work (native tools that never end by itself); the activity names what each runs on.
  const routed = (event, agentId) => event.active.find((run) => run.agentId === agentId && run.conversationId === chat.id && run.taskId && run.modelName && run.effort && run.engine && run.model);
  const bothRouted = rpc.waitFor('agent.activity', (event) => Boolean(routed(event, manager.id) && routed(event, ava.id)), 60_000);
  const managerTask = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Plan the launch [[hang:bash]]', assigneeKind: 'agent', assigneeId: manager.id });
  const avaTask = await rpc.call('tasks.create', { conversationId: chat.id, title: 'Draft the post [[hang:bash]]', assigneeKind: 'agent', assigneeId: ava.id });
  const activity = await bothRouted;
  const runOf = (agentId) => routed(activity, agentId);
  assert.equal(runOf(manager.id).taskId, managerTask.id);
  assert.equal(runOf(ava.id).taskId, avaTask.id);

  const live = page.locator('.chat-header .chat-live');
  await live.waitFor({ timeout: 15_000 });
  assert.equal(await live.evaluate((element) => element.tagName), 'BUTTON', 'the live line is a button');
  assert.equal(await live.getAttribute('aria-haspopup'), 'dialog');
  await page.locator('.working-message').nth(1).waitFor({ timeout: 15_000 });
  // Both hanging tools are running (each live note is its running step now), so the live line's text – one of the
  // measured boxes below – no longer changes while the popover opens.
  await page.waitForFunction(() => {
    const blocks = [...document.querySelectorAll('.working-message')];
    return blocks.length === 2 && blocks.every((block) => block.querySelector('.run-items.live-steps .run-item.tool.running'));
  }, undefined, { timeout: 15_000 });
  await shot('working-00-closed-light');

  // Opening lies over the content: nothing in the header or the chat moves.
  const fixed = ['.chat-header', '.chat-header .chat-title-button', '.chat-header .chat-live', '.message-scroller', '.composer'];
  const popover = page.locator('.working-popover');
  await expectStable(page, fixed, async () => { await live.click(); await popover.waitFor(); });
  assert.equal(await popover.getAttribute('role'), 'dialog');
  assert.equal(await popover.getAttribute('aria-label'), 'Agent work');
  assert.equal(await live.getAttribute('aria-expanded'), 'true');

  // One row per working member, in start order: name, model · effort, note, task.
  const rows = popover.locator('.working-row');
  await page.waitForFunction(() => document.querySelectorAll('.working-popover .working-row').length === 2, undefined, { timeout: 10_000 });
  for (const [agent, task] of [[manager, managerTask], [ava, avaTask]]) {
    const row = popover.locator(`.working-row[data-agent-id="${agent.id}"]`);
    assert.equal((await row.locator('.working-row-name').textContent())?.trim(), agent.name);
    assert.equal((await row.locator('.working-row-model').textContent())?.trim(), modelText(runOf(agent.id)), `${agent.name}: model · effort from the activity`);
    assert.ok(((await row.locator('.working-row-note').textContent()) ?? '').trim().length > 0, `${agent.name}: a live note`);
    assert.equal((await row.locator('.working-task > span:not(.icon)').textContent())?.trim(), task.title);
    assert.ok(await row.locator('.avatar').count() >= 1, `${agent.name}: an avatar`);
  }
  assert.equal(await rows.count(), 2);
  const stop = popover.getByRole('button', { name: /Stop all agent work/ });
  assert.equal(await stop.count(), 1, 'the emergency stop is the last entry');
  const last = await popover.evaluate((element) => [...element.querySelectorAll('button')].at(-1)?.textContent ?? '');
  assert.match(last, /Stop all agent work/);
  await shot('working-01-open-light');

  // The live block's byline names the same model · effort in its slot.
  for (const agent of [manager, ava]) {
    const block = page.locator('.working-message', { has: page.locator('.author-name', { hasText: exact(agent.name) }) });
    assert.equal((await block.locator('.working-model').textContent())?.trim(), modelText(runOf(agent.id)), `${agent.name}: byline model`);
  }

  // A row expands to the run's live steps (the hanging native tool), still over the content.
  const managerRow = popover.locator(`.working-row[data-agent-id="${manager.id}"]`);
  const toggle = managerRow.locator('button.working-row-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await expectStable(page, fixed, async () => {
    await toggle.click();
    await managerRow.locator('.working-row-detail .run-items.live-steps .run-item').first().waitFor({ timeout: 15_000 });
  });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await onScreen('with an open row');
  await shot('working-02-expanded-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('working-03-expanded-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Escape closes it; nothing moved.
  await expectStable(page, fixed, async () => { await page.keyboard.press('Escape'); await popover.waitFor({ state: 'detached' }); });
  assert.equal(await live.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('chat-live') ?? false), true, 'Escape gives focus back to the live line');

  // 640×480: on screen, no horizontal page scroll.
  await size(640, 480);
  await page.waitForTimeout(600);
  await page.locator('.chat-header .chat-live').click();
  await popover.waitFor();
  await onScreen('at 640×480');
  assert.ok(await overflow() <= 1, `no horizontal page scroll at 640×480 (${await overflow()}px)`);
  await shot('working-04-640x480');
  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'detached' });

  // Phone width: a bottom sheet on screen.
  await size(420, 860);
  await page.waitForTimeout(800);
  await page.locator('.chat-header .chat-live').click();
  await popover.waitFor();
  await page.waitForTimeout(300); // the sheet's slide-in
  await onScreen('at phone width');
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  await shot('working-05-phone');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('working-06-phone-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'detached' });
  await size(1280, 820);
  await page.waitForTimeout(800);

  // The name opens the agent's page; the popover closes.
  await page.locator('.chat-header .chat-live').click();
  await popover.waitFor();
  await popover.locator(`.working-row[data-agent-id="${ava.id}"] .working-row-name`).click();
  await page.waitForFunction((id) => location.hash === `#/team/${encodeURIComponent(id)}`, ava.id, { timeout: 10_000 });
  await popover.waitFor({ state: 'detached', timeout: 5_000 });
  await shot('working-07-agent-page');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
