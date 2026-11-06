// B-055 F1: the side driver (main/side-driver) in real Electron against a local page in a WebContentsView
// set up like a side-browser tab (sandboxed, its debugger already attached for the color scheme, which the
// driver shares): snapshot with refs and a hidden password value → fill, check, select and click by ref
// (real mouse moves: the button sees mouseenter and a trusted click) → the change list → the agent's named
// cursor drawn in the page (isolated world, closed shadow root) → the person's own mouse refuses the next
// step and is reported as their pointer → console, network (secrets hidden), wait, screenshot → and what
// the debugger does while the tab's DevTools are open. The driver is bundled by the test (esbuild); no app
// profile, no external sites. Owns: these paths. Never: touches the person's profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGE = `<!doctype html><title>Side test</title>
<style>body{font:16px system-ui;margin:24px} label{display:block;margin:10px 0} button{font-size:18px;padding:8px 20px}</style>
<h1>Checkout</h1>
<label>Email <input id="email" placeholder="you@example.com"></label>
<label>Password <input id="pw" type="password" value="hunter2"></label>
<label><input type="checkbox" id="keep"> Keep me signed in</label>
<label>Country <select id="country"><option>Austria</option><option>Germany</option></select></label>
<button id="pay">Pay</button>
<p id="out"></p>
<script>
  let hovered = false;
  const $ = (id) => document.getElementById(id);
  $('pay').addEventListener('mouseenter', () => { hovered = true; });
  $('pay').addEventListener('click', (e) => {
    $('out').textContent = 'Paid by ' + $('email').value + (hovered ? ' (hovered)' : '') + ' trusted=' + e.isTrusted + ' keep=' + $('keep').checked + ' country=' + $('country').value;
    console.error('paid!');
    fetch('/api/pay?token=abc123', { method: 'POST', headers: { Authorization: 'Bearer secret-1' } });
  });
