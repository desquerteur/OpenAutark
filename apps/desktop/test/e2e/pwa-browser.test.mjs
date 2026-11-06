// The PWA in a real mobile-emulated browser against the headless runtime (demo engine, temp
// profile under test-results/): pairing through the #pair link (the QR code's link – B-075: issued only while a phone can reach
// the PC, so phone access is on 'The same network' and the browser opens the link on localhost; one tier: the owner's phone
// has full access), the My day list with an answer, a chat message with the demo reply, the chat's controls on the
// phone (details, its area of tabs above the composer, the Plus and model menus – no permission chip), Settings › Devices › Notifications on the phone,
// the tab badge, the service worker, the offline snapshot, a runtime restart on the same address and the locked
// state after the device is removed in Settings › Devices (B-078 D5: no Phone access switch any more). (Phone access
// requests, To-do-only links and the phone-use stop went – Umbau Einfachheit.)
// Uses an installed Chrome or Edge through playwright-core (runtime/browser/channel.ts; force one
// with WORKFORCE_PWA_CHANNEL=msedge|chrome) and skips with a message when neither exists – it
// never downloads a browser. WebSocket frames are tapped by an init script; any 'forbidden'
// answer while the phone boots or tours the chat fails the test.
// Screenshots (light/dark, 390 px) land in test-results/<date>-pwa for the design review.
// Owns: this flow. Never: prints the pairing secret, the request ticket or the device token, touches real data.
// Run: npm run build && node --test test/e2e/pwa-browser.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { detectChannel } from '../../src/runtime/browser/channel.ts';
import { countNow } from '../../src/shared/model/todo-later.ts';
import { startRuntime } from './lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'test-results', `${new Date().toISOString().slice(0, 10)}-pwa`);

function installedChannel() {
  try { return detectChannel(); } catch { return undefined; }
}
const channel = process.env.WORKFORCE_PWA_CHANNEL || installedChannel();
/** Browser notices that are not app errors. */
const BENIGN_CONSOLE = [/^Banner not shown/];

/** Runs in every document before the app: records refused calls (by method) and close codes – never frame contents. */
const SOCKET_TAP = `(() => {
  const Native = window.WebSocket;
  const log = { forbidden: [], closes: [] };
  Object.defineProperty(window, '__wfSocketLog', { value: log });
  class Tapped extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      const methods = new Map();
      const send = this.send.bind(this);
      this.send = (data) => {
        try { const frame = JSON.parse(data); if (frame && frame.id !== undefined && typeof frame.method === 'string') methods.set(frame.id, frame.method); } catch {}
        return send(data);
      };
      this.addEventListener('message', (event) => {
        try { const frame = JSON.parse(event.data); if (frame && frame.error && frame.error.code === 'forbidden') log.forbidden.push(methods.get(frame.id) || 'unknown'); } catch {}
      });
      this.addEventListener('close', (event) => log.closes.push(event.code));
    }
  }
  window.WebSocket = Tapped;
})();`;

const socketLog = (page) => page.evaluate(() => {
  const log = window.__wfSocketLog;
  return log ? { forbidden: [...log.forbidden], closes: [...log.closes] } : { forbidden: [], closes: [] };
});

/** Task ids in the offline snapshot (IndexedDB 'workforce-pwa' / kv / 'todos'), [] when none. */
const snapshotIds = (page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open('workforce-pwa', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => resolve([]);
  open.onsuccess = () => {
    const db = open.result;
    try {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get('todos');
      request.onsuccess = () => { db.close(); resolve((request.result?.items ?? []).map((item) => item.id)); };
      request.onerror = () => { db.close(); resolve([]); };
    } catch { db.close(); resolve([]); }
  };
}));

/** Same-origin scripts and styles this document loaded that the service worker has not cached yet. */
const uncachedAssets = (page) => page.evaluate(async () => {
  const urls = performance.getEntriesByType('resource').map((entry) => entry.name)
    .filter((url) => url.startsWith(location.origin) && /\.(js|css)$/.test(new URL(url).pathname) && !/^\/(sw\.js|sandbox\/)/.test(new URL(url).pathname));
  const missing = [];
  for (const url of new Set(urls)) if (!(await caches.match(url))) missing.push(new URL(url).pathname);
  return missing;
});

/** Re-checks a page condition until it holds; `what` may be a function for a detailed message. */
async function until(check, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await delay(250);
  }
}

