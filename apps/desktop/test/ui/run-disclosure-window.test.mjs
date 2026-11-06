// Electron window check of the "Worked … · N steps" line ABOVE an agent answer (C5, D5) with the demo
// engine in an isolated profile:
//   * a plain answer (no tool call) gets no line;
//   * an answer whose run called tools gets one muted line "Worked <time> · N steps", collapsed,
//     between the byline and the body; N equals the run's journaled tool calls; a click opens the
//     run's compact step lines in place (one 24 px line per call, the tool name as its title,
//     Input/Output of an entry), a second click closes them;
//   * the same at phone width (420×860, the mobile shell): collapsed after the remount, fits the
//     width, no horizontal page scroll;
//   * live (D5): while a run hangs in a tool, the live block at the bottom of the chat shows its
//     steps without a click – the running one with a spinner instead of a result; Stop ends it;
//     B-075: the block, the line and the first list come from the run's row (meta.live, meta.ms/steps/lines), the
//     journaled items (tool names, Input/Output) replace the list on this PC once they are read;
//   * opened afresh after a reload (no cached run items) in a window shorter than the chat: the
//     lines load after the list stuck to its end and keep it there – the newest answer's actions
//     stay in view;
//   * screenshots light, dark and phone (also the live line); no renderer errors.
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
// before the run's items are loaded the line comes without the time (run-line.ts lineFromMeta)
const WORKED = /^Worked(?: \d+ (?:s|min|h(?: \d+ min)?))? · (\d+) steps?$/;

