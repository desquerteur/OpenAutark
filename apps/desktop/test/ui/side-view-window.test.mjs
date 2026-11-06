// B-076: a side tab watched from another PC or a phone, in real Electron – the caster (main/side-driver/caster.ts) on a
// local page in a WebContentsView set up like a side-browser tab (sandboxed, its debugger attached for the color scheme)
// with the real side driver: `on` starts the screencast and JPEG frames come with the viewport, at most one per 500 ms
// while the page animates; a click mapped the runtime's way (view-input.ts inputCommands on side-view.ts sideMeta) lands
// on the button as a trusted click – also with the tab zoomed to 125 % – and counts as the person's (an agent waits, the
// tab is kept); typed text reaches the focused field; an address, back; a confirm() the page opens comes with the page,
// input waits for its answer and the watcher's answer lets the page go on; `off` stops the frames. The caster and driver
// are bundled by the test (esbuild); no app profile, no external sites. Owns: these paths. Never: touches the person's profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright-core';
import { inputCommands } from '../../src/runtime/browser/view-input.ts';
import { sideMeta } from '../../src/runtime/browser/side-view.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TAB = 'web-t1';

const PAGE = `<!doctype html><title>Remote test</title>
<style>body{font:16px system-ui;margin:24px} button{font-size:18px;padding:10px 24px;margin:180px 0 0 320px}
#dot{width:12px;height:12px;border-radius:6px;background:#1570d6;animation:spin 1s linear infinite;position:fixed;top:8px;left:8px}
@keyframes spin{from{transform:translateX(0)}to{transform:translateX(300px)}} #ask{margin-top:24px}</style>
<div id="dot"></div>
<button id="go">Go</button>
<p><input id="name" placeholder="Name"></p>
<button id="ask">Ask</button>
<script>
  let clicks = 0;
  document.getElementById('go').addEventListener('click', (e) => { clicks += 1; document.title = 'clicked ' + clicks + ' trusted=' + e.isTrusted; });
  document.getElementById('name').addEventListener('input', (e) => { document.title = 'typed:' + e.target.value; });
  document.getElementById('ask').addEventListener('click', () => { document.title = 'answer:' + confirm('Delete?'); });
</script>`;

const HARNESS = `const { app, BrowserWindow, WebContentsView } = require('electron');
app.setPath('userData', process.env.SIDE_TEST_DATA);
const { SideDriver, SideCaster } = require(process.env.SIDE_BUNDLE);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1060, height: 820, show: true });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23888">');
  const view = new WebContentsView({ webPreferences: { partition: 'side-view-test', sandbox: true, contextIsolation: true, nodeIntegration: false, safeDialogs: true, backgroundThrottling: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  const contents = view.webContents;
  contents.debugger.attach('1.3');
  const id = '${TAB}';
  const kept = [];
  const frames = [];
  const pages = [];
  const driver = new SideDriver({
    browser: () => ({
      sideTabs: () => ({ pages: [{ id, url: contents.getURL(), title: contents.getTitle() }], active: id }),
      sideContents: (tab) => (tab === id ? contents : undefined),
      sideOpen: () => { throw new Error('No new tabs in this test.'); },
      sideClose: () => { throw new Error('No.'); },
      sideKeep: (tab) => kept.push('driver:' + tab),
    }),
  });
  driver.tab(id, contents);
  const caster = new SideCaster({
    tab: (tab) => driver.side(tab), keep: (tab) => kept.push(tab),
    send: (update) => {
      pages.push(update.page);
      if (update.frame) { frames.push({ at: Date.now(), size: update.frame.data.length, head: update.frame.data.slice(0, 4), meta: update.frame.meta }); globalThis.lastFrame = update.frame.data; }
    },
  });
  Object.assign(globalThis, { caster, driver, kept, frames, pages, sideView: view });
  await contents.loadURL(process.env.SIDE_PAGE);
  globalThis.sideReady = true;
});
app.on('window-all-closed', () => app.quit());
`;

