// The iPhone web app's service worker (src/ui/hosted/sw.ts) in node:vm, bundled with esbuild like the build does: a PC
// path reaches the shell window over a MessagePort and streams back; chunks are cache-first; main.js revalidates with
// its ETag (304 → the copy) and falls back to the copy without a tunnel; no copy and no tunnel → 503; navigations get the
// shell, a sandbox frame goes to the PC; a duplicate push is still shown, quietly; a clear still shows a notice; a tap
// opens the app's scope plus the route, never the origin root.
// Owns: these assertions. Never: a real browser or push service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ORIGIN = 'https://site.example';
const SCOPE = `${ORIGIN}/autark/app/`;
const code = buildSync({ entryPoints: [path.join(root, 'src/ui/hosted/sw.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent' }).outputFiles[0].text;

/** Values from the vm realm, compared as plain JSON. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

type Handler = (event: Record<string, unknown>) => void;
type Answer = (message: { path: string; headers: Array<[string, string]>; method: string }) => Array<Record<string, unknown>>;

function fakeCaches(seed: Record<string, Response> = {}) {
  const store = new Map<string, Response>(Object.entries(seed));
  const open = async () => ({
    match: async (key: string | { url: string }) => store.get(typeof key === 'string' ? key : key.url)?.clone(),
    put: async (key: string, response: Response) => { store.set(key, response); },
    add: async () => undefined,
  });
  return { store, caches: { open, delete: async () => true, keys: async () => [] } };
}

function worker(options: { answer?: Answer; seed?: Record<string, Response>; open?: Array<{ tag: string; data?: unknown; close(): void }> } = {}) {
  const handlers = new Map<string, Handler>();
  const asked: Array<{ path: string; headers: Array<[string, string]>; method: string }> = [];
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const posted: unknown[] = [];
  const shell = {
    id: 'c1', url: `${SCOPE}#/home`, type: 'window', focused: true,
    focus: async () => undefined,
    postMessage: (message: { type?: string; path: string; headers: Array<[string, string]>; method: string }, ports?: Array<{ postMessage(m: unknown): void }>) => {
      if (message?.type !== 'hosted.fetch') { posted.push(message); return; }
      asked.push(message);
      for (const reply of (options.answer ?? (() => [{ t: 'error', offline: true }]))(message)) ports![0].postMessage(reply);
    },
  };
  const { store, caches } = fakeCaches(options.seed);
  const scope = {
    registration: {
      scope: SCOPE,
      showNotification: async (title: string, shownOptions: Record<string, unknown>) => { shown.push({ title, options: shownOptions }); },
      getNotifications: async (filter?: { tag?: string }) => (options.open ?? []).filter((n) => !filter?.tag || n.tag === filter.tag),
    },
    clients: { get: async (id: string) => (id === 'c1' ? shell : undefined), matchAll: async () => [shell], openWindow: async (url: string) => { opened.push(url); }, claim: async () => undefined },
    skipWaiting: async () => undefined,
    location: new URL(`${SCOPE}sw.js`),
    addEventListener: (type: string, fn: Handler) => { handlers.set(type, fn); },
  };
  const shellFetch = async (input: string) => new Response(`shell ${input}`, { status: 200 });
  vm.runInContext(code, vm.createContext({ self: scope, URL, Response, Headers, ReadableStream, MessageChannel, Uint8Array, TypeError, JSON, Promise, console, caches, fetch: shellFetch, setTimeout, clearTimeout }));
  const request = (url: string, init: { mode?: string; method?: string; headers?: Record<string, string> } = {}) => ({
    url, method: init.method ?? 'GET', mode: init.mode ?? 'cors', headers: new Headers(init.headers ?? {}), arrayBuffer: async () => new ArrayBuffer(0),
  });
  const fetchVia = async (url: string, init: { mode?: string; clientId?: string } = {}): Promise<Response | undefined> => {
    let response: Promise<Response> | Response | undefined;
    handlers.get('fetch')!({ request: request(url, init), clientId: init.clientId ?? 'c1', respondWith: (value: Promise<Response> | Response) => { response = value; } });
    return response ? await response : undefined;
  };
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Array<Promise<unknown>> = [];
    handlers.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  };
  return { fetchVia, dispatch, asked, shown, opened, posted, store };
}

const okAnswer = (body: string, headers: Array<[string, string]> = []): Answer => () => [
  { t: 'head', status: 200, statusText: 'OK', headers: [['content-type', 'text/plain'], ...headers] },
  { t: 'chunk', data: new TextEncoder().encode(body.slice(0, 3)).buffer },
  { t: 'chunk', data: new TextEncoder().encode(body.slice(3)).buffer },
  { t: 'end' },
];

test('a PC path goes to the shell window over a MessagePort and streams back; root files are kept with their ETag', async () => {
  const sw = worker({ answer: okAnswer('body{color:red}', [['etag', '"v1"']]) });
  const response = await sw.fetchVia(`${SCOPE}main.css`);
  assert.equal(response?.status, 200);
  assert.equal(await response!.text(), 'body{color:red}');
  assert.equal(sw.asked[0].path, '/main.css', 'the PC\'s own path');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(sw.store.has(`${SCOPE}main.css`), 'kept for an offline start');
  const rpc = worker({ answer: okAnswer('{"id":1}') });
  assert.equal(await (await rpc.fetchVia(`${SCOPE}rpc`))!.text(), '{"id":1}');
  assert.equal(rpc.store.size, 0, '/rpc is never cached');
});

test('chunks are cache-first; main.js revalidates (304 → copy) and falls back to its copy without a tunnel; else 503', async () => {
  const seed = { [`${SCOPE}chunks/a-X.js`]: new Response('chunk'), [`${SCOPE}main.js`]: new Response('old main', { headers: { etag: '"v1"' } }) };
  const cached = worker({ seed, answer: () => [{ t: 'head', status: 304, headers: [] }, { t: 'end' }] });
  assert.equal(await (await cached.fetchVia(`${SCOPE}chunks/a-X.js`))!.text(), 'chunk');
  assert.equal(cached.asked.length, 0, 'no round trip for an immutable chunk');
  assert.equal(await (await cached.fetchVia(`${SCOPE}main.js`))!.text(), 'old main');
  assert.deepEqual(plain(cached.asked[0].headers.find(([name]) => name === 'If-None-Match')), ['If-None-Match', '"v1"']);
  const offline = worker({ seed });
  assert.equal(await (await offline.fetchVia(`${SCOPE}main.js`))!.text(), 'old main', 'no tunnel: the copy');
  const none = worker();
  const missing = await none.fetchVia(`${SCOPE}main.js`);
  assert.equal(missing!.status, 503);
  assert.match(await missing!.text(), /not reachable/);
});

test('navigations get the shell; a sandbox frame is the PC\'s; other origins and paths are not touched', async () => {
  const sw = worker({ answer: okAnswer('<html>app</html>') });
  assert.equal(await (await sw.fetchVia(`${SCOPE}#/chat/c1`, { mode: 'navigate' }))!.text(), `shell ${SCOPE}`);
  assert.equal(await (await sw.fetchVia(`${SCOPE}settings`, { mode: 'navigate' }))!.text(), `shell ${SCOPE}`);
  assert.equal(await (await sw.fetchVia(`${SCOPE}sandbox/app?m=x&i=0`, { mode: 'navigate', clientId: '' }))!.text(), '<html>app</html>');
  assert.equal(sw.asked.at(-1)!.path, '/sandbox/app?m=x&i=0');
  assert.equal(await sw.fetchVia(`${ORIGIN}/autark/download/`), undefined);
  assert.equal(await sw.fetchVia('https://other.example/autark/app/main.js'), undefined);
});

test('pushes always show a notice on iOS: a duplicate quietly, a clear quietly; a tap opens the scope plus the route', async () => {
  const closed: string[] = [];
  const open = [{ tag: 'chat:c1', data: { id: 'n1' }, close: () => closed.push('chat:c1') }];
  const sw = worker({ open });
  const push = (payload: unknown) => sw.dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  await push({ title: 'Mara', body: 'Done', tag: 'chat:c1', id: 'n1', url: '/#/chat/c1' });
  assert.equal(sw.shown.length, 1, 'shown although another PC showed it already');
  assert.equal(sw.shown[0].options.silent, true);
  assert.equal(sw.shown[0].options.renotify, false);
  assert.equal(sw.shown[0].options.icon, '/autark/app/app-icon.png');
  await push({ clear: 'chat:c1', tag: 'chat:c1', title: 'Mara', body: 'Done', silent: true });
  assert.equal(sw.shown.length, 2, 'a clear still shows a notice (iOS revokes silent pushes)');
  assert.ok(closed.length >= 2);
  assert.deepEqual(sw.posted.filter((m) => (m as { type?: string }).type === 'wf.wake').length, 2, 'every push wakes the shell');
  await sw.dispatch('notificationclick', { notification: { data: { url: '/#/chat/c9' }, close: () => undefined } });
  assert.deepEqual(plain(sw.posted.at(-1)), { type: 'wf.navigate', url: `${SCOPE}#/chat/c9` });
});