/** The restarted runtime must listen on the same port: the page's origin (token, snapshot, worker) depends on it. */
async function restartOnPort(dataDir, port) {
  for (let attempt = 1; ; attempt++) {
    const next = await startRuntime({ dataDir, keepData: true, port });
    if (next.port === port) return next;
    await next.stop();
    if (attempt >= 3) throw new Error(`the restarted runtime could not listen on port ${port} again (got ${next.port})`);
    await delay(1000);
  }
}

test('PWA on a phone-sized browser: pairing, For you, chat, badge, offline snapshot, restart, locked', {
  timeout: 300_000,
  skip: channel ? false : 'No installed Google Chrome or Microsoft Edge was found – this test uses an installed browser and never downloads one.',
}, async (t) => {
  await mkdir(shots, { recursive: true });
  const dataDir = await mkdtemp(path.join(shots, 'runtime-'));
  let runtime = await startRuntime({ dataDir, keepData: true });
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });
  t.diagnostic(`browser channel: ${channel}; screenshots: ${shots}`);

  // ---------------------------------------------------------------- owner prepares the PC
  const owner = runtime.client;
  await owner.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers
  const manager = (await owner.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await owner.call('chats.create', { title: 'Phone check', agentIds: [manager.id] });
  await owner.call('events.subscribe', { topics: ['chats', 'tasks', 'org', `chat:${chat.id}`] });
  const choice = await owner.call('tasks.create', { // B-054: a chat-free to-do
    title: 'Pick a thumbnail', assigneeKind: 'human', dueAt: Date.now() - 60 * 60_000, // overdue: Needs you
    widget: { type: 'choice', question: 'Which thumbnail?', options: ['Bright', 'Dark'] },
  });
  const note = await owner.call('todos.add', { text: 'Sign the delivery note' });
  const link = await owner.call('pwa.link', { name: 'Test phone' });
  const port = Number(new URL(link.url).port);

  // ---------------------------------------------------------------- the phone
  browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  await context.addInitScript(SOCKET_TAP);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  let online = true; // console errors count only while the PC is reachable
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (online && message.type() === 'error' && !BENIGN_CONSOLE.some((pattern) => pattern.test(message.text()))) consoleErrors.push(message.text());
  });
  const clean = (when) => {
    assert.deepEqual(pageErrors, [], `no uncaught page errors (${when})`);
    assert.deepEqual(consoleErrors, [], `no console errors (${when})`);
  };
  const bootChecked = async (when) => {
    await page.locator('.mobile-shell').waitFor({ timeout: 60_000 });
    await delay(1500); // late boot calls (system.info, overlay, done list) settle
    const { forbidden } = await socketLog(page);
    assert.deepEqual(forbidden, [], `no call is refused while the phone boots (${when})`);
  };
  const item = (task) => page.locator(`.mobile-shell .todo-item[data-task-id="${task.id}"]`);
  const badgeMatches = async () => {
    const open = countNow(await owner.call('todos.list'), Date.now()); // B-041: the badge counts Needs you
    const want = open === 0 ? '' : open > 99 ? '99+' : String(open);
    await page.waitForFunction((text) => (document.querySelector('.tab-bar .tab-badge')?.textContent ?? '') === text, want, { timeout: 15_000 });
    return want;
  };
  const shoot = async (name, scheme) => {
    await page.emulateMedia({ colorScheme: scheme });
    await delay(400);
    await page.screenshot({ path: path.join(shots, `${name}-${scheme}.png`) });
  };

  // 1. Pairing: the link's secret becomes a stored device token; the secret leaves the URL.
  await page.goto(`http://localhost:${port}/${new URL(link.url).hash}`); // localhost: a secure context, as over adb reverse
  await bootChecked('first open');
  const paired = await page.evaluate(() => ({ secretInUrl: location.href.includes('pair='), token: Boolean(localStorage.getItem('wf.token')) }));
  assert.equal(paired.secretInUrl, false, 'the pairing secret is removed from the URL');
  assert.equal(paired.token, true, 'a device token is stored');
  await page.evaluate(() => { location.hash = '#/day'; }); // B-041: the person's own to-dos are on My day; Home lists only Needs you
  await item(choice).waitFor({ timeout: 30_000 });
  await item(note).waitFor();

  // 2. Service worker (localhost is a secure context); an online reload keeps the pairing and
  //    lets the now-controlled page fill the worker's cache.
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 30_000 });
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope === `${location.origin}/`), true, 'the service worker is registered for the whole app');
  await page.reload();
  await bootChecked('reload');
  await item(note).waitFor({ timeout: 30_000 });
  assert.equal(await badgeMatches(), '1', 'the overdue choice is on the badge, the own note is not');
  clean('boot');
  await shoot('01-for-you', 'light');
  await shoot('01-for-you', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 3. For you: answering a choice resolves the to-do for the owner too.
  await item(choice).locator('.todo-open').tap();
  await item(choice).locator('.w-option', { hasText: 'Dark' }).tap();
  const done = await owner.waitFor('task.upserted', (task) => task.id === choice.id && task.status === 'done', 30_000);
  assert.deepEqual(done.result?.answer, { choice: 'Dark' }, 'the owner sees the phone\'s answer');
  await item(choice).waitFor({ state: 'detached', timeout: 15_000 });
  assert.equal(await badgeMatches(), '', 'answered, it leaves the badge');

  // 4. Chats → the manager chat → send → the demo reply appears.
  await page.locator('.tab-bar .tab', { hasText: 'Chats' }).tap();
  await page.locator('.chat-row-open', { hasText: 'Phone check' }).tap();
  await page.locator('textarea.composer-input').fill('Hello from the phone');
  await page.locator('.send-button[aria-label="Send"]').tap();
  const sent = await owner.waitFor('message.created', (message) => message.conversationId === chat.id && message.authorId === 'human' && message.body.includes('Hello from the phone'), 30_000);
  const reply = await owner.waitFor('message.updated', (message) => message.conversationId === chat.id && message.authorId === manager.id && message.state === 'final' && message.seq > sent.seq, 90_000);
  await page.locator(`article.message.agent[data-message-id="${reply.id}"]`).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('article.message.human', { hasText: 'Hello from the phone' }).count(), 1, 'the phone shows its own message once');
  clean('chat');
  await shoot('02-chat', 'light');
  await shoot('02-chat', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 4b. The chat's controls on the phone: details, the Plus menu and the model menu work; no permission chip.
  const panel = page.locator('.chat-panel');
  await page.locator('.chat-title-button').tap();
  await panel.locator('.chat-details').waitFor({ timeout: 15_000 });
  await shoot('02b-chat-details', 'light');
  await shoot('02b-chat-details', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await panel.locator('.chat-panel-top button[aria-label="Close"]').first().tap();
  await panel.waitFor({ state: 'detached' });
  // the chat's area: the row's Chat tabs cell opens it above the composer (a phone has no browser: app tabs only) and closes it
  const tabsCell = page.locator('.chat-header [data-cell="workspace"] button');
  await tabsCell.tap();
  await page.locator('.chat-area .workspace-pane').waitFor({ timeout: 15_000 });
  assert.ok(await page.locator('.composer').isVisible(), 'the composer stays under the area');
  assert.equal(await tabsCell.getAttribute('aria-pressed'), 'true');
  await shoot('02c-chat-area', 'light');
  await shoot('02c-chat-area', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await tabsCell.tap();
  await page.locator('.chat-area').waitFor({ state: 'detached' });

  await page.locator('.composer-plus').tap();
  const plus = page.getByRole('menu', { name: 'Add' });
  await plus.waitFor();
  const plusItems = (await plus.locator('[role="menuitem"] .menu-label > span:first-child').allTextContents()).map((text) => text.trim());
  for (const entry of ['Files & folders', 'Photos & screenshots', 'Task']) assert.ok(plusItems.includes(entry), `Plus offers ${entry}: ${plusItems.join(' | ')}`);
  await page.keyboard.press('Escape');
  await plus.waitFor({ state: 'detached' });

  await page.locator('.composer-actions .model-chip').tap();
  await page.getByRole('menu', { name: 'Model' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.composer-actions .permission-chip').count(), 0, 'no permission chip');
  await delay(800); // answers of calls the tour started
  assert.deepEqual([...new Set((await socketLog(page)).forbidden)], [], 'no control of the chat tour is refused');
  clean('chat tour');

  // 4c. Settings › Devices on the phone – notifications are "on" only when the PC holds this browser's subscription
  //     (asked with pwa.pushConfig, allowed for every paired device); before that the row offers "Turn on".
  await page.evaluate(() => { location.hash = '#/settings/devices'; });
  const devices = page.locator('#settings-devices');
  await devices.waitFor({ timeout: 15_000 });
  await devices.locator('.set-row', { hasText: 'Notifications' }).locator('button', { hasText: 'Turn on' }).waitFor({ timeout: 15_000 });
  await delay(500);
  assert.deepEqual([...new Set((await socketLog(page)).forbidden)], [], 'pwa.pushConfig is allowed for the phone');
  const phones = (await owner.call('pwa.state')).devices;
  assert.ok(phones.length > 0 && phones.every((device) => device.notifications === false), 'the owner sees: no subscription stored yet');
  await devices.scrollIntoViewIfNeeded();
  await shoot('02e-this-browser', 'light');
  await shoot('02e-this-browser', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  clean('this browser');

  // 5. Offline: the snapshot holds the open item and a snoozed one (F04: offline it waits under a
  //    collapsed "Later (1)"), every loaded asset is cached; stop the PC, reload.
  const nap = await owner.call('tasks.create', { title: 'Water the plants', assigneeKind: 'human' });
  await owner.call('todos.snooze', { id: nap.id, minutes: 60 });
  await page.evaluate(() => { location.hash = '#/day'; });
  await item(note).waitFor({ timeout: 15_000 });
  await until(async () => { const ids = await snapshotIds(page); return ids.includes(note.id) && ids.includes(nap.id) && !ids.includes(choice.id); }, 'the offline snapshot of the For-you list');
  let missing = [];
  await until(async () => { missing = await uncachedAssets(page); return missing.length === 0; }, () => `the service worker to cache ${missing.join(', ')}`);
  online = false;
  await runtime.stop();
  runtime = undefined;
  await page.reload();
  await page.locator('.offline-view').waitFor({ timeout: 30_000 });
  const offlineTitles = await page.locator('.offline-row-title').allTextContents();
  assert.ok(offlineTitles.some((title) => title.includes('Sign the delivery note')), `the offline list shows the open item: ${offlineTitles.join(' | ')}`);
  assert.ok(!offlineTitles.some((title) => title.includes('Pick a thumbnail')), 'the answered item is not in the offline list');
  assert.ok(!offlineTitles.some((title) => title.includes('Water the plants')), 'the snoozed item waits under the collapsed "Later"');
  await page.locator('.offline-later-toggle', { hasText: 'Later (1)' }).tap();
  const napRow = page.locator('.offline-later .offline-row', { hasText: 'Water the plants' });
  await napRow.waitFor({ timeout: 10_000 });
  assert.match(await napRow.locator('.offline-row-meta').textContent(), /Snoozed/, 'shown as snoozed');
  await shoot('03-offline', 'light');
  await shoot('03-offline', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 6. Restart on the same address: the phone is live again without pairing.
  runtime = await restartOnPort(dataDir, port);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // skip the reconnect backoff
  await bootChecked('after restart');
  await item(note).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.offline-view').count(), 0, 'the offline view is gone');
  assert.deepEqual(pageErrors, [], 'no uncaught page errors (restart)');

  // 7. Removed in Settings › Devices (devices.revoke, D5: access exists exactly while its accepted row exists):
  //    the live socket closes with 4403, the reloaded page stays refused and shows "This phone was removed."
  const row = (await runtime.client.call('devices.list')).find((device) => (device.kind === 'phone' || device.kind === 'browser') && device.status !== 'revoked');
  assert.ok(row, 'the paired phone has its row in Settings › Devices');
  await runtime.client.call('devices.revoke', { id: row.id });
  await until(async () => (await socketLog(page)).closes.includes(4403), 'the runtime to close the removed phone\'s connection');
  assert.equal((await runtime.client.call('devices.list')).some((device) => device.id === row.id && device.status !== 'revoked'), false, 'the row is gone from the list');
  await page.reload();
  let afterReload = { closes: [] };
  await until(async () => { afterReload = await socketLog(page); return afterReload.closes.some((code) => code === 4401 || code === 4403); }, () => `the reloaded page to be refused (closes: ${afterReload.closes.join(', ') || 'none'})`);
  await page.getByRole('dialog', { name: 'This phone was removed.' }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.todo-item').count(), 0, 'no live To-do rows once the device is removed');
  await shoot('04-locked', 'light');

  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
});
