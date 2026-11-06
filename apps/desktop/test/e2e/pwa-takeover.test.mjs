// X02 end to end: a paired phone (390 × 844, touch, loopback = a secure transport; one tier) takes over
// an agent's own browser from its sign-in to-do. The demo engine runs (agents may do everything)
// browser.open on a local test page and human.ask with a confirm widget; the phone opens For you →
// the to-do → Open browser; the picture arrives through browser.pull (never a pushed
// subscription); a tap on the page's button reaches the test server; Type plus text reaches the
// focused field; Hand back ends the takeover and wakes the agent; the typed text is in neither the
// runtime log nor the run journal. Light and dark screenshots land in test-results/<date>-pwa.
// Uses an installed Chrome or Edge (playwright-core channel detection) for the phone and for the
// agent's off-screen browser, and skips with a message when neither exists – it never downloads one.
// Owns: this flow. Never: prints the pairing secret or the device token, touches real data.
// Run: npm run build && node --test test/e2e/pwa-takeover.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { detectChannel } from '../../src/runtime/browser/channel.ts';
import { startRuntime } from './lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'test-results', `${new Date().toISOString().slice(0, 10)}-pwa`);
const channel = process.env.WORKFORCE_PWA_CHANNEL || (() => { try { return detectChannel(); } catch { return undefined; } })();
/** What the person types on the phone: letters that never occur in ids or hex. */
const TYPED = 'abcqz';