test('a watched side tab in real Electron: frames at most twice a second, a mapped click and typing land, also zoomed', { timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workforce-side-view-'));
  const bundle = path.join(dir, 'side.cjs');
  await build({
    stdin: { contents: "export { SideDriver } from './src/main/side-driver/driver.ts'; export { SideCaster } from './src/main/side-driver/caster.ts';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['electron'], logLevel: 'error',
  });
  const harness = path.join(dir, 'harness.cjs');
  await writeFile(harness, HARNESS);
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = `http://127.0.0.1:${server.address().port}/remote`;
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [harness], cwd: dir, timeout: 60_000,
    env: { ...process.env, SIDE_TEST_DATA: path.join(dir, 'data'), SIDE_BUNDLE: bundle, SIDE_PAGE: page },
  });
  app.context().on('dialog', () => {}); // Playwright dismisses a dialog nobody listens for; here the watcher answers it, as on the PC
  t.after(async () => {
    await app.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  for (let n = 0; n < 200 && !(await app.evaluate(() => globalThis.sideReady === true)); n += 1) await sleep(100);
  const inPage = (code) => app.evaluate((_electron, source) => globalThis.sideView.webContents.executeJavaScript(source), code);
  const frames = () => app.evaluate(() => globalThis.frames);
  const until = async (what, check) => {
    for (let n = 0; n < 60; n += 1) { const value = await check(); if (value) return value; await sleep(100); }
    assert.fail(`timed out: ${what}`);
  };
  const cast = (on) => app.evaluate((_electron, value) => globalThis.caster.cast({ tab: 'web-t1', on: value }), on);
  const input = (commands) => app.evaluate((_electron, list) => globalThis.caster.input({ tab: 'web-t1', commands: list }), commands);
  /** A click on the element's middle as the watcher sees it: CSS px × zoom on the frame, mapped back like the runtime does. */
  const click = async (selector) => {
    const last = (await frames()).at(-1);
    const rect = await inPage(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const { meta } = last;
    const point = { x: rect.x * meta.zoom, y: rect.y * meta.zoom, width: meta.deviceWidth, height: meta.deviceHeight };
    const mapped = sideMeta(meta);
    await input([
      ...inputCommands({ kind: 'mouse', type: 'down', ...point, button: 'left', clicks: 1 }, mapped),
      ...inputCommands({ kind: 'mouse', type: 'up', ...point, button: 'left', clicks: 1 }, mapped),
    ]);
  };

  // 1. on: the screencast runs and JPEG frames come with the page's viewport
  const started = await cast(true);
  assert.equal(started.ok, true);
  assert.equal(started.page.url, page);
  const first = await until('a first frame', async () => (await frames())[0]);
  assert.equal(first.head, '/9j/', 'a JPEG');
  assert.ok(Math.abs(first.meta.deviceWidth - 1000) <= 2 && Math.abs(first.meta.deviceHeight - 700) <= 2, JSON.stringify(first.meta));
  assert.equal(first.meta.zoom, 1);
  const before = (await frames()).length;
  await sleep(3000);
  const during = (await frames()).slice(before);
  t.diagnostic(`frames in 3 s while the page animates: ${during.length}; sizes ${during.map((f) => f.size).join(', ')}`);
  assert.ok(during.length >= 3 && during.length <= 7, `about two per second (${during.length})`);
  for (let i = 1; i < during.length; i += 1) assert.ok(during[i].at - during[i - 1].at >= 450, 'at most one per 500 ms');

  // 2. a click mapped the runtime's way lands on the button as a trusted click and is the person's
  await click('#go');
  assert.equal(await until('the click', () => inPage('document.title.startsWith("clicked") && document.title')), 'clicked 1 trusted=true');
  assert.deepEqual(await app.evaluate(() => globalThis.kept.filter((k) => !k.startsWith('driver:'))), [TAB]);
  assert.equal(await app.evaluate(() => globalThis.driver.side('web-t1').personActive(2000)), true, 'an agent waits for the person');

  // 3. the tab zoomed to 125 %: the frame says so and the mapped click still lands
  await app.evaluate(() => globalThis.sideView.webContents.setZoomFactor(1.25));
  await until('a zoomed frame', async () => (await frames()).at(-1).meta.zoom === 1.25);
  await sleep(300);
  await click('#go');
  assert.equal(await until('the zoomed click', () => inPage('document.title === "clicked 2 trusted=true" && document.title')), 'clicked 2 trusted=true');
  await app.evaluate(() => globalThis.sideView.webContents.setZoomFactor(1));
  await until('an unzoomed frame', async () => (await frames()).at(-1).meta.zoom === 1);
  await sleep(300);

  // 4. typing into the focused field
  await click('#name');
  await input(inputCommands({ kind: 'text', text: 'Grüße' }, undefined));
  assert.equal(await until('the typed text', () => inPage('document.title.startsWith("typed") && document.title')), 'typed:Grüße');

  // 5. an address and back, as the person's
  await app.evaluate((_electron, url) => globalThis.caster.nav({ tab: 'web-t1', url }), `${page}?second`);
  await until('the new address', async () => (await inPage('location.search')) === '?second');
  await app.evaluate(() => globalThis.caster.nav({ tab: 'web-t1', action: 'back' }));
  await until('back', async () => (await inPage('location.search')) === '');
  const named = await app.evaluate(() => globalThis.pages.at(-1));
  t.diagnostic(`page after back: ${JSON.stringify(named)}`);

  // 6. a dialog the page opens comes with the page; input waits for its answer, which the watcher gives
  const asking = click('#ask').then(() => 'taken', (error) => String(error)); // its release returns once the dialog is answered
  const dialog = await until('the dialog', () => app.evaluate(() => globalThis.pages.at(-1)?.dialog));
  assert.deepEqual(dialog, { type: 'confirm', message: 'Delete?' });
  await assert.rejects(input([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0, modifiers: 0 } }]), /dialog/);
  await app.evaluate(() => globalThis.caster.nav({ tab: 'web-t1', dialog: 'accept' }));
  assert.equal(await until('the answer', () => inPage('document.title.startsWith("answer") && document.title')), 'answer:true');
  assert.equal(await app.evaluate(() => globalThis.pages.at(-1)?.dialog), undefined, 'answered: gone from the page');
  t.diagnostic(`the click that opened the dialog: ${await asking}`);

  // 7. off: no more frames
  await cast(false);
  await sleep(400);
  const stopped = (await frames()).length;
  await sleep(1500);
  assert.equal((await frames()).length, stopped, 'the screencast stopped');
  assert.equal(await app.evaluate(() => globalThis.caster.watched('web-t1')), false);
});
