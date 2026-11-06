// Service worker of the Workforce PWA (served by the runtime at /sw.js, built to app/ui/sw.js).
// Owns: app-shell caching, offline fallback for navigation, the offline "For you" snapshot
// endpoint (/offline/todos.json from IndexedDB), Web Push display and notification clicks.
// The shell it precaches at install is index.html, main.js, main.css and – filled in by the build
// (scripts/sw-precache.mjs → esbuild define) – every chunk main.js imports statically, under a
// cache name that changes with them, so the app boots offline even if no page was controlled yet.
// In such a build main.js and those files are one set per worker: install fails rather than keep
// a part of it, and they are served from this worker's cache only (a newer build installs a newer
// worker), so a background refresh never puts a main.js next to chunks it does not import.
// Pushes (sw-notify.ts): a notice already open under its tag with the same id (the same notification pushed by another of
// the owner's PCs) is not shown or rung again, every push tells the open app windows to load what changed ('wf.wake'),
// and a push `{clear: tag}` (read on some device, runtime/pwa/read-clear.ts) closes that tag's notices and shows nothing.
// Never: caches RPC/WebSocket traffic, files or anything authenticated; never stores tokens.

import { idbGet, idbSet, TODO_SNAPSHOT_KEY } from './idb.ts';
import { wireNotifications, type NotifyScope } from './sw-notify.ts';

export {}; // module scope: keep these local declarations out of the global namespace

// The UI tsconfig has no WebWorker lib (it would clash with DOM), so the few service worker
// types used here are declared minimally.
interface ExtendableEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(response: Response | Promise<Response>): void }
interface ExtendableMessageEvent extends ExtendableEvent { data: unknown }
interface WindowClientLike { url: string; focus(): Promise<unknown>; navigate?(url: string): Promise<unknown>; postMessage(message: unknown): void }
interface SwScope {
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  location: Location;
  navigator?: unknown;
  addEventListener(type: 'install' | 'activate', fn: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', fn: (event: ExtendableMessageEvent) => void): void;
}

/** Set by the build (scripts/sw-precache.mjs): main.js's static chunks and an id that changes with them. */
declare const __SHELL_EXTRA__: readonly string[] | undefined;
declare const __BUILD_ID__: string | undefined;

const sw = self as unknown as SwScope;
const BUILT = typeof __BUILD_ID__ === 'string';
const CACHE = `workforce-shell-${BUILT ? __BUILD_ID__ : 'v1'}`;
const EXTRA: readonly string[] = typeof __SHELL_EXTRA__ !== 'undefined' && Array.isArray(__SHELL_EXTRA__) ? __SHELL_EXTRA__ : [];
/** What main.js needs to run – exactly the files the build id covers (none without a build id). */
const BOOT = new Set(BUILT ? ['/main.js', ...EXTRA] : []);
const SHELL = [...new Set(['/', '/index.html', '/main.js', '/main.css', '/manifest.webmanifest', '/icon.png', ...EXTRA])];
/** Paths that must always go to the network (live data, auth, uploads). */
const NEVER_CACHE = [/^\/rpc/, /^\/ws/, /^\/files\//, /^\/api\//, /^\/pair/, /^\/sandbox\//];

sw.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll fails on one 404; add individually so a missing optional file is not fatal. A missing
    // boot file is: the active worker (with its complete set) stays, and the browser tries again.
    await Promise.all(SHELL.map((url) => cache.add(url).catch((error: unknown) => { if (BOOT.has(url)) throw error; })));
    await sw.skipWaiting();
  })());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await sw.clients.claim();
  })());
});

async function offlineTodos(): Promise<Response> {
  const snapshot = await idbGet<unknown>(TODO_SNAPSHOT_KEY).catch(() => undefined);
  return new Response(JSON.stringify(snapshot ?? { at: 0, items: [] }), { headers: { 'content-type': 'application/json' } });
}

async function networkFirstShell(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put('/index.html', response.clone()).catch(() => undefined);
    return response;
  } catch {
    return (await caches.match('/index.html')) ?? new Response('Offline', { status: 503 });
  }
}

/** main.js and its static chunks of this build: this worker's cache first, never refreshed in place. */
async function bootFile(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => undefined);
  return response;
}

/** Static assets: serve from cache, refresh in the background (stale-while-revalidate). */
async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => undefined);
    return response;
  });
  if (cached) {
    refresh.catch(() => undefined);
    return cached;
  }
  return refresh;
}

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname === '/offline/todos.json') return event.respondWith(offlineTodos());
  if (NEVER_CACHE.some((pattern) => pattern.test(url.pathname))) return;
  if (request.mode === 'navigate') return event.respondWith(networkFirstShell(request));
  if (BOOT.has(url.pathname)) return event.respondWith(bootFile(request));
  if (/\.(js|css|png|svg|woff2|webmanifest)$/.test(url.pathname)) event.respondWith(staleWhileRevalidate(request));
});

sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string; items?: unknown[]; at?: number } | null;
  if (data?.type === 'wf.snapshot' && Array.isArray(data.items)) {
    event.waitUntil(idbSet(TODO_SNAPSHOT_KEY, { at: data.at ?? Date.now(), items: data.items }));
  }
});

// Push, notice taps and clears (shared with the iPhone web app's worker, which always shows a notice).
wireNotifications(sw as unknown as NotifyScope, { home: '/', icon: '/icon.png', alwaysShow: false });
