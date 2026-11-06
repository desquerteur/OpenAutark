// End to end without an iPhone (B-078 follow-up): the iPhone web app as the website serves it (apps/website built with
// OFFLINE=1, SITE_URL=http://localhost:<p>/autark and AUTARK_RELAY at a local meeting server, into a temp copy, served by
// a small static server – localhost is a secure context), the real meeting server (services/remote-relay), a headless
// runtime whose devices.relay points at it, and Chromium with iPhone emulation (WebKit is not installed here). The phone
// types the PC's Remote ID, both screens show the same code, the PC accepts, the PC's own UI renders through the tunnel
// and the service worker, a chat line reaches the PC, a reload comes back from IndexedDB without pairing, the edge
// swipe calls the layered Back, and Forget removes the phone on the PC and returns to the start. The app runs on an
// origin of its own (127.0.0.1, the site on localhost). What stays unverified: real iOS (WebKit's service
// worker, standalone storage, background kill, Apple push, the microphone).
// Run: node scripts/build.mjs --only cli,ui,hosted && node --test test/e2e/hosted-iphone.test.mjs
// Owns: these assertions. Never: the user's data, or the real meeting server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { detectChannel } from '../../src/runtime/browser/channel.ts';
import { startRuntime } from './lib/runtime-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const website = path.join(root, '..', 'website');
const RELAY_MAIN = path.join(root, '..', '..', 'services', 'remote-relay', 'src', 'main.ts');
const channel = process.env.WORKFORCE_PWA_CHANNEL || (() => { try { return detectChannel(); } catch { return undefined; } })();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };

