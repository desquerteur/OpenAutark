// <data>/pages (root/pages.ts): which files are pages, what a frame loads, and that a change is announced. And the route of a page's
// frame, which stays in an opaque origin with an open CSP.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProtocolHandlers } from '../../../src/main/protocols/handlers.ts';
import { routeSandboxUrl } from '../../../src/main/protocols/rules.ts';
import { subFrameNavigationAllowed } from '../../../src/main/security.ts';
import { ROOT_PAGES } from '../../../src/runtime/root/layout.ts';
import { listPages, pageHtml, watchPages } from '../../../src/runtime/root/pages.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { clock, recordingBus, tempDir } from '../store/helpers.ts';

test('a .html or .js file is a page; a .js is a module in an empty page; anything else stays out', (t) => {
  const temp = tempDir('wf-pages-');
  t.after(() => temp.cleanup());
  const dir = path.join(temp.dir, ROOT_PAGES);
  assert.deepEqual(listPages(temp.dir), [], 'no folder yet');
  mkdirSync(dir);
  mkdirSync(path.join(dir, 'assets.html'));
  writeFileSync(path.join(dir, 'board.html'), '<h1>Board</h1>');
  writeFileSync(path.join(dir, 'board.js'), 'ignored');
  writeFileSync(path.join(dir, 'clock.js'), 'document.title = "</script>";');
  writeFileSync(path.join(dir, 'notes.txt'), 'no page');
  writeFileSync(path.join(dir, '.hidden.html'), 'no page');
  assert.deepEqual(listPages(temp.dir).map((page) => page.name), ['board', 'clock']);
  assert.match(listPages(temp.dir)[0].path, /board\.html$/);
  assert.equal(pageHtml(temp.dir, 'board'), '<h1>Board</h1>');
  const module = pageHtml(temp.dir, 'clock');
  assert.match(module, /<script type="module">document\.title/);
  assert.equal(module.match(/<\/script>/g)?.length, 1, 'a closing tag in the code cannot end the script');
  assert.throws(() => pageHtml(temp.dir, 'gone'), /no page "gone"/);
});

test('every change of the folder is announced with the new list', (t) => {
  const temp = tempDir('wf-pages-');
  const root = new RootWatcher({ root: temp.dir, clock: clock(), watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  t.after(() => { root.stop(); temp.cleanup(); });
  const recorder = recordingBus();
  watchPages({ dataDir: temp.dir, root, bus: recorder.bus });
  const dir = path.join(temp.dir, ROOT_PAGES);
  mkdirSync(dir);
  const changed = () => { root.nudge(ROOT_PAGES); root.flush(ROOT_PAGES); };
  const last = () => (recorder.of('pages.updated').at(-1) as { pages: Array<{ name: string }> }).pages.map((page) => page.name);
  writeFileSync(path.join(dir, 'a.html'), 'x');
  changed();
  assert.deepEqual(last(), ['a']);
  rmSync(path.join(dir, 'a.html'));
  changed();
  assert.deepEqual(last(), []);
});

test('a page\'s frame: its own route, an open CSP in an opaque origin, wf.js first', async () => {
  assert.deepEqual(routeSandboxUrl('wf-sandbox://page/My%20board'), { kind: 'page', name: 'My board' });
  assert.equal(routeSandboxUrl('wf-sandbox://page/a%2Fb'), null);
  assert.equal(routeSandboxUrl('wf-sandbox://page/'), null);
  assert.ok(subFrameNavigationAllowed('wf-sandbox://page/board'));
  const handlers = new ProtocolHandlers({
    uiDir: '', sandboxLibDir: '', blobsDir: '', appHtml: async () => '',
    pageHtml: async (name) => { if (name !== 'board') throw Object.assign(new Error('no'), { code: 'not_found' }); return '<h1>Board</h1>'; },
  });
  const response = await handlers.sandbox(new Request('wf-sandbox://page/board'));
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src \* /);
  assert.match(csp, /sandbox allow-scripts allow-forms/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(await response.text(), /<script src="wf-sandbox:\/\/lib\/wf\.js"><\/script>.*<h1>Board<\/h1>/s);
  assert.equal((await handlers.sandbox(new Request('wf-sandbox://page/gone'))).status, 404);
});