</script>`;

const HARNESS = `const { app, BrowserWindow, WebContentsView } = require('electron');
app.setPath('userData', process.env.SIDE_TEST_DATA);
const { SideDriver } = require(process.env.SIDE_DRIVER_BUNDLE);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1060, height: 820, show: true });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23888">');
  const view = new WebContentsView({ webPreferences: { partition: 'side-test', sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true, backgroundThrottling: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 760 });
  const contents = view.webContents;
  contents.debugger.attach('1.3'); // as workspace-browser.ts scheme() does – the driver shares it
  contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => {});
  const points = [];
  const id = 'web-t1';
  const driver = new SideDriver({
    browser: () => ({
      sideTabs: () => ({ pages: [{ id, url: contents.getURL(), title: contents.getTitle() }], active: id }),
      sideContents: (tab) => (tab === id ? contents : undefined),
      sideOpen: () => { throw new Error('No new tabs in this test.'); },
      sideClose: () => { throw new Error('No.'); },
    }),
    pointer: (point) => points.push(point),
    person: () => ({ kind: 'person', id: 'owner', name: 'Lukas' }),
  });
  driver.tab(id, contents);
  Object.assign(globalThis, { side: driver, sidePoints: points, sideView: view });
  await contents.loadURL(process.env.SIDE_PAGE);
  globalThis.sideReady = true;
});
app.on('window-all-closed', () => app.quit());
`;

test('side driver in real Electron: snapshot, act by ref with real mouse moves, named cursor, person first, debugging', { timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workforce-side-'));
  const bundle = path.join(dir, 'side-driver.cjs');
  await build({ entryPoints: [path.join(root, 'src/main/side-driver/driver.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['electron'], logLevel: 'error' });
  const harness = path.join(dir, 'harness.cjs');
  await writeFile(harness, HARNESS);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/pay')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=server-secret; HttpOnly' });
      res.end(JSON.stringify({ ok: true, access_token: 'tok-999' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = `http://127.0.0.1:${server.address().port}/checkout`;
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [harness], cwd: dir, timeout: 60_000,
    env: { ...process.env, SIDE_TEST_DATA: path.join(dir, 'data'), SIDE_DRIVER_BUNDLE: bundle, SIDE_PAGE: page },
  });
  t.after(async () => {
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  for (let n = 0; n < 200 && !(await app.evaluate(() => globalThis.sideReady === true)); n += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const agent = { id: 'ag_ada', name: 'Ada' };
  const call = (value) => app.evaluate((_electron, request) => globalThis.side.call(request), { agent, ...value });
  const inPage = (code) => app.evaluate((_electron, source) => globalThis.sideView.webContents.executeJavaScript(source), code);

  // 1. snapshot: refs, states, the password value hidden
  const snap = await call({ action: 'snapshot' });
  assert.equal(snap.ok, true, snap.error);
  t.diagnostic(`snapshot:\n${snap.text}`);
  assert.match(snap.text, /- heading "Checkout" \[level=1\] \[ref=s\d+\]/);
  assert.match(snap.text, /- textbox "Password" \[ref=s\d+\]: \[hidden\]/);
  assert.ok(!snap.text.includes('hunter2'));
  assert.ok(!/- text \[ref=s\d+\]: (Email|Password|Country)$/m.test(snap.text), 'a label’s text beside its field is no extra line');
  const ref = (pattern) => { const hit = new RegExp(`${pattern} [^\\n]*?\\[ref=(s\\d+)\\]`).exec(snap.text); assert.ok(hit, pattern); return hit[1]; };
  const email = ref('- textbox "Email"'), keep = ref('- checkbox "Keep me signed in"'), country = ref('- combobox "Country"'), pay = ref('- button "Pay"');

  // 2. act by ref: fill, check, select, click – real mouse moves, then a trusted click
  const act = await call({ action: 'act', steps: [{ action: 'fill', ref: email, value: 'ada@example.com' }, { action: 'check', ref: keep }, { action: 'select', ref: country, value: 'Germany' }, { action: 'click', ref: pay }] });
  assert.equal(act.ok, true, act.error);
  assert.equal(act.done, 4);
  t.diagnostic(`changes:\n${act.changes}`);
  assert.equal(await inPage('document.getElementById("out").textContent'), 'Paid by ada@example.com (hovered) trusted=true keep=true country=Germany');
  assert.match(act.changes, /Paid by ada@example\.com \(hovered\) trusted=true/);
  assert.match(act.changes, /- checkbox "Keep me signed in" \[checked\]/);

  // 3. the agent's named cursor in the page: drawn in the driver's world, over the button, the page cannot see inside
  const cursors = await app.evaluate(() => globalThis.side.tabs.get('web-t1').cdp.inWorld('__wfSide.state()'));
  const box = await inPage(`(() => { const r = document.getElementById('pay').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0].id, 'ag_ada');
  assert.equal(cursors[0].shown, true);
  assert.ok(Math.abs(cursors[0].x - box.x) <= 2 && Math.abs(cursors[0].y - box.y) <= 2, `cursor at the button (${JSON.stringify(cursors[0])} vs ${JSON.stringify(box)})`);
  assert.equal(await inPage('typeof globalThis.__wfSide'), 'undefined', 'the page’s own world has no driver');
  assert.equal(await inPage('document.documentElement.lastElementChild.shadowRoot'), null, 'the overlay’s shadow root is closed');
  const colored = await app.evaluate(async (_electron, at) => {
    const image = await globalThis.sideView.webContents.capturePage({ x: Math.round(at.x), y: Math.round(at.y), width: 70, height: 40 });
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    let count = 0;
    for (let i = 0; i < width * height * 4; i += 4) { const r = bitmap[i + 2], g = bitmap[i + 1], b = bitmap[i]; if (Math.max(r, g, b) - Math.min(r, g, b) > 80) count += 1; }
    return count;
  }, box);
  assert.ok(colored > 60, `the cursor and its name label are drawn in the agent's color (${colored} colored pixels)`);
  const agentPoint = (await app.evaluate(() => globalThis.sidePoints)).filter((p) => p.actor.kind === 'agent').at(-1);
  assert.deepEqual({ surface: agentPoint.surface, action: agentPoint.action, target: agentPoint.target }, { surface: 'side:web-t1', action: 'click', target: { role: 'button', name: 'Pay', ref: pay } });

  // 4. the person goes first: their own mouse refuses the next step and is reported as their pointer
  await app.evaluate(() => { const c = globalThis.sideView.webContents; c.sendInputEvent({ type: 'mouseMove', x: 600, y: 500 }); c.sendInputEvent({ type: 'mouseMove', x: 610, y: 505 }); });
  let personPoint;
  for (let n = 0; n < 40 && !personPoint; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    personPoint = (await app.evaluate(() => globalThis.sidePoints)).find((p) => p.actor.kind === 'person');
  }
  assert.ok(personPoint, 'the person’s pointer is reported');
  assert.equal(personPoint.surface, 'side:web-t1');
  assert.deepEqual(personPoint.actor, { kind: 'person', id: 'owner', name: 'Lukas' });
  const refused = await call({ action: 'act', steps: [{ action: 'click', ref: pay }] });
  assert.deepEqual([refused.ok, refused.personActive, refused.done], [false, true, 0]);
  await new Promise((resolve) => setTimeout(resolve, 2100));

  // 5. debugging: console, network (secrets hidden), eval + wait, find, text, screenshot
  const consoleOut = await call({ action: 'console', errorsOnly: true });
  assert.match(consoleOut.text, /\[error\] \S+ paid!/);
  const net = await call({ action: 'network', pattern: '/api/pay' });
  assert.match(net.text, /POST 200 fetch .*\/api\/pay\?token=hidden \[id=([\w.~-]+)\]/);
  const requestId = /\[id=([\w.~-]+)\]/.exec(net.text)[1];
  const detail = await call({ action: 'network', requestId });
  t.diagnostic(`request:\n${detail.text}`);
  assert.match(detail.text, /Authorization: \[hidden\]/i);
  assert.match(detail.text, /"access_token":"\[hidden\]"/);
  assert.ok(!/secret-1|tok-999|server-secret/.test(detail.text));
  const later = call({ action: 'wait', wait: { text: 'Later text', timeoutMs: 5000 } });
  const evaluated = await call({ action: 'eval', expression: 'setTimeout(() => document.body.append("Later text"), 300); 6 * 7' });
  assert.equal(evaluated.text, '42');
  assert.equal((await later).ok, true);
  assert.match((await call({ action: 'find', query: 'button pay' })).text, new RegExp(`^- button "Pay" (\\[focused\\] )?\\[ref=${pay}\\]$`));
  assert.match((await call({ action: 'text' })).text, /Checkout[\s\S]*Later text/);
  const shot = await call({ action: 'screenshot', maxEdge: 800 });
  assert.equal(shot.ok, true, shot.error);
  assert.equal(shot.image.width, 800);
  assert.ok(shot.image.data.length > 1000);

  // 6. with the tab's DevTools open (F12): the debugger still works – or says clearly why not
  await app.evaluate(() => new Promise((resolve) => { const c = globalThis.sideView.webContents; c.once('devtools-opened', resolve); c.openDevTools({ mode: 'detach' }); }));
  const withDevTools = await call({ action: 'snapshot', full: true });
  t.diagnostic(`with DevTools open: ${withDevTools.ok ? 'works' : withDevTools.error}`);
  if (withDevTools.ok) {
    assert.match(withDevTools.text, /- button "Pay"/);
    const click = await call({ action: 'act', motion: 'instant', steps: [{ action: 'click', ref: pay }] });
    assert.equal(click.ok, true, click.error);
  } else assert.match(withDevTools.error, /DevTools/);
  await app.evaluate(() => globalThis.sideView.webContents.closeDevTools());
  const after = await call({ action: 'snapshot', full: true });
  assert.equal(after.ok, true, after.error);
});