async function until(read, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function startMeeting() {
  const child = spawn(process.execPath, [RELAY_MAIN], { cwd: path.dirname(path.dirname(RELAY_MAIN)), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1' } });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the meeting server did not start\n${out}`)), 20_000);
    child.stdout.on('data', (chunk) => { out += chunk; const line = out.split('\n').find((entry) => entry.includes('meeting server listening')); if (line) { clearTimeout(timer); resolve(JSON.parse(line).port); } });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the meeting server exited (${code})\n${out}`)); });
  });
  return { url: `ws://127.0.0.1:${port}`, stop: () => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(resolve, 5000).unref?.(); } }) };
}

/** A static server for `dir` on a free port (directories answer with their index.html). */
async function serve(dir) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(dir, decodeURIComponent(url.pathname));
    if (!file.startsWith(dir)) { res.statusCode = 403; res.end(); return; }
    try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('the iPhone web app pairs by Remote ID and shows the PC\'s own UI through the meeting server', { timeout: 300_000 }, async (t) => {
  const meeting = await startMeeting();
  t.after(() => meeting.stop());
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const owner = runtime.client;
  await owner.call('settings.update', { devices: { relay: meeting.url } });
  await until(async () => (await owner.call('remote.relay')).status === 'connected', 'the PC at the meeting server');
  const remoteId = (await owner.call('remote.state')).self.remoteId;
  const agent = (await owner.call('agents.list'))[0];
  const chat = await owner.call('chats.create', { title: 'From the iPhone', agentIds: [agent.id] });

  // The website, built for this local address and meeting server, in a temp copy (dist/ of the real site stays as it is).
  const temp = await mkdtemp(path.join(os.tmpdir(), 'autark-site-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const part of ['build.mjs', 'src', 'public']) await cp(path.join(website, part), path.join(temp, part), { recursive: true });
  const site = await serve(path.join(temp, 'dist'));
  t.after(() => site.server.close());
  // The app on an origin of its own (127.0.0.1 here, the site on localhost): the site's /autark/app/ only forwards.
  const appUrl = `http://127.0.0.1:${site.port}/app`;
  execFileSync(process.execPath, [path.join(temp, 'build.mjs')], { cwd: temp, stdio: 'pipe', env: { ...process.env, OFFLINE: '1', SITE_URL: `http://localhost:${site.port}/autark`, APP_URL: appUrl, AUTARK_RELAY: meeting.url } });
  assert.ok((await readFile(path.join(temp, 'dist', 'autark', 'app', 'index.html'), 'utf8')).includes(`url=${appUrl}/`), 'the site\'s old address forwards to the app');

  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'allow' });
  const phone = await context.newPage();
  const errors = [];
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(`${appUrl}/`);

  // Safari, not yet on the Home Screen: the install steps first (continued here for the test).
  await phone.locator('.hs-title', { hasText: 'Add Autark to your Home Screen' }).waitFor({ timeout: 30_000 });
  await phone.locator('button', { hasText: 'Continue in Safari' }).click();
  await phone.locator('.hs-title', { hasText: 'Connect to your PC' }).waitFor();
  await phone.locator('.hs-input').fill(remoteId);
  await phone.locator('button', { hasText: 'Connect' }).first().click();
  const code = (await phone.locator('.hs-code').textContent({ timeout: 30_000 })).trim();
  const request = await until(async () => (await owner.call('remote.state')).incoming[0], 'the request on the PC');
  assert.equal(request.role, 'phone');
  assert.equal(request.code, code, 'both screens show the same code');
  await owner.call('remote.decide', { id: request.id, accept: true });

  // The PC's own UI, through the tunnel and the service worker.
  await phone.locator('.mobile-shell').waitFor({ timeout: 90_000 });
  assert.equal(await phone.locator('#hosted-shell').count(), 0, 'the shell\'s frame is gone');
  const phones = (await owner.call('devices.list')).filter((device) => device.kind === 'phone');
  assert.equal(phones.length, 1, 'the PC lists the iPhone');
  const frame = await phone.evaluate(() => ({ metas: document.querySelectorAll('meta[name="theme-color"]').length, media: document.querySelector('meta[name="theme-color"]').media, html: getComputedStyle(document.documentElement).backgroundColor }));
  assert.deepEqual({ metas: frame.metas, media: frame.media }, { metas: 1, media: '' }, 'one theme-color the PC UI\'s theme drives');
  assert.equal(frame.html, 'rgba(0, 0, 0, 0)', 'the shell colours nothing outside its frame: the PC UI\'s body colours the page');

  await phone.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
  const input = phone.locator('textarea.composer-input');
  await input.waitFor({ timeout: 30_000 });
  await input.fill('Hello from the iPhone');
  await phone.locator('.send-button[aria-label="Send"]').tap();
  await until(async () => (await owner.call('messages.list', { conversationId: chat.id })).some((message) => message.body === 'Hello from the iPhone'), 'the line on the PC');

  // A reload: the key and token come back from IndexedDB, no pairing.
  await phone.reload();
  await phone.locator('.mobile-shell').waitFor({ timeout: 90_000 });
  assert.equal(await phone.locator('.hs-title', { hasText: 'Connect to your PC' }).count(), 0);

  // The left-edge swipe is the layered Back the Android app calls.
  const backs = await phone.evaluate(() => {
    let count = 0;
    const original = window.autarkBack;
    window.autarkBack = () => { count++; return original?.() ?? false; };
    const touch = (type, x) => {
      const point = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 300 });
      document.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [point], changedTouches: [point], bubbles: true }));
    };
    touch('touchstart', 6); touch('touchend', 140);
    touch('touchstart', 200); touch('touchend', 340); // not from the edge
    return count;
  });
  assert.equal(backs, 1);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal scroll at phone width (${overflow}px)`);

  // Forget: asks, removes this phone on the PC, clears here, back to the start.
  let question = '';
  phone.once('dialog', (dialog) => { question = dialog.message(); void dialog.accept(); });
  await phone.evaluate(() => void window.autarkHosted.forget());
  await phone.locator('.hs-title', { hasText: 'Add Autark to your Home Screen' }).waitFor({ timeout: 30_000 });
  assert.match(question, /signs out here and on your PCs/);
  assert.equal(await phone.evaluate(() => localStorage.getItem('wf.token')), null, 'the token is gone');
  const row = (await owner.call('devices.list')).find((device) => device.id === phones[0].id);
  assert.ok(!row || row.status === 'revoked', 'Forget removed the phone on the PC too');
  assert.deepEqual(errors, [], 'no uncaught page errors');
});
