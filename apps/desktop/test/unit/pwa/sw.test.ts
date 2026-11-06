// The PWA service worker (src/ui/pwa/sw.ts, DEV5A) in node:vm: bundled with esbuild like the
// build does, run against a fake ServiceWorkerGlobalScope. A push shows the notification with the
// payload's tag and url and still alerts when it replaces an older one (renotify); a tap focuses
// an open app window and routes it in-app (or opens one); RPC traffic is never answered from the
// worker; the offline For-you snapshot has a fallback; install precaches main.css and the chunks
// main.js imports statically (scripts/sw-precache.mjs computes them from the build's metafile,
// scripts/build.mjs passes them in), fails rather than keep part of that set, and serves the set
// from the worker's own cache without refreshing it in place (review #20).
// Owns: these assertions only. Never: a real browser, push service or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build, buildSync } from 'esbuild';
import { swPrecacheDefines } from '../../../scripts/sw-precache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ORIGIN = 'https://desk.tail1234.ts.net';

type Handler = (event: Record<string, unknown>) => void;

function bundle(define?: Record<string, string>): string {
  const out = buildSync({ entryPoints: [path.join(root, 'src/ui/pwa/sw.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent', ...(define ? { define } : {}) });
  return out.outputFiles[0].text;
}

const code = bundle();

/** Cache Storage that records what the worker adds, per cache name; `failing` URLs cannot be fetched. */
function fakeCaches(failing: string[] = [], cached: string[] = []) {
  const added = new Map<string, string[]>();
  const open = async (name: string) => {
    if (!added.has(name)) added.set(name, []);
    return {
      add: async (url: string) => { if (failing.includes(url)) throw new TypeError(`fetch failed: ${url}`); added.get(name)!.push(url); },
      match: async (request: { url: string }) => (cached.includes(new URL(request.url).pathname) ? new Response(`cached ${new URL(request.url).pathname}`) : undefined),
      put: async () => undefined,
    };
  };
  return { added, caches: { open, keys: async () => [...added.keys()], delete: async (name: string) => added.delete(name), match: async () => undefined } };
}

/** `globals` stand in for the build's esbuild `define`s (sw.ts reads them with typeof); `code` is another bundle. */
interface WorkerOptions { globals?: Record<string, unknown>; caches?: unknown; open?: Array<{ tag: string; close(): void }>; code?: string }

/** A fresh worker: its handlers, what it showed and which windows it touched. */
function worker(windows: Array<{ url: string }> = [], options: WorkerOptions = {}) {
  const handlers = new Map<string, Handler>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const posted: unknown[] = [];
  const scope = {
    registration: {
      showNotification: async (title: string, shownOptions: Record<string, unknown>) => { shown.push({ title, options: shownOptions }); },
      ...(options.open ? { getNotifications: async (filter: { tag?: string }) => options.open!.filter((n) => n.tag === filter.tag) } : {}),
    },
    clients: {
      matchAll: async () => windows.map((win) => ({
        url: win.url,
        focus: async () => { focused.push(win.url); },
        postMessage: (message: unknown) => { posted.push(message); },
      })),
      openWindow: async (url: string) => { opened.push(url); },
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Handler) => { handlers.set(type, fn); },
  };
  const context = vm.createContext({ self: scope, URL, Response, Request, JSON, Promise, console, caches: options.caches, fetch: undefined, indexedDB: undefined, ...options.globals });
  vm.runInContext(options.code ?? code, context);
  /** Dispatches an event and waits for everything it handed to waitUntil / respondWith. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Array<Promise<unknown>> = [];
    let response: Promise<Response> | Response | undefined;
    handlers.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise), respondWith: (value: Promise<Response> | Response) => { response = value; } });
    await Promise.all(pending);
    return response;
  };
  return { handlers, shown, opened, focused, posted, dispatch };
}

/** Objects made inside the vm have another realm's prototypes: compare them as plain JSON. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const pushEvent = (payload: unknown) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload), text: () => String(payload) } });

test('a push shows the notification with the payload\'s tag and where a tap leads', async () => {
  const sw = worker();
  await sw.dispatch('push', pushEvent({ kind: 'todo', title: 'Approve the invoice', body: '€120 for hosting', url: '/#/chat/ch_7', tag: 'todo:ta_3' }));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Approve the invoice');
  assert.equal(sw.shown[0].options.body, '€120 for hosting');
  assert.equal(sw.shown[0].options.tag, 'todo:ta_3');
  assert.deepEqual(plain(sw.shown[0].options.data), { url: '/#/chat/ch_7' });
});

test('a newer notice with the same tag still alerts: renotify, and the old one is closed first', async () => {
  const closed: string[] = [];
  const open = [{ tag: 'todo:ta_3', close: () => { closed.push('todo:ta_3'); } }, { tag: 'chat:ch_7', close: () => { closed.push('chat:ch_7'); } }];
  const sw = worker([], { open });
  await sw.dispatch('push', pushEvent({ kind: 'todo', title: 'Take the cake out', body: 'Timer', url: '/#/home', tag: 'todo:ta_3' }));
  assert.equal(sw.shown[0].options.tag, 'todo:ta_3');
  assert.equal(sw.shown[0].options.renotify, true, 'the timer rings although the creation notice is still in the tray');
  assert.deepEqual(closed, ['todo:ta_3'], 'only the notice it replaces');

  const untagged = worker();
  await untagged.dispatch('push', pushEvent({ kind: 'info', title: 'Workforce', body: 'Hello' }));
  assert.equal(untagged.shown[0].options.tag, undefined);
  assert.equal(untagged.shown[0].options.renotify, false, 'renotify needs a tag (it would throw without one)');
});

test('a push that is not JSON still shows its text; no url means the app\'s start', async () => {
  const sw = worker();
  await sw.dispatch('push', pushEvent('{not json'));
  assert.equal(sw.shown[0].title, 'Autark');
  assert.equal(sw.shown[0].options.body, '{not json');
  assert.deepEqual(plain(sw.shown[0].options.data), { url: '/' });
});

test('a tap focuses the open app window and routes it in-app; without one it opens the app there', async () => {
  const notification = (url: string) => ({ notification: { data: { url }, close: () => undefined }, action: '' });
  const open = worker([{ url: 'https://elsewhere.example/' }, { url: `${ORIGIN}/#/home` }]);
  await open.dispatch('notificationclick', notification('/#/chat/ch_7'));
  assert.deepEqual(open.focused, [`${ORIGIN}/#/home`], 'only a window of this app');
  assert.deepEqual(plain(open.posted), [{ type: 'wf.navigate', url: `${ORIGIN}/#/chat/ch_7` }]);
  assert.deepEqual(open.opened, []);

  const closed = worker();
  await closed.dispatch('notificationclick', notification('/#/home'));
  assert.deepEqual(closed.opened, [`${ORIGIN}/#/home`]);
});

test('RPC and WebSocket requests are never answered by the worker; the offline list has a fallback', async () => {
  const sw = worker();
  const request = (pathname: string) => ({ request: { method: 'GET', url: `${ORIGIN}${pathname}`, mode: 'cors' } });
  assert.equal(await sw.dispatch('fetch', request('/rpc')), undefined);
  assert.equal(await sw.dispatch('fetch', request('/ws')), undefined);
  assert.equal(await sw.dispatch('fetch', request('/files/fi_1')), undefined);
  const offline = await sw.dispatch('fetch', request('/offline/todos.json'));
  assert.ok(offline, 'answered from the worker');
  assert.deepEqual(plain(await (await offline)!.json()), { at: 0, items: [] }, 'no snapshot (no IndexedDB here) → an empty list, not an error');
});

test('install precaches the boot shell: main.css always, the build\'s static chunks under a cache named by the build', async () => {
  const plainBuild = fakeCaches();
  await worker([], { caches: plainBuild.caches }).dispatch('install', {});
  assert.deepEqual([...plainBuild.added.keys()], ['workforce-shell-v1']);
  assert.ok(plainBuild.added.get('workforce-shell-v1')!.includes('/main.css'), 'main.css boots the page offline too');

  const built = fakeCaches();
  const globals = { __SHELL_EXTRA__: ['/main.css', '/chunks/chunk-A1.js', '/chunks/chunk-B2.js'], __BUILD_ID__: '0123abcd' };
  await worker([], { globals, caches: built.caches }).dispatch('install', {});
  const added = built.added.get('workforce-shell-0123abcd')!;
  for (const url of ['/', '/index.html', '/main.js', '/main.css', '/chunks/chunk-A1.js', '/chunks/chunk-B2.js']) assert.ok(added.includes(url), url);
  assert.equal(added.filter((url) => url === '/main.css').length, 1, 'each file once');
});

test('a build\'s boot files are one set: a missing one fails the install, and they come from this worker\'s cache only', async () => {
  const globals = { __SHELL_EXTRA__: ['/main.css', '/chunks/chunk-A1.js'], __BUILD_ID__: '0123abcd' };
  const broken = fakeCaches(['/chunks/chunk-A1.js']);
  await assert.rejects(worker([], { globals, caches: broken.caches }).dispatch('install', {}), /chunk-A1/, 'the active worker keeps its complete set');
  const optional = fakeCaches(['/icon.png', '/manifest.webmanifest']);
  await worker([], { globals, caches: optional.caches }).dispatch('install', {});
  assert.ok(optional.added.get('workforce-shell-0123abcd')!.includes('/chunks/chunk-A1.js'), 'an optional file may be missing');
  await worker([], { caches: fakeCaches(['/main.js']).caches }).dispatch('install', {}); // no build id: nothing is required

  const fetched: string[] = [];
  const fetch = async (request: { url: string }) => { fetched.push(new URL(request.url).pathname); return new Response('fresh'); };
  const sw = worker([], { globals: { ...globals, fetch }, caches: fakeCaches([], ['/main.js', '/chunks/chunk-A1.js', '/icon.png']).caches });
  const get = async (pathname: string) => (await (await sw.dispatch('fetch', { request: { method: 'GET', url: `${ORIGIN}${pathname}`, mode: 'no-cors' } }))!).text();
  assert.equal(await get('/main.js'), 'cached /main.js');
  assert.equal(await get('/chunks/chunk-A1.js'), 'cached /chunks/chunk-A1.js');
  assert.deepEqual(fetched, [], 'no background refresh: a newer main.js never lands next to these chunks');
  assert.equal(await get('/main.css'), 'fresh', 'a boot file missing from the cache comes from the network');
  assert.equal(await get('/icon.png'), 'cached /icon.png');
  assert.deepEqual(fetched, ['/main.css', '/icon.png'], 'other assets still refresh in the background');
});

test('scripts/build.mjs builds sw.js with the precache defines of the UI build it just made', async () => {
  const source = await readFile(path.join(root, 'scripts/build.mjs'), 'utf8');
  assert.match(source, /import \{ swPrecacheDefines \} from '\.\/sw-precache\.mjs';/);
  const ui = source.slice(source.indexOf('ui: async'));
  assert.match(ui, /const app = await build\(\{[^}]*?entryPoints: \{ main: 'src\/ui\/main\.tsx' \}[\s\S]*?metafile: true[\s\S]*?\}\);/);
  assert.match(ui, /const precache = await swPrecacheDefines\(\{ metafile: app\.metafile \}\);/);
  assert.match(ui, /build\(\{ \.\.\.common, define: \{ \.\.\.common\.define, \.\.\.precache \}, entryPoints: \['src\/ui\/pwa\/sw\.ts'\]/);
});

test('sw-precache: main.js\'s static chunks (transitively) and its CSS, never lazy chunks; the id follows their content', async () => {
  // A real esbuild split build like scripts/build.mjs (in memory): main imports `shared` and lazily `lazy`.
  const files: Record<string, string> = {
    'main.ts': "import { shared } from './shared.ts'; import './main.css'; export const run = () => import('./lazy.ts').then((m) => m.lazy + shared);",
    'shared.ts': "import { deep } from './deep.ts'; export const shared = 'shared' + deep;",
    'deep.ts': "export const deep = 'deep';",
    'lazy.ts': "import { shared } from './shared.ts'; import { deep } from './deep.ts'; export const lazy = 'lazy' + shared + deep;",
    'main.css': 'body { color: red; }',
  };
  const result = await build({
    entryPoints: { main: 'virtual:main.ts' }, bundle: true, write: false, metafile: true, splitting: true, format: 'esm',
    outdir: 'app/ui', chunkNames: 'chunks/[name]-[hash]', absWorkingDir: root, logLevel: 'silent',
    plugins: [{
      name: 'virtual',
      setup(b) {
        b.onResolve({ filter: /./ }, (args) => ({ path: args.path.replace(/^virtual:|^\.\//, ''), namespace: 'virtual' }));
        b.onLoad({ filter: /./, namespace: 'virtual' }, (args) => ({ contents: files[args.path], loader: args.path.endsWith('.css') ? 'css' : 'ts' }));
      },
    }],
  });
  const contents = new Map(result.outputFiles.map((file) => [path.relative(root, file.path).split(path.sep).join('/'), file.text]));
  const read = async (file: string) => contents.get(file) ?? '';
  const defines = await swPrecacheDefines({ metafile: result.metafile, read });
  const extra = JSON.parse(defines.__SHELL_EXTRA__) as string[];
  assert.ok(extra.includes('/main.css'), extra.join(', '));
  const chunks = extra.filter((url) => url.startsWith('/chunks/'));
  assert.ok(chunks.length >= 1, `the shared chunk main.js imports: ${extra.join(', ')}`);
  for (const url of chunks) assert.ok(contents.has(`app/ui${url}`), `${url} is an output of the build`);
  const lazyChunk = [...contents.keys()].find((file) => file.startsWith('app/ui/chunks/lazy'));
  assert.ok(lazyChunk, `a lazy chunk exists: ${[...contents.keys()].join(', ')}`);
  assert.ok(!extra.includes(`/${path.posix.relative('app/ui', lazyChunk)}`), 'the lazy chunk is left to the runtime cache');
  assert.match(JSON.parse(defines.__BUILD_ID__), /^[0-9a-f]{12}$/);

  // sw.ts built with these defines (as scripts/build.mjs does) precaches them under the build's name.
  const installed = fakeCaches();
  await worker([], { code: bundle(defines), caches: installed.caches }).dispatch('install', {});
  const name = `workforce-shell-${JSON.parse(defines.__BUILD_ID__)}`;
  assert.deepEqual([...installed.added.keys()], [name]);
  for (const url of extra) assert.ok(installed.added.get(name)!.includes(url), url);

  const changed = await swPrecacheDefines({ metafile: result.metafile, read: async (file) => `${await read(file)}/* v2 */` });
  assert.notEqual(changed.__BUILD_ID__, defines.__BUILD_ID__, 'new content → new cache name → a new worker installs');

  // Transitive static imports (a chunk importing a chunk) are followed; externals and lazy ones are not.
  const metafile = { outputs: {
    'app/ui/main.js': { imports: [{ path: 'app/ui/chunks/a.js', kind: 'import-statement' }, { path: 'app/ui/chunks/lazy.js', kind: 'dynamic-import' }, { path: 'https://cdn.example/x.js', kind: 'import-statement', external: true }] },
    'app/ui/chunks/a.js': { imports: [{ path: 'app/ui/chunks/b.js', kind: 'import-statement' }] },
    'app/ui/chunks/b.js': { imports: [{ path: 'app/ui/chunks/a.js', kind: 'import-statement' }] },
    'app/ui/chunks/lazy.js': { imports: [{ path: 'app/ui/chunks/c.js', kind: 'import-statement' }] },
  } };
  const transitive = await swPrecacheDefines({ metafile, read: async () => 'x' });
  assert.deepEqual(JSON.parse(transitive.__SHELL_EXTRA__), ['/chunks/a.js', '/chunks/b.js']);
});
