// Desktop runtime port: the preload's main-world guard (capture listener that swallows port
// messages, one-shot claimConnector handing ports to a callback, public connect() rejecting
// after the claim), the plain contract fallback (connect() → Promise<void>, the port arrives as
// a PORT_MESSAGE window message), the RuntimePort wrapper (built-ins captured at load: later
// MessagePort/MessageEvent/Promise/`then` patches never see the live port) and when a runtime
// status means "reconnect".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PORT_MESSAGE } from '../../../src/shared/api/desktop.ts';
import type { WorkforceDesktopApi } from '../../../src/shared/api/desktop.ts';
import { installMainWorld } from '../../../src/preload/main-world.ts';
import type { PortConnector } from '../../../src/preload/main-world.ts';
import { RuntimeEpochs, claimConnector, guardPort, requestPort } from '../../../src/ui/lib/runtime-port.ts';
import type { PortHost, PortMessageEvent, RuntimePort } from '../../../src/ui/lib/runtime-port.ts';

const TAG = `${PORT_MESSAGE}:0123456789abcdef`;

type FakePage = EventTarget & { postMessage(data: unknown, origin: string, transfer?: MessagePort[]): void; workforce?: Record<string, unknown> };

/**
 * A page window with the preload's main-world wrapper installed. `deliver` decides what the
 * preload posts for each connect(): the real tagged port (default), nothing, or a rejection.
 * The arrival window is generous so a loaded test machine never times out a delivered port.
 * `premade` channels are used first (Node sets a new port up through the public
 * addEventListener, which a patch test must not mistake for a leak).
 */
function guardedPage(deliver: 'port' | 'nothing' | 'reject' = 'port', arrivalMs = 2_000, premade: MessageChannel[] = []) {
  const page = new EventTarget() as FakePage;
  // window.postMessage dispatches asynchronously, like a browser task.
  page.postMessage = (data, _origin, transfer = []) => { setImmediate(() => page.dispatchEvent(new MessageEvent('message', { data, ports: transfer }))); };
  const opened: MessagePort[] = [];
  const bridge = {
    platform: 'win32',
    connect: async () => {
      if (deliver === 'reject') throw new Error('The runtime is not running.');
      if (deliver === 'nothing') return;
      const { port1, port2 } = premade.shift() ?? new MessageChannel();
      opened.push(port1, port2);
      page.postMessage(TAG, '*', [port1]);
    },
  } as unknown as WorkforceDesktopApi;
  const global = globalThis as Record<string, unknown>;
  const previous = global.window;
  global.window = page;
  try { installMainWorld(bridge, PORT_MESSAGE, TAG, arrivalMs); } finally { global.window = previous; }
  // Page code loaded after the preload: listens to every message, capture and bubble.
  const seen: unknown[] = [];
  page.addEventListener('message', (event) => seen.push((event as MessageEvent).data), true);
  page.addEventListener('message', (event) => seen.push((event as MessageEvent).data));
  const api = page.workforce as unknown as { connect(): Promise<MessagePort>; claimConnector(): PortConnector };
  const closeAll = () => { for (const port of opened) port.close(); };
  return { page, api, seen, opened, closeAll };
}

/** One request through a claimed connector, as a Promise (test side only). */
function open(connector: PortConnector): Promise<MessagePort> {
  return new Promise((resolve, reject) => connector((port, error) => { if (port) resolve(port); else reject(error); }));
}

/** Proves `wrapped` is the RuntimePort of the channel whose other end is `other`: a frame each way. */
async function roundTrip(wrapped: RuntimePort, other: MessagePort, post = MessagePort.prototype.postMessage, listen = EventTarget.prototype.addEventListener): Promise<void> {
  const inbound = new Promise<unknown>((resolve) => { wrapped.onmessage = (event) => resolve(event.data); });
  wrapped.start();
  post.call(other, { id: 1, result: 'from runtime' });
  assert.deepEqual(await inbound, { id: 1, result: 'from runtime' });
  const read = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!;
  const outbound = new Promise<unknown>((resolve) => { listen.call(other, 'message', (event: Event) => resolve(read.call(event))); });
  MessagePort.prototype.start.call(other);
  wrapped.postMessage({ id: 2, method: 'ping' });
  assert.deepEqual(await outbound, { id: 2, method: 'ping' });
}