test('Run disclosure: "Worked … · N steps" above answers with tool calls, live steps while running', { timeout: 300_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-run-disclosure-'));
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
  const size = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 300); win.setSize(w, h); }, [width, height]);
  await size(1280, 820);
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Launch prep', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'org', `chat:${chat.id}`] });
  await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  await page.locator('.message-scroller').waitFor({ timeout: 15_000 });

  /** Sends as the person and waits for the manager's final answer. */
  const answer = async (body) => {
    const sent = await rpc.call('messages.send', { conversationId: chat.id, body });
    return rpc.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id
      && message.state === 'final' && message.seq > sent.seq, 60_000);
  };
  const inMessage = (id, selector) => page.locator(`[data-message-id="${id}"] ${selector}`);

  // A plain answer: no line.
  const plain = await answer('Hello there');
  await inMessage(plain.id, '.message-content').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000); // the line would have loaded by now
  assert.equal(await inMessage(plain.id, '.run-disclosure-toggle').count(), 0, 'no line for a plain answer');

  // An answer with tool calls: one collapsed line with the run's step count.
  const worked = await answer('Who is on the team and how is this PC set up? [[tool:agents.list {}]] [[tool:tasks.list {}]] [[tool:app.status {}]]');
  assert.ok(worked.runId, 'the answer names its run');
  const journaled = (await rpc.call('runs.items', { runId: worked.runId })).filter((item) => item.kind === 'tool_call');
  assert.ok(journaled.length >= 1, 'the run journaled its tool calls');
  const line = inMessage(worked.id, '.run-disclosure-toggle');
  await line.waitFor({ timeout: 15_000 });
  const text = ((await line.textContent()) ?? '').trim();
  const steps = Number(WORKED.exec(text)?.[1] ?? 0);
  assert.equal(steps, journaled.length, `"Worked … · N steps" counts the tool calls (${text})`);
  assert.equal(await line.getAttribute('aria-expanded'), 'false', 'collapsed by default');
  assert.equal(await inMessage(worked.id, '.run-items').count(), 0, 'no items while collapsed');
  const placement = await page.evaluate((id) => {
    const message = document.querySelector(`[data-message-id="${id}"]`);
    const disclosure = message?.querySelector('.run-disclosure');
    const content = message?.querySelector('.message-content');
    if (!disclosure || !content) return null;
    return { before: Boolean(disclosure.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING), above: disclosure.getBoundingClientRect().bottom <= content.getBoundingClientRect().top + 1 };
  }, worked.id);
  assert.deepEqual(placement, { before: true, above: true }, 'D5: the line sits above the answer body');
  await shot('run-disclosure-01-collapsed-light');

  await line.click();
  const list = inMessage(worked.id, '.run-disclosure .run-items');
  await list.waitFor({ timeout: 5_000 });
  await list.locator('.run-item.tool .run-item-head[title="agents.list"]').first().waitFor({ timeout: 10_000 }); // the journaled items are read
  assert.equal(await list.locator('.run-item.tool').count(), steps, 'one entry per tool call');
  const names = await list.locator('.run-item.tool .run-item-head').evaluateAll((heads) => heads.map((head) => head.getAttribute('title') ?? ''));
  assert.ok(names.includes('agents.list') && names.includes('app.status'), `tool names (${names.join(', ')})`);
  const heights = await list.locator('.run-item.tool .run-item-head').evaluateAll((heads) => heads.map((head) => head.getBoundingClientRect().height));
  assert.ok(heights.every((height) => height >= 22 && height <= 26), `compact step lines (${heights.join(', ')} px)`);
  await list.locator('.run-item.tool .run-item-head').first().click();
  const body = list.locator('.run-item-body').first();
  await body.waitFor({ timeout: 5_000 });
  assert.match((await body.textContent()) ?? '', /Input|Output/);
  await shot('run-disclosure-02-open-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('run-disclosure-03-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await line.click();
  await list.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await line.getAttribute('aria-expanded'), 'false', 'closes again');
  assert.equal(await inMessage(plain.id, '.run-disclosure-toggle').count(), 0, 'still nothing under the plain answer');

  // Phone width: the same line after the remount, collapsed, inside the width.
  await size(420, 860);
  await page.waitForTimeout(800);
  const phoneLine = inMessage(worked.id, '.run-disclosure-toggle');
  await phoneLine.waitFor({ timeout: 15_000 });
  await phoneLine.scrollIntoViewIfNeeded();
  assert.equal(await phoneLine.getAttribute('aria-expanded'), 'false');
  await phoneLine.click();
  await inMessage(worked.id, '.run-disclosure .run-items').waitFor({ timeout: 5_000 });
  await shot('run-disclosure-04-phone');
  assert.ok(await overflow() <= 1, `no horizontal page scroll at phone width (${await overflow()}px)`);
  const fits = await page.evaluate((id) => {
    const element = document.querySelector(`[data-message-id="${id}"] .run-disclosure`);
    return element ? element.getBoundingClientRect().right <= document.documentElement.clientWidth + 1 && element.scrollWidth <= element.clientWidth + 1 : false;
  }, worked.id);
  assert.ok(fits, 'the open run items fit the phone width');

  // Live (D5): the live block at the bottom shows the steps right away, the running one with a spinner.
  const asked = await rpc.call('messages.send', { conversationId: chat.id, body: 'Render the preview [[hang:render.preview {"file":"cut.mp4"}]]' });
  const streaming = await rpc.waitFor('message.created', (message) => message.conversationId === chat.id && message.authorId === manager.id
    && message.seq > asked.seq && message.state === 'streaming', 60_000);
  const liveMessage = page.locator(`[data-message-id="${streaming.id}"]`);
  await liveMessage.waitFor({ timeout: 15_000 });
  await liveMessage.scrollIntoViewIfNeeded();
  const liveLine = inMessage(streaming.id, '.working-update.live');
  await liveLine.waitFor({ timeout: 15_000 });
  assert.equal(await liveLine.getAttribute('aria-expanded'), null, 'the live line is no toggle: the steps show without a click');
  const liveList = inMessage(streaming.id, '.run-items.live-steps');
  await liveList.waitFor({ timeout: 15_000 });
  await liveList.locator('.run-item.tool.running').first().waitFor({ timeout: 15_000 });
  assert.ok(((await liveList.locator('.run-item.tool.running .run-item-target').first().textContent()) ?? '').trim().length > 0, 'the running step names what it does (a value of its row)');
  assert.equal(await liveList.locator('.run-item.tool.running .run-item-icon .spinner').count(), 1, 'the running tool shows a spinner, not a result');
  const atBottom = await page.evaluate((id) => {
    const blocks = [...document.querySelectorAll('.message-column > :is(.message, .status-line, .status-group, .task-message, .call-transcript)')];
    return blocks.at(-1)?.getAttribute('data-message-id') === id;
  }, streaming.id);
  assert.ok(atBottom, 'the live block is the last thing in the chat');
  await shot('run-disclosure-05-live-phone');
  const idle = waitForNew(rpc, 'agent.activity', ({ active }) => !active.some((entry) => entry.agentId === manager.id), 30_000);
  await rpc.call('messages.stop', { conversationId: chat.id });
  await idle;

  // Opened afresh (a reload drops the cached run items) in a window shorter than the chat: every
  // line arrives after MessageList stuck to the end and must keep the end in view.
  const last = await answer('One more look at the team [[tool:agents.list {}]] [[tool:app.status {}]]');
  await size(1280, 520);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60_000 });
  await inMessage(last.id, '.run-disclosure-toggle').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000); // the other lines near the screen load as well
  const end = await page.evaluate((id) => {
    const scroller = document.querySelector('.message-scroller');
    const actions = document.querySelector(`[data-message-id="${id}"] .message-actions`);
    if (!scroller || !actions) return null;
    return {
      overflows: scroller.scrollHeight > scroller.clientHeight + 1,
      gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      actionsBottom: actions.getBoundingClientRect().bottom,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      pill: document.querySelectorAll('.new-pill').length,
    };
  }, last.id);
  assert.ok(end, 'the list and the newest answer with its actions are rendered');
  assert.ok(end.overflows, 'the chat is longer than the window (else the check below proves nothing)');
  assert.ok(end.gap < 2, `still at the end after the lines loaded (${end.gap}px below the visible part)`);
  assert.ok(end.actionsBottom <= end.scrollerBottom + 1, `the newest answer's actions stay in view (${end.actionsBottom} > ${end.scrollerBottom})`);
  assert.equal(end.pill, 0, 'no "new" pill: nothing is hidden below');
  await shot('run-disclosure-06-reopened-end');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