/** A sign-in page: the top half is a button, the bottom half a field; both report to this server. */
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>WF Takeover Check</title>
<body style="margin:0">
<button id="go" style="position:fixed;left:0;top:0;width:100vw;height:50vh;font-size:40px" onclick="fetch('/clicked')">Press</button>
<input id="name" aria-label="Name" style="position:fixed;left:0;top:50vh;width:100vw;height:50vh;font-size:40px;box-sizing:border-box" oninput="fetch('/typed?v=' + encodeURIComponent(this.value))">
</body>`;

/** Records which methods the page calls and which answers are 'forbidden' (methods only, never frames). */
const SOCKET_TAP = `(() => {
  const Native = window.WebSocket;
  const log = { sent: {}, forbidden: [] };
  Object.defineProperty(window, '__wfSocketLog', { value: log });
  class Tapped extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      const methods = new Map();
      const send = this.send.bind(this);
      this.send = (data) => {
        try { const frame = JSON.parse(data); if (frame && typeof frame.method === 'string') { methods.set(frame.id, frame.method); log.sent[frame.method] = (log.sent[frame.method] || 0) + 1; } } catch {}
        return send(data);
      };
      this.addEventListener('message', (event) => {
        try { const frame = JSON.parse(event.data); if (frame && frame.error && frame.error.code === 'forbidden') log.forbidden.push(methods.get(frame.id) || 'unknown'); } catch {}
      });
    }
  }
  window.WebSocket = Tapped;
})();`;

async function until(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

test('X02: a To-do-only phone takes over the agent browser from its to-do, taps, types and hands back', {
  timeout: 300_000,
  skip: channel ? false : 'No installed Google Chrome or Microsoft Edge was found – this test uses an installed browser and never downloads one.',
}, async (t) => {
  await mkdir(shots, { recursive: true });
  const hits = { clicked: 0, typed: [] };
  const site = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/clicked') hits.clicked++;
    if (url.pathname === '/typed') hits.typed.push(url.searchParams.get('v') ?? '');
    res.writeHead(200, { 'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(url.pathname === '/' ? PAGE : 'ok');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${site.address().port}/`;
  const dataDir = await mkdtemp(path.join(shots, 'runtime-'));
  const runtime = await startRuntime({ dataDir, keepData: true });
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    site.closeAllConnections();
    site.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  t.diagnostic(`browser channel: ${channel}; screenshots: ${shots}`);

  // ---------------------------------------------------------------- the agent asks for a sign-in
  const owner = runtime.client;
  await owner.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const manager = (await owner.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await owner.call('chats.create', { title: 'Shop sign-in', agentIds: [manager.id] });
  await owner.call('chats.update', { id: chat.id, settings: { mode: 'browser' } });
  await owner.call('events.subscribe', { topics: [`chat:${chat.id}`, 'tasks'] });
  const widget = { type: 'confirm', instructions: 'Press the button, type your name, then hand back.', url: pageUrl, confirmLabel: 'Done' };
  await owner.call('messages.send', {
    conversationId: chat.id,
    body: `Sign in please [[tool:browser.open {"url":"${pageUrl}"}]] [[tool:human.ask ${JSON.stringify({ title: 'Sign in to the test shop', reason: 'credential', widget })}]]`,
  });
  const todo = await until(async () => (await owner.call('todos.list')).find((task) => task.widget?.type === 'confirm' && task.createdBy === manager.id), 'the confirm to-do', 120_000);
  assert.ok((await owner.call('browser.list')).some((entry) => entry.agentId === manager.id), 'the agent browser is open');

  // ---------------------------------------------------------------- the phone takes it over
  const link = await owner.call('pwa.link', { name: 'Phone' });
  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  await context.addInitScript(SOCKET_TAP);
  const phone = await context.newPage();
  const errors = [];
  phone.on('pageerror', (error) => errors.push(error.message));
  phone.on('console', (message) => { if (message.type() === 'error' && !/^Banner not shown/.test(message.text())) errors.push(message.text()); });
  await phone.goto(`http://localhost:${runtime.port}/${new URL(link.url).hash}`); // localhost: a secure context, as over adb reverse
  const item = phone.locator(`.mobile-shell .todo-item[data-task-id="${todo.id}"]`);
  await item.waitFor({ timeout: 60_000 });
  await item.locator('.todo-open').tap();
  await item.getByRole('button', { name: 'Open browser' }).tap({ timeout: 30_000 });
  const picture = item.locator('.browser-touch img');
  await picture.waitFor({ timeout: 60_000 });
  const log = await phone.evaluate(() => window.__wfSocketLog);
  assert.ok((log.sent['browser.pull'] ?? 0) > 0, 'the picture comes through browser.pull');
  assert.equal(log.sent['browser.subscribe'], undefined, 'no pushed subscription from a phone');
  assert.ok((await owner.call('browser.list')).length > 0);

  // A tap on the button's half of the picture is a click on the page.
  const box = await picture.boundingBox();
  await picture.tap({ position: { x: box.width / 2, y: box.height * 0.25 } });
  await until(() => hits.clicked > 0, 'the tap to reach the page');
  // Focus the field with a tap, then Type opens the hidden key field.
  await picture.tap({ position: { x: box.width / 2, y: box.height * 0.75 } });
  await delay(500);
  await item.getByRole('button', { name: 'Type' }).tap();
  await phone.keyboard.type(TYPED, { delay: 60 });
  await until(() => hits.typed.includes(TYPED), 'the typed text to reach the focused field');
  await item.locator('[role="status"]', { hasText: 'tap to click, drag to scroll' }).waitFor({ timeout: 10_000 });
  for (const scheme of ['light', 'dark']) {
    await phone.emulateMedia({ colorScheme: scheme });
    await delay(400);
    await phone.screenshot({ path: path.join(shots, `08-takeover-${scheme}.png`) });
  }
  await phone.emulateMedia({ colorScheme: 'light' });

  // ---------------------------------------------------------------- hand back wakes the agent
  const before = Date.now();
  await item.getByRole('button', { name: 'Hand back' }).tap();
  await until(async () => !(await owner.call('browser.pull', { agentId: manager.id, waitMs: 1000 })).state.takeover, 'the takeover to end');
  await until(async () => (await owner.call('agents.runs', { id: manager.id, limit: 5 })).some((run) => run.startedAt >= before - 1000), 'the agent to be woken', 90_000);
  assert.deepEqual([...new Set((await phone.evaluate(() => window.__wfSocketLog.forbidden)))], [], 'no call refused on the phone');
  assert.deepEqual(errors, [], 'no page or console errors');

  // ---------------------------------------------------------------- the typed text stays out of logs and the journal
  const logs = path.join(runtime.dataDir, 'logs');
  const files = (await readdir(logs).catch(() => [])).filter((name) => name.endsWith('.log'));
  for (const name of files) assert.equal((await readFile(path.join(logs, name), 'utf8')).includes(TYPED), false, `${name} holds no typed text`);
  assert.equal(runtime.stderr().includes(TYPED), false, 'nor the runtime output');
  const runs = await owner.call('agents.runs', { id: manager.id, limit: 20 });
  for (const run of runs) assert.equal(JSON.stringify(await owner.call('runs.items', { runId: run.id })).includes(TYPED), false, `run ${run.id} holds no typed text`);
});
