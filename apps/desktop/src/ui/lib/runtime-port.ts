// Desktop runtime port. Normal path: the UI boot claims the preload's one-shot connector
// (claimConnector, before any overlay code runs); requestPort then gets every port from it, and
// the public bridge.connect() rejects for everyone else. Fallback (no main-world wrapper): the
// plain preload contract (shared/api/desktop.ts) – install a window "message" listener for
// PORT_MESSAGE, call bridge.connect(), take the MessagePort from the event. Plus the rule for
// when a runtime status means "reconnect".
// The RPC client never touches the MessagePort itself: requestPort hands out a RuntimePort whose
// methods call MessagePort/MessageEvent built-ins captured when this module loaded (before
// overlay code), and resolves with it through a Promise that later Promise patches cannot read
// (own `constructor`, null-prototype value). So patching MessagePort.prototype.postMessage, the
// MessageEvent data getter, `then` or Promise later never reaches the live owner port. Defence
// in depth only: the plugin sandbox is the boundary, and rpc.ts still uses ordinary built-ins
// (Array/Map/Set) for its request queue and listeners.
// Owns: the port hand-over, the port wrapper and the restart bookkeeping. Never: frames, ids or
// pending calls (rpc.ts), and never keeps a listener after the request settled.

import { PORT_MESSAGE } from '../../shared/api/desktop.ts';
import type { RuntimeStatus } from '../../shared/api/desktop.ts';

/** How long to wait for the posted port after connect() resolved. */
export const PORT_ARRIVAL_MS = 5_000;

export interface PortMessageEvent { source: unknown; data: unknown; ports: ReadonlyArray<MessagePort> }

/** The window surface requestPort needs (a fake in tests). */
export interface PortHost {
  addEventListener(type: 'message', listener: (event: PortMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: PortMessageEvent) => void): void;
}

/** The claimed connector (preload/main-world.ts): hands one port, or none and why, to `done`. */
export type PortConnector = (done: (port: MessagePort | undefined, error?: unknown) => void) => void;

/** The runtime port as rpc.ts uses it (only these members; see the header). */
export interface RuntimePort {
  /** Receives every frame as `{data}` once start() was called. */
  onmessage: ((event: { data: unknown }) => void) | null;
  start(): void;
  postMessage(frame: unknown): void;
  close(): void;
  /** Only 'close': Chromium fires it when the other end went away (the runtime exited). */
  addEventListener(type: 'close', listener: () => void): void;
}

const apply = Reflect.apply;

/** The built-ins the wrapper and the hand-over call, captured at module load. */
const intrinsics = (() => {
  if (typeof MessagePort !== 'function' || typeof MessageEvent !== 'function' || typeof EventTarget !== 'function') return undefined;
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  if (!data) return undefined;
  const port = MessagePort.prototype;
  return {
    portProto: port, post: port.postMessage, start: port.start, close: port.close, listen: EventTarget.prototype.addEventListener, data,
    isPrototypeOf: Object.prototype.isPrototypeOf, create: Object.create, define: Object.defineProperty, Promise,
  };
})();
const PromiseCtor = intrinsics?.Promise ?? Promise;

let claimed: PortConnector | undefined;

/**
 * Claims the preload's runtime connector (desktop boot, before overlay code loads). True when
 * claimed – from then on requestPort uses it; false when the bridge has none (plain contract).
 * Throws when the connector was claimed before: some other code ran first, so the app must not
 * connect through the public path either.
 */
export function claimConnector(bridge: unknown): boolean {
  const claim = (bridge as { claimConnector?: unknown } | null | undefined)?.claimConnector;
  if (typeof claim !== 'function') return false;
  const connector = (claim as () => unknown)();
  if (typeof connector !== 'function') throw new Error('The runtime connector is not available.');
  claimed = connector as PortConnector;
  return true;
}

function isPort(value: unknown): value is MessagePort {
  return typeof value === 'object' && value !== null && typeof (value as MessagePort).postMessage === 'function' && typeof (value as MessagePort).start === 'function';
}

