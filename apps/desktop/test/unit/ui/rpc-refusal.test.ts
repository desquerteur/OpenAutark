// Review #19 (DEV4): a removed phone keeps saying "This phone was removed." (4403). The runtime
// closes its live socket with 4403 but refuses the token's later Hellos with 4401 ("no longer
// paired"); the client (lib/refusal.ts via lib/rpc.ts) keeps 4403 for that token across reconnects
// and reloads, a newly paired token gets its own 4401 again, and an answer clears it. A refused
// socket opens and closes, so only an answer resets the reconnect backoff.
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { REVOKED_KEY, RefusalMemory, tokenMark } from '../../../src/ui/lib/refusal.ts';
import type { MarkStorage } from '../../../src/ui/lib/refusal.ts';

class MapStorage implements MarkStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}

test('RefusalMemory: 4403 sticks for the revoked token (reloads too), another token reads 4401 again', () => {
  const storage = new MapStorage();
  const page = new RefusalMemory(() => storage);
  assert.equal(page.closed(4401, 'tok_a'), 4401, 'never revoked: no longer paired');
  assert.equal(page.closed(1006, 'tok_a'), null, 'not a refusal');
  assert.equal(page.closed(4403, 'tok_a'), 4403);
  assert.equal(page.closed(4401, 'tok_a'), 4403, 'the reconnect after a removal is still "removed"');
  assert.equal(new RefusalMemory(() => storage).closed(4401, 'tok_a'), 4403, 'after a reload as well');
  assert.equal(page.closed(4401, 'tok_b'), 4401, 'paired again: a new token starts clean');
  assert.equal(page.closed(4401, ''), 4401, 'no token: never "removed"');
  const stored = storage.getItem(REVOKED_KEY) ?? '';
  assert.equal(stored, tokenMark('tok_a'));
  assert.ok(!stored.includes('tok_a'), 'only a fingerprint is stored, never the token');
  assert.notEqual(tokenMark('tok_a'), tokenMark('tok_b'));

  page.answered();
  assert.equal(storage.getItem(REVOKED_KEY), null);
  assert.equal(page.closed(4401, 'tok_a'), 4401);
});

test('RefusalMemory: blocked storage still keeps 4403 for this page', () => {
  const blocked = () => { throw new Error('SecurityError'); };
  const page = new RefusalMemory(() => ({ getItem: blocked, setItem: blocked, removeItem: blocked }));
  assert.equal(page.closed(4403, 'tok_a'), 4403);
  assert.equal(page.closed(4401, 'tok_a'), 4403);
  const none = new RefusalMemory(() => null);
  assert.equal(none.closed(4403, 'tok_a'), 4403);
  assert.equal(none.closed(4401, 'tok_a'), 4403);
});

// ------------------------------------------------------------------ the RPC client itself

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { /* the test closes it */ }
  hello(): { token?: string } { return JSON.parse(this.sent[0] ?? '{}') as { token?: string }; }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1];

test('rpc: a removed phone stays "removed" through reconnects and a reload; backoff grows until an answer', async (t) => {
  const storage = new MapStorage();
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document, location: globals.location, history: globals.history, WebSocket: globals.WebSocket, localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  globals.window = { addEventListener: () => undefined };
  globals.document = { addEventListener: () => undefined, visibilityState: 'visible' };
  globals.location = { protocol: 'http:', host: '127.0.0.1:7', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, enumerable: true, get: () => storage });
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    mock.timers.reset();
    for (const key of ['window', 'document', 'location', 'history', 'WebSocket'] as const) {
      if (saved[key] === undefined) delete globals[key];
      else globals[key] = saved[key];
    }
    if (saved.localStorage) Object.defineProperty(globalThis, 'localStorage', saved.localStorage);
    else delete globals.localStorage;
  });
  const load = async (instance: string) => (await import(new URL(`../../../src/ui/lib/rpc.ts?${instance}`, import.meta.url).href)) as RpcModule;

  storage.setItem('wf.token', 'tok_removed');
  const page = (await load('page')).rpc;
  page.start();
  const first = last();
  assert.equal(first.url, 'ws://127.0.0.1:7/ws');
  first.onopen!();
  assert.equal(first.hello().token, 'tok_removed');
  await flush();
  first.onclose!({ code: 4403 }); // the owner pressed Remove while the phone was connected
  assert.equal(page.refused.value, 4403);

  mock.timers.tick(499);
  assert.equal(FakeSocket.all.length, 1);
  mock.timers.tick(1);
  const second = last();
  assert.notEqual(second, first);
  second.onopen!();
  await flush();
  second.onclose!({ code: 4401 }); // what the runtime answers a revoked token's Hello
  assert.equal(page.refused.value, 4403, 'still "This phone was removed.", not "This device is no longer paired."');

  // The refused socket had opened, but the runtime never answered: the delay keeps growing.
  mock.timers.tick(999);
  assert.equal(FakeSocket.all.length, 2, 'no reconnect every 500 ms');
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, 3); // left connecting, so this instance makes no further sockets

  // A reload: a fresh client with the same storage.
  const reloaded = (await load('reload')).rpc;
  reloaded.start();
  const third = last();
  third.onopen!();
  assert.equal(third.hello().token, 'tok_removed');
  await flush();
  third.onclose!({ code: 4401 });
  assert.equal(reloaded.refused.value, 4403, 'the reload still says the phone was removed');

  // Paired again (pwa/install.ts stores a new token): 4401 means phone access is off again.
  storage.setItem('wf.token', 'tok_new');
  mock.timers.tick(500);
  const fourth = last();
  fourth.onopen!();
  assert.equal(fourth.hello().token, 'tok_new');
  await flush();
  fourth.onclose!({ code: 4401 });
  assert.equal(reloaded.refused.value, 4401);

  // Phone access on again: the runtime answers, which clears the refusal and resets the backoff.
  mock.timers.tick(1000);
  const fifth = last();
  fifth.onopen!();
  await flush();
  fifth.onmessage!({ data: JSON.stringify({ event: 'session.changed', data: {} }) });
  assert.equal(reloaded.refused.value, null);
  assert.equal(storage.getItem(REVOKED_KEY), null, 'the old marker is dropped once a token works');
  fifth.onclose!({ code: 1006 });
  const before = FakeSocket.all.length;
  mock.timers.tick(500);
  assert.equal(FakeSocket.all.length, before + 1, 'an accepted connection reconnects after 500 ms');
});
