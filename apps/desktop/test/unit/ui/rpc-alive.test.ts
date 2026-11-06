// Socket liveness on return (lib/rpc.ts checkAlive): a phone back from the background can hold a
// half-open WebSocket – events stop, calls hang. When the page comes back (visible, pageshow,
// online, a push via pwa/install.ts), a socket that is not open connects at once; an open one only
// probes `session.info`; no answer in 3 s closes it and connects again with the backoff reset;
// one probe at a time. The desktop port: rpc-alive-desktop.test.ts.
// Owns: these assertions only. Never: a real socket, browser or runtime.

import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

interface Frame { id?: number; method?: string }

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Frame[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Frame); }
  close() { this.closed = true; }
  probes(): Frame[] { return this.sent.filter((frame) => frame.method === 'session.info'); }
  answer(id: number | undefined) { this.onmessage?.({ data: JSON.stringify({ id, result: { kind: 'device', capabilities: [], secure: true, allowedMethods: [] } }) }); }
}

type RpcModule = typeof import('../../../src/ui/lib/rpc.ts');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const last = () => FakeSocket.all[FakeSocket.all.length - 1];
let instance = 0;

/** A fresh client on a fake page; `fire` sends a page event, `opened` opens the newest socket. */
async function page(t: TestContext) {
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'location', 'history', 'WebSocket'] as const;
  const saved = keys.map((key) => [key, globals[key]] as const);
  const windowListeners = new Map<string, () => void>();
  const doc = { visibilityState: 'visible', listeners: new Map<string, () => void>(), addEventListener(type: string, fn: () => void) { this.listeners.set(type, fn); } };
  globals.window = { addEventListener: (type: string, fn: () => void) => { windowListeners.set(type, fn); } };
  globals.document = doc;
  globals.location = { protocol: 'https:', host: 'phone.test', hash: '', pathname: '/', search: '' };
  globals.history = { replaceState: () => undefined };
  globals.WebSocket = FakeSocket;
  FakeSocket.all = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    mock.timers.reset();
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });
  const mod = (await import(new URL(`../../../src/ui/lib/rpc.ts?alive-${instance++}`, import.meta.url).href)) as RpcModule;
  const fire = (type: 'visibilitychange' | 'pageshow' | 'online') => (type === 'visibilitychange' ? doc.listeners : windowListeners).get(type)!();
  const opened = async () => { const socket = last(); socket.onopen!(); await flush(); return socket; };
  mod.rpc.start();
  return { mod, rpc: mod.rpc, doc, fire, opened };
}

test('visible with a dead socket: connects at once, with the backoff back at 500 ms', async (t) => {
  const { rpc, doc, fire, opened } = await page(t);
  const first = await opened();
  first.onclose!({ code: 1006 }); // the OS finally reported the drop; the next try waits 500 ms, then 1 s
  assert.equal(rpc.status.value, 'closed');

  doc.visibilityState = 'hidden';
  fire('visibilitychange');
  assert.equal(FakeSocket.all.length, 1, 'hidden: nothing happens');

  doc.visibilityState = 'visible';
  fire('visibilitychange');
  assert.equal(FakeSocket.all.length, 2, 'visible: a new socket right away, no waiting for the timer');
  assert.equal(last().url, 'wss://phone.test/ws');
  assert.equal(first.probes().length, 0, 'a closed socket is never probed');

  const second = await opened();
  assert.equal(rpc.status.value, 'open');
  second.onclose!({ code: 1006 });
  mock.timers.tick(499);
  assert.equal(FakeSocket.all.length, 2);
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, 3, 'the backoff was reset to 500 ms (else 1 s)');
});

test('visible with a live socket: only a probe, the socket stays', async (t) => {
  const { mod, rpc, fire, opened } = await page(t);
  const socket = await opened();
  let reloads = 0;
  rpc.onOpen(() => { reloads += 1; });

  fire('visibilitychange');
  assert.equal(socket.probes().length, 1);
  socket.answer(socket.probes()[0].id);
  await flush();
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 1, 'answered: no new socket');
  assert.equal(socket.closed, false);
  assert.equal(rpc.status.value, 'open');
  assert.equal(reloads, 0, 'no reload for a live socket');

  for (const check of [() => fire('pageshow'), () => fire('online'), () => mod.checkAlive()]) { // a push ('wf.wake') runs checkAlive
    const before = socket.probes().length;
    check();
    assert.equal(socket.probes().length, before + 1, 'each return probes again once the last one answered');
    socket.answer(socket.probes()[before].id);
    await flush();
  }
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 1);
});

test('a probe without an answer in 3 s: the socket counts as dead, calls reject, a new one connects at once', async (t) => {
  const { rpc, fire, opened } = await page(t);
  const first = await opened();
  first.onclose!({ code: 1006 });
  mock.timers.tick(500);
  const half = await opened(); // never answers anything: the backoff stays grown (1 s, next 2 s)
  let reloads = 0;
  rpc.onOpen(() => { reloads += 1; });
  const hanging = rpc.call('devices.list');

  fire('pageshow');
  assert.equal(half.probes().length, 1);
  mock.timers.tick(2_999);
  assert.equal(FakeSocket.all.length, 2, 'still within 3 s');
  assert.equal(half.closed, false);
  mock.timers.tick(1);
  assert.equal(half.closed, true, 'the stale socket is closed');
  assert.equal(half.onmessage, null, 'and late frames from it are dropped');
  assert.equal(FakeSocket.all.length, 3, 'a new socket at once');
  assert.equal(rpc.status.value, 'connecting');
  await assert.rejects(hanging, (error: { code?: string }) => error.code === 'unavailable', 'the hanging call rejects instead of hanging');

  const fresh = await opened();
  assert.equal(reloads, 1, 'onOpen → store.loadAll brings the screen up to date');
  half.onclose?.({ code: 1006 }); // the OS reports the old one late: nothing changes
  assert.equal(rpc.status.value, 'open');
  fresh.onclose!({ code: 1006 });
  mock.timers.tick(499);
  assert.equal(FakeSocket.all.length, 3);
  mock.timers.tick(1);
  assert.equal(FakeSocket.all.length, 4, 'the backoff was reset to 500 ms (else 2 s)');
});

test('one probe at a time: visible, pageshow, online and a push together send one probe and reconnect once', async (t) => {
  const { mod, fire, opened } = await page(t);
  const socket = await opened();
  fire('visibilitychange');
  fire('pageshow');
  fire('online');
  mod.checkAlive();
  assert.equal(socket.probes().length, 1);
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 2, 'one reconnect');
  fire('visibilitychange');
  mock.timers.tick(3_000);
  assert.equal(FakeSocket.all.length, 2, 'while the new socket connects, nothing more starts');
});