test('main-world guard: page listeners never see a runtime port; the public connect() works until claimed', async () => {
  const { api, seen, opened, closeAll } = guardedPage();
  try {
    const port = await api.connect();
    assert.ok(port instanceof MessagePort);
    assert.equal(port, opened[0]);
    assert.deepEqual(seen, [], 'no page listener saw the port message');
  } finally { closeAll(); }
});

test('main-world guard: claimConnector is one-shot; afterwards the public connect() rejects', async () => {
  const { api, seen, opened, closeAll } = guardedPage();
  try {
    const connector = api.claimConnector();
    assert.equal(typeof connector, 'function');
    assert.throws(() => api.claimConnector(), /already claimed/);
    await assert.rejects(api.connect(), /belongs to the app window/);
    assert.equal(opened.length, 0, 'a rejected connect() never asked main');
    const [first, second] = await Promise.all([open(connector), open(connector)]);
    assert.notEqual(first, second, 'one request at a time, each gets its own port');
    assert.deepEqual([first, second], [opened[0], opened[2]]);
    assert.deepEqual(seen, []);
  } finally { closeAll(); }
});

test('main-world guard: a port a page script posts itself is swallowed and closed', async () => {
  const { page, api, seen, closeAll } = guardedPage();
  const fake = new MessageChannel();
  try {
    const closed = once(fake.port2, 'close');
    page.postMessage(PORT_MESSAGE, '*', [fake.port1]);
    await closed; // the guard closed the injected port
    const port = await open(api.claimConnector());
    assert.notEqual(port, fake.port1, 'the connector only takes the preload-tagged port');
    assert.deepEqual(seen, []);
  } finally { fake.port1.close(); fake.port2.close(); closeAll(); }
});

test('main-world guard: a MessageEvent.ports patch made after install never sees the port', async () => {
  const { api, closeAll } = guardedPage();
  const original = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'ports')!;
  const leaked: unknown[] = [];
  Object.defineProperty(MessageEvent.prototype, 'ports', {
    configurable: true,
    enumerable: original.enumerable,
    get(this: MessageEvent) { const ports = original.get!.call(this); leaked.push(...ports); return ports; },
  });
  try {
    const port = await open(api.claimConnector());
    assert.ok(port instanceof MessagePort);
    assert.deepEqual(leaked, []);
  } finally {
    Object.defineProperty(MessageEvent.prototype, 'ports', original);
    closeAll();
  }
});

test('main-world guard: connect() failure and a missing port both reject', async () => {
  const failing = guardedPage('reject');
  await assert.rejects(open(failing.api.claimConnector()), /not running/);
  const silent = guardedPage('nothing', 5);
  const connector = silent.api.claimConnector();
  await assert.rejects(open(connector), /did not arrive/);
  // The queue keeps working after a failure.
  await assert.rejects(open(connector), /did not arrive/);
});

