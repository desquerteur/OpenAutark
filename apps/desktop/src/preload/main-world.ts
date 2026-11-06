// The preload's main-world wrapper around `window.workforce` (installed by preload/index.ts
// with contextBridge.executeInMainWorld before any page script runs). Guards the runtime port:
// - a capture-phase 'message' listener, registered first, swallows every port message
//   (stopImmediatePropagation): no other listener in the page ever sees a runtime port;
// - claimConnector() is one-shot: the UI boot claims it before any other code loads and gets the
//   only function that opens runtime ports; afterwards the public connect() rejects.
// The port message carries a per-page secret tag, so a page script cannot post a fake port
// either. The intrinsics the listener uses are captured up front, so patching them later does
// not open the swallow/tag check, and the claimed connector hands the port to a callback, never
// through a Promise (resolving one with the port looks up `then` on it, and Promise patches see
// results). The UI wraps the port the same way (ui/lib/runtime-port.ts). Defence in depth only:
// main-world code can still patch other built-ins the UI uses (e.g. the RPC client's request
// queue during a reconnect) and reach host paths without the trust check.
// Owns: that hand-over in the page world. Never: references anything outside the function
// (Electron serializes it), keeps a port after handing it over, or replaces the ```app
// sandbox – this is defence in depth for the window, not the boundary.

import type { WorkforceDesktopApi } from '../shared/api/desktop.ts';

/** What the claimed connector calls once per request: the port, or no port and why. */
export type PortDone = (port: MessagePort | undefined, error?: unknown) => void;

/** Opens one runtime port and hands it to `done` (requests run one at a time, in order). */
export type PortConnector = (done: PortDone) => void;

/**
 * Runs in the page's world. `portMessage` is the public PORT_MESSAGE (swallowed too: a page
 * script posting it with a port of its own reaches nobody), `tag` the exact data the preload
 * posts with a real port, `arrivalMs` how long to wait for it after connect() resolved.
 */
export function installMainWorld(bridge: WorkforceDesktopApi, portMessage: string, tag: string, arrivalMs: number): void {
  const page = window as unknown as Window & Record<string, unknown>;
  const apply = Reflect.apply;
  const getter = (proto: object, key: string) => Object.getOwnPropertyDescriptor(proto, key)?.get as ((this: unknown) => unknown) | undefined;
  const readData = getter(MessageEvent.prototype, 'data');
  const readPorts = getter(MessageEvent.prototype, 'ports');
  const stopEvent = Event.prototype.stopImmediatePropagation;
  const closePort = MessagePort.prototype.close;
  const then = Promise.prototype.then;
  const PromiseCtor = Promise;
  const later = setTimeout;
  const cancel = clearTimeout;
  const fail = (message: string) => new Error(message);

  let waiting: ((port: MessagePort | undefined) => void) | null = null;
  let claimed = false;

  const onMessage = (event: MessageEvent) => {
    const data = readData ? apply(readData, event, []) : undefined;
    if (data !== tag && data !== portMessage) return;
    apply(stopEvent, event, []);
    const ports = (readPorts ? apply(readPorts, event, []) : undefined) as ArrayLike<MessagePort> | undefined;
    const port = ports && ports.length > 0 ? ports[0] : undefined;
    const take = data === tag ? waiting : null;
    if (take) {
      waiting = null;
      take(port);
    } else if (port) {
      apply(closePort, port, []);
    }
  };
  apply(EventTarget.prototype.addEventListener, page, ['message', onMessage, true]);

  // One request at a time: every caller gets the port that answered its own request. The queue
  // is a null-prototype object indexed by counters, so no Array/Object built-in sees a callback.
  const queue = Object.create(null) as Record<number, PortDone>;
  let head = 0;
  let tail = 0;
  let busy = false;

  const run = (): void => {
    if (busy || head === tail) return;
    busy = true;
    const done = queue[head];
    delete queue[head];
    head += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (port: MessagePort | undefined, error?: unknown) => {
      if (timer !== undefined) cancel(timer);
      busy = false;
      try { done(port, port ? undefined : error ?? fail('The runtime port did not arrive.')); } catch { /* the asker's own error */ }
      run();
    };
    // Every path clears `waiting` before it settles: each request settles exactly once.
    const giveUp = (error?: unknown) => { if (waiting !== settle) return; waiting = null; settle(undefined, error); };
    waiting = settle;
    try {
      const asked = bridge.connect();
      apply(then, asked, [() => {
        if (waiting === settle) timer = later(() => giveUp(), arrivalMs);
      }, giveUp]);
    } catch (error) {
      giveUp(error);
    }
  };

  const connector: PortConnector = (done) => {
    if (typeof done !== 'function') return;
    queue[tail] = done;
    tail += 1;
    run();
  };

  const connect = () => new PromiseCtor<MessagePort>((resolve, reject) => {
    if (claimed) { reject(fail('The runtime connection belongs to the app window.')); return; }
    connector((port, error) => { if (port) resolve(port); else reject(error); });
  });
  const claimConnector = (): PortConnector => {
    if (claimed) throw fail('The runtime connector was already claimed.');
    claimed = true;
    return connector;
  };

  const value: Record<string, unknown> = { ...bridge, connect, claimConnector };
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item && typeof item === 'object') Object.freeze(item);
  }
  Object.defineProperty(page, 'workforce', { value: Object.freeze(value), enumerable: true, configurable: false, writable: false });
}
