// The service worker (src/ui/pwa/sw.ts) with notifications from several of the owner's PCs: a push whose id is already
// open under its tag is not shown or rung again, another id replaces it as before, and every push tells the open app
// windows to load what changed ('wf.wake'). Bundled with esbuild and run in node:vm like test/unit/pwa/sw.test.ts.
// Owns: these assertions only. Never: a real browser, push service or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const code = buildSync({ entryPoints: [path.join(root, 'src/ui/pwa/sw.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent' }).outputFiles[0].text;

interface Shown { title: string; options: { tag?: string; data?: { id?: string } } }

/** A worker whose notification tray is `tray` (showNotification adds to it) with `windows` open app windows. */
function worker(windows = 0) {
  const tray: Array<Shown & { closed: boolean }> = [];
  const posted: unknown[] = [];
  let push: ((event: Record<string, unknown>) => void) | undefined;
  const scope = {
    registration: {
      showNotification: async (title: string, options: Shown['options']) => { tray.push({ title, options, closed: false }); },
      getNotifications: async (filter: { tag?: string }) => tray.filter((n) => !n.closed && n.options.tag === filter.tag).map((n) => ({ tag: n.options.tag, data: n.options.data, close: () => { n.closed = true; } })),
    },
    clients: {
      matchAll: async () => Array.from({ length: windows }, () => ({ url: 'https://desk.example/', focus: async () => undefined, postMessage: (message: unknown) => { posted.push(message); } })),
      openWindow: async () => undefined,
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
    location: new URL('https://desk.example/sw.js'),
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => { if (type === 'push') push = fn; },
  };
  vm.runInContext(code, vm.createContext({ self: scope, URL, Response, Request, JSON, Promise, console }));
  const send = async (payload: unknown) => {
    const pending: Array<Promise<unknown>> = [];
    push!({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  };
  return { tray, posted, send };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('the same notification from a second PC (same tag, same id) does not show or ring again', async () => {
  const sw = worker();
  const payload = { kind: 'todo', title: 'Approve the invoice', body: '€120', url: '/#/day', tag: 'todo:task_9', id: 'n-1' };
  await sw.send(payload);
  await sw.send(payload);
  assert.equal(sw.tray.length, 1, 'shown once');
  assert.equal(sw.tray[0].closed, false, 'the first one stays');
  assert.deepEqual(plain(sw.tray[0].options.data), { url: '/#/day', id: 'n-1' });

  await sw.send({ ...payload, title: 'The timer rang', id: 'n-2' }); // a newer notice for the same to-do still replaces and rings
  assert.deepEqual(sw.tray.map((n) => [n.title, n.closed]), [['Approve the invoice', true], ['The timer rang', false]]);

  await sw.send({ ...payload, id: undefined, title: 'Without an id' }); // an older PC sends no id: it shows as before
  assert.equal(sw.tray.at(-1)!.title, 'Without an id');
});

test('every push wakes the open app windows, also one that was already there', async () => {
  const sw = worker(2);
  const payload = { kind: 'reply', title: 'Mia', body: 'Done', tag: 'chat:ch_1', id: 'n-1' };
  await sw.send(payload);
  await sw.send(payload);
  assert.deepEqual(plain(sw.posted), [{ type: 'wf.wake' }, { type: 'wf.wake' }, { type: 'wf.wake' }, { type: 'wf.wake' }]);
  assert.equal(sw.tray.length, 1);
});