function fakeHost() {
  const listeners = new Set<(event: PortMessageEvent) => void>();
  const host: PortHost = {
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  const post = (event: PortMessageEvent) => { for (const listener of [...listeners]) listener(event); };
  return { host, listeners, post };
}

test('guardPort: only a real MessagePort is wrapped; the wrapper has no prototype and no raw port', () => {
  assert.throws(() => guardPort({ postMessage() {}, start() {} }), /not a MessagePort/);
  assert.throws(() => guardPort(undefined), /not a MessagePort/);
  const channel = new MessageChannel();
  try {
    const wrapped = guardPort(channel.port1);
    assert.equal(Object.getPrototypeOf(wrapped), null);
    assert.equal((wrapped as unknown as { then?: unknown }).then, undefined);
    for (const key of Object.keys(wrapped)) assert.notEqual((wrapped as unknown as Record<string, unknown>)[key], channel.port1, key);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test('requestPort: resolves with the posted port from this window only', async () => {
  const { host, listeners, post } = fakeHost();
  const self = {};
  const channel = new MessageChannel();
  const other = new MessageChannel();
  try {
    const request = requestPort(async () => {
      post({ source: {}, data: PORT_MESSAGE, ports: [other.port1] }); // another window
      post({ source: self, data: 'other', ports: [other.port1] }); // another message
      post({ source: self, data: PORT_MESSAGE, ports: [channel.port1] });
    }, host, self);
    await roundTrip(await request, channel.port2);
    assert.equal(listeners.size, 0, 'listener removed');
  } finally {
    for (const port of [channel.port1, channel.port2, other.port1, other.port2]) port.close();
  }
});

test('requestPort: the port may arrive before connect() resolves (main-world wrapper order)', async () => {
  const { host, post } = fakeHost();
  const self = {};
  const channel = new MessageChannel();
  try {
    let resolveConnect: () => void = () => {};
    const request = requestPort(() => new Promise<void>((resolve) => { resolveConnect = resolve; }), host, self, 5);
    post({ source: self, data: PORT_MESSAGE, ports: [channel.port1] });
    resolveConnect();
    await roundTrip(await request, channel.port2);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test('requestPort: connect() failure and a missing port both reject and clean up', async () => {
  const failing = fakeHost();
  await assert.rejects(requestPort(async () => { throw new Error('The runtime is not running.'); }, failing.host, {}), /not running/);
  assert.equal(failing.listeners.size, 0);

  const silent = fakeHost();
  await assert.rejects(requestPort(async () => undefined, silent.host, {}, 5), /did not arrive/);
  assert.equal(silent.listeners.size, 0);
});

test('RuntimeEpochs: the boot "up" keeps the port, a restart "up" reconnects', () => {
  const epochs = new RuntimeEpochs();
  // Boot: starting → port opened → up (arrives with the very port we use).
  assert.equal(epochs.status({ state: 'starting' }, false), false);
  epochs.opened();
  assert.equal(epochs.status({ state: 'up' }, true), false);
  // A second 'up' without a restart in between changes nothing.
  assert.equal(epochs.status({ state: 'up' }, true), false);
  // Restart: the old port may still look open (no close event) – 'up' must reconnect.
  assert.equal(epochs.status({ state: 'restarting', inMs: 500 }, true), false);
  assert.equal(epochs.status({ state: 'up' }, true), true);
  // After reconnecting in the new epoch, nothing more to do.
  epochs.opened();
  assert.equal(epochs.status({ state: 'up' }, true), false);
  // Not connected at all (the retry backoff is waiting): 'up' connects right away.
  assert.equal(epochs.status({ state: 'stopped' }, false), false);
  assert.equal(epochs.status({ state: 'up' }, false), true);
});

test('requestPort: a port that connect() resolves with is taken at once', async () => {
  const { host, listeners } = fakeHost();
  const channel = new MessageChannel();
  try {
    await roundTrip(await requestPort(async () => channel.port1, host, {}, 5), channel.port2);
    assert.equal(listeners.size, 0);
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});

test('RuntimeEpochs: a port opened before the late boot "starting" survives the first "up"', () => {
  // Cold launch: main hands out a port while the runtime boots, then (window loaded) sends
  // 'starting', then 'up'. The port belongs to the booting runtime – no reconnect.
  const epochs = new RuntimeEpochs();
  epochs.opened();
  assert.equal(epochs.status({ state: 'starting' }, true), false);
  assert.equal(epochs.status({ state: 'up' }, true), false);
  // A real restart still reconnects, also when 'starting' sits between 'restarting' and 'up'.
  assert.equal(epochs.status({ state: 'restarting', inMs: 500 }, true), false);
  assert.equal(epochs.status({ state: 'starting' }, true), false);
  assert.equal(epochs.status({ state: 'up' }, true), true);
});

// Last: claiming sets the UI's module state (requestPort uses the claimed connector from then on).
test('claimConnector: no connector on the bridge keeps the plain contract; a taken one throws', () => {
  assert.equal(claimConnector(undefined), false);
  assert.equal(claimConnector({ connect: async () => undefined }), false);
  const { api } = guardedPage();
  api.claimConnector(); // someone else came first
  assert.throws(() => claimConnector(api), /already claimed/);
});

test('claimConnector: after the UI claimed it, requestPort gets ports only from the connector', async () => {
  const { api, seen, opened, closeAll } = guardedPage();
  try {
    assert.equal(claimConnector(api), true);
    const { host, listeners } = fakeHost();
    let publicCalls = 0;
    const port = await requestPort(() => { publicCalls++; return api.connect(); }, host, {});
    await roundTrip(port, opened[1]);
    assert.equal(publicCalls, 0, 'the public connect() is not used');
    assert.equal(listeners.size, 0, 'no window listener needed');
    await assert.rejects(api.connect(), /belongs to the app window/, 'page code cannot open a port any more');
    assert.deepEqual(seen, []);
  } finally { closeAll(); }
});

/**
 * Page code that patches built-ins after the UI loaded: MessagePort methods, the MessageEvent
 * data getter, addEventListener, Promise.prototype.then/constructor and an Object.prototype
 * `then` getter all record what they see; the patched Promise paths are then asked for their
 * values (an attacker would call the original `then` on them).
 */
function patchBuiltIns() {
  const seenThis: unknown[] = [];
  const promises: Array<Promise<unknown>> = [];
  const originals: Array<[object, string, PropertyDescriptor | undefined]> = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor) => {
    originals.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };
  const wrap = (target: object, key: string) => {
    const original = (target as Record<string, (...args: unknown[]) => unknown>)[key];
    patch(target, key, { writable: true, value: function (this: unknown, ...args: unknown[]) { seenThis.push(this); return Reflect.apply(original, this, args); } });
  };
  for (const key of ['postMessage', 'start', 'close']) wrap(MessagePort.prototype, key);
  wrap(EventTarget.prototype, 'addEventListener');
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!;
  patch(MessageEvent.prototype, 'data', { enumerable: data.enumerable, get(this: MessageEvent) { seenThis.push(Reflect.apply(Object.getOwnPropertyDescriptor(Event.prototype, 'target')!.get!, this, [])); return data.get!.call(this); } });
  const then = Promise.prototype.then;
  patch(Promise.prototype, 'then', { writable: true, value: function (this: Promise<unknown>, ...args: unknown[]) { promises.push(this); return Reflect.apply(then, this, args); } });
  patch(Promise.prototype, 'constructor', { get(this: Promise<unknown>) { promises.push(this); return Promise; } });
  patch(Object.prototype, 'then', { get(this: unknown) { seenThis.push(this); return undefined; } });
  const restore = () => {
    for (const [target, key, descriptor] of originals.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete (target as Record<string, unknown>)[key];
    }
  };
  /** Everything the patches saw, plus the values of every promise they were handed. */
  const collect = async (): Promise<unknown[]> => {
    const values: unknown[] = [...seenThis];
    for (const promise of promises) Reflect.apply(then, promise, [(value: unknown) => { values.push(value); }, () => undefined]);
    await new Promise((resolve) => setImmediate(resolve));
    return values;
  };
  return { restore, collect };
}

test('RuntimePort: page code patching built-ins after load never sees the live port or its wrapper', async () => {
  const { api, opened, closeAll } = guardedPage('port', 2_000, [new MessageChannel()]);
  const post = MessagePort.prototype.postMessage;
  const listen = EventTarget.prototype.addEventListener;
  assert.equal(claimConnector(api), true);
  const { host } = fakeHost();
  const patches = patchBuiltIns();
  let restored = false;
  try {
    const port = await requestPort(() => api.connect(), host, {});
    const raw = opened.at(-2)!;
    await roundTrip(port, opened.at(-1)!, post, listen);
    port.close();
    patches.restore();
    restored = true;
    const values = await patches.collect();
    assert.equal(values.includes(raw), false, 'the raw runtime port leaked to a patched built-in');
    assert.equal(values.includes(port), false, 'the RuntimePort leaked to a patched built-in');
  } finally {
    if (!restored) patches.restore();
    closeAll();
  }
});