/** Wraps a real MessagePort (brand-checked) in a null-prototype RuntimePort over captured built-ins. */
export function guardPort(port: unknown): RuntimePort {
  const own = intrinsics;
  if (!own || typeof port !== 'object' || port === null || !apply(own.isPrototypeOf, own.portProto, [port])) {
    throw new Error('The runtime port is not a MessagePort.');
  }
  // Plain assignments on a null-prototype object create own data properties (no setters run).
  const wrapper = own.create(null) as RuntimePort;
  wrapper.onmessage = null;
  wrapper.start = () => { apply(own.start, port, []); };
  wrapper.postMessage = (frame) => { apply(own.post, port, [frame]); };
  wrapper.close = () => { apply(own.close, port, []); };
  wrapper.addEventListener = (type, listener) => {
    if (type === 'close' && typeof listener === 'function') apply(own.listen, port, ['close', () => { listener(); }]);
  };
  apply(own.listen, port, ['message', (event: MessageEvent) => {
    const handler = wrapper.onmessage;
    if (typeof handler === 'function') handler({ data: apply(own.data, event, []) });
  }]);
  return wrapper;
}

/** Gives `promise` an own `constructor`, so `await` never asks a patched Promise.prototype for it. */
function sealed<T>(promise: Promise<T>): Promise<T> {
  const own = intrinsics;
  if (!own) return promise;
  const descriptor = own.create(null) as PropertyDescriptor;
  descriptor.value = own.Promise;
  own.define(promise, 'constructor', descriptor);
  return promise;
}

/**
 * Asks main for a fresh runtime port. With a claimed connector that is all (`connect` and the
 * window are not used). Otherwise `self` is what event.source must be (the page window: the
 * preload posts from the same window); a port that connect() resolves with is taken as well.
 * Rejects when connect() fails or no port arrives.
 */
export function requestPort(connect: () => Promise<unknown>, host: PortHost, self: unknown, arrivalMs = PORT_ARRIVAL_MS): Promise<RuntimePort> {
  const connector = claimed;
  return sealed(new PromiseCtor<RuntimePort>((resolve, reject) => {
    const deliver = (port: unknown) => {
      try { resolve(guardPort(port)); } catch (error) { reject(error); }
    };
    if (connector) {
      connector((port, error) => { if (port) deliver(port); else reject(error ?? new Error('The runtime port did not arrive.')); });
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      settled = true;
      host.removeEventListener('message', onMessage);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onMessage = (event: PortMessageEvent) => {
      if (event.source !== self || event.data !== PORT_MESSAGE || !event.ports?.[0]) return;
      finish();
      deliver(event.ports[0]);
    };
    host.addEventListener('message', onMessage);
    let request: Promise<unknown>;
    try { request = Promise.resolve(connect()); } catch (error) { request = Promise.reject(error); }
    request.then((value) => {
      if (settled) return;
      if (isPort(value)) { finish(); deliver(value); return; }
      timer = setTimeout(() => { finish(); reject(new Error('The runtime port did not arrive.')); }, arrivalMs);
    }, (error: unknown) => {
      if (settled) return;
      finish();
      reject(error);
    });
  }));
}

/**
 * Restart bookkeeping. 'restarting' and 'stopped' start a new runtime "epoch": the runtime
 * process is gone, and so is every port opened before. 'starting' does not – main hands out
 * ports while the runtime boots (queued until it is ready), and at launch the page often opens
 * its port before main's late 'starting' arrives. `up` answers whether to reconnect: only when
 * the current port (if any) predates the last restart, so the first 'up' after boot, which
 * arrives with the very port we already use, does not drop pending calls.
 */
export class RuntimeEpochs {
  private epoch = 0;
  private openedIn = -1;

  /** A port was opened (call when the transport is up). */
  opened(): void { this.openedIn = this.epoch; }

  /** True when this status means: drop the current port and connect again. */
  status(status: RuntimeStatus, connected: boolean): boolean {
    if (status.state === 'restarting' || status.state === 'stopped') { this.epoch += 1; return false; }
    if (status.state !== 'up') return false;
    return !connected || this.openedIn !== this.epoch;
  }
}
