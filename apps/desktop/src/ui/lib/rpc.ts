// Typed RPC client for the runtime. Two transports, one API:
//   desktop     – MessagePort posted by the preload after `window.workforce.connect()`, owner scope
//   PWA/web     – WebSocket to `/ws`, first frame is a Hello with the device token (inside the iPhone web app the
//                 shell's tunnel socket, window.autarkHosted – pwa/hosted.ts)
// Auto-reconnects with backoff (on desktop also as soon as the bridge reports the runtime 'up'
// again after a restart), re-subscribes topics, rejects pending calls on disconnect. A socket the
// runtime closes on purpose (4401: token refused, this device is no longer paired, 4403: this device
// was removed) is remembered in `refused` until the runtime answers again, so the app can say so
// instead of showing "offline"; a later 4401 for a token the runtime revoked stays 4403, also
// after a reload (lib/refusal.ts). Reconnecting goes on with backoff, which only an answer from
// the runtime resets (a refused socket opens, then closes). Whenever the phone/browser page comes
// back (visible, pageshow, online, a push), checkAlive connects a socket that is not open at once
// and gives an open one 3 s to answer `session.info`, else replaces it as half-open.
// Owns: framing, request ids, the event fan-out, connection status, the socket's liveness check.
// Never: holds app state (see store.ts) or retries calls itself (callers decide; effects
// must never be blindly repeated).

import { signal } from '@preact/signals';
import type { EventMap, EventName } from '../../shared/api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import { PROTOCOL_VERSION, isEvent, isResponse } from '../../shared/api/protocol.ts';
import type { Hello, RpcRequest, Topic } from '../../shared/api/protocol.ts';
import type { ErrorCode, WorkforceErrorData } from '../../shared/errors.ts';
import { hostedShell } from '../pwa/hosted.ts';
import { bridge, platform } from './platform.ts';
import { RefusalMemory } from './refusal.ts';
import { RuntimeEpochs, requestPort } from './runtime-port.ts';
import type { PortHost } from './runtime-port.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/** Error thrown by rpc.call: carries the runtime's safe error code + message. */
export class RpcError extends Error {
  readonly code: ErrorCode;
  readonly data: WorkforceErrorData;
  constructor(data: WorkforceErrorData) {
    super(data.message);
    this.name = 'RpcError';
    this.code = data.code;
    this.data = data;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  method: string;
}

interface Transport {
  send(frame: unknown): void;
  close(): void;
}

const TOKEN_KEY = 'wf.token';
const status = signal<ConnectionStatus>('connecting');
/** Close code of the last socket the runtime refused (4401) or revoked (4403); null once it answers. */
const refused = signal<4401 | 4403 | null>(null);
const refusals = new RefusalMemory();
const pending = new Map<number, Pending>();
const queue: RpcRequest[] = []; // requests issued while not connected
const listeners = new Map<string, Set<(data: unknown) => void>>();
const topics = new Set<Topic>();
let transport: Transport | null = null;
let nextId = 1;
let retryDelay = 500;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let connecting = false; // one connect attempt at a time
let probing = false; // one liveness probe at a time
const epochs = new RuntimeEpochs();

/** Reads the device token: `#token=` in the URL wins (then stored and removed), else storage. */
function readToken(): string {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match) {
    const token = decodeURIComponent(match[1]);
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage may be blocked */ }
    history.replaceState(null, '', location.pathname + location.search);
    return token;
  }
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

function handleFrame(raw: unknown): void {
  retryDelay = 500; // the runtime answered: this connection was accepted
  if (refused.peek() !== null) { refused.value = null; refusals.answered(); }
  let frame = raw;
  if (typeof raw === 'string') {
    try { frame = JSON.parse(raw); } catch { return; }
  }
  if (isEvent(frame)) {
    const set = listeners.get(frame.event);
    if (set) for (const fn of [...set]) {
      try { fn(frame.data); } catch (error) { console.error(`[rpc] listener for ${frame.event} failed`, error); }
    }
    return;
  }
  if (isResponse(frame)) {
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new RpcError(frame.error));
    else entry.resolve(frame.result);
  }
}

function onOpen(next: Transport): void {
  transport = next;
  status.value = 'open';
  if (topics.size) next.send({ id: nextId++, method: 'events.subscribe', params: { topics: [...topics] } });
  for (const request of queue.splice(0)) next.send(request);
  emitLocal('rpc.open');
}

function onClosed(): void {
  if (!transport && status.value === 'closed') return;
  transport = null;
  status.value = 'closed';
  const error = new RpcError({ code: 'unavailable', message: 'Connection to the runtime was lost.' });
  for (const [id, entry] of pending) { pending.delete(id); entry.reject(error); }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10_000);
}

async function connectPort(): Promise<void> {
  const port = await requestPort(() => bridge!.connect(), window as unknown as PortHost, window);
  port.onmessage = (event) => handleFrame(event.data);
  port.start();
  const next: Transport = { send: (frame) => port.postMessage(frame), close: () => port.close() };
  // Chromium fires 'close' on a port whose other end went away (the runtime process exited).
  port.addEventListener('close', () => { if (transport === next) onClosed(); });
  epochs.opened();
  onOpen(next);
}

function connectSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    // Inside the iPhone web app the socket is a tunnel stream to the PC (pwa/hosted.ts); elsewhere the page's own host.
    const hosted = hostedShell();
    const socket = hosted ? (hosted.socket('/ws') as unknown as WebSocket) : new WebSocket(`${scheme}://${location.host}/ws`);
    const next: Transport = { send: (frame) => socket.send(JSON.stringify(frame)), close: () => { socket.onmessage = null; socket.close(); } };
    let opened = false;
    let token = '';
    socket.onopen = () => {
      opened = true;
      token = readToken();
      const hello: Hello = { protocol: PROTOCOL_VERSION, token, client: 'pwa', deviceName: navigator.userAgent.slice(0, 80) };
      socket.send(JSON.stringify(hello));
      onOpen(next);
      resolve();
    };
    socket.onmessage = (event) => handleFrame(event.data);
    socket.onclose = (event) => {
      const refusal = refusals.closed(event.code, token);
      if (refusal !== null) refused.value = refusal;
      if (!opened) reject(new Error('socket closed'));
      else if (transport === next) onClosed();
    };
  });
}

async function connect(): Promise<void> {
  if (connecting) return;
  connecting = true;
  status.value = 'connecting';
  try {
    if (platform === 'desktop' && bridge) await connectPort();
    else await connectSocket();
  } catch {
    status.value = 'closed';
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

/** Drops the current transport (its pending calls reject, status 'closed') and connects again right away. */
function reconnectNow(): void {
  const stale = transport;
  if (stale) {
    onClosed();
    try { stale.close(); } catch { /* already closed */ }
  }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 500;
  void connect();
}

/** Desktop: a restarted runtime closed the old port – drop it and connect again right away. */
function watchRuntime(): void {
  if (platform !== 'desktop' || !bridge) return;
  bridge.onRuntime((runtime) => {
    if (epochs.status(runtime, transport !== null) && !connecting) reconnectNow();
  });
}

/**
 * Phone/browser (the desktop port reports its own end): a socket that is not open connects now;
 * an open one answers `session.info` within 3 s, or it is half-open (events stopped, calls hang)
 * and is replaced at once. Runs on visible, pageshow, online and a push (pwa/install.ts).
 */
export function checkAlive(): void {
  if (bridge || !started || connecting || probing) return;
  if (status.peek() !== 'open') { reconnectNow(); return; }
  probing = true;
  const dead = setTimeout(reconnectNow, 3_000); // every close rejects the probe first, which clears this
  void call('session.info').catch(() => undefined).finally(() => { clearTimeout(dead); probing = false; });
}

function emitLocal(name: string): void {
  const set = listeners.get(name);
  if (set) for (const fn of [...set]) fn(undefined);
}

function call<M extends MethodName>(method: M, params?: ParamsOf<M>): Promise<ResultOf<M>> {
  start();
  const id = nextId++;
  const request: RpcRequest = params === undefined ? { id, method } : { id, method, params };
  return new Promise<ResultOf<M>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
    if (transport && status.value === 'open') {
      try { transport.send(request); } catch (error) { pending.delete(id); reject(error); }
    } else {
      queue.push(request);
    }
  });
}

function on<E extends EventName>(event: E, fn: (data: EventMap[E]) => void): () => void {
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  const wrapped = fn as (data: unknown) => void;
  set.add(wrapped);
  return () => { set.delete(wrapped); };
}

/** Called after every (re)connect – used by the store to reload snapshots. */
function onOpenEvent(fn: () => void): () => void {
  let set = listeners.get('rpc.open');
  if (!set) { set = new Set(); listeners.set('rpc.open', set); }
  set.add(fn);
  return () => { set.delete(fn); };
}

function subscribe(next: Topic[]): void {
  const fresh = next.filter((topic) => !topics.has(topic));
  if (!fresh.length) return;
  for (const topic of fresh) topics.add(topic);
  if (transport && status.value === 'open') void call('events.subscribe', { topics: fresh }).catch(() => undefined);
}

function unsubscribe(next: Topic[]): void {
  const known = next.filter((topic) => topics.has(topic));
  if (!known.length) return;
  for (const topic of known) topics.delete(topic);
  if (transport && status.value === 'open') void call('events.unsubscribe', { topics: known }).catch(() => undefined);
}

/** Starts the connection once (idempotent). Reconnects when the network or the page comes back. */
function start(): void {
  if (started) return;
  started = true;
  watchRuntime();
  void connect();
  window.addEventListener('online', () => { if (!bridge) checkAlive(); else if (status.value !== 'open' && retryTimer) reconnectNow(); });
  window.addEventListener('pageshow', checkAlive);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkAlive(); });
}

export const rpc = { call, on, subscribe, unsubscribe, onOpen: onOpenEvent, start, status, refused };

/** Short user-safe text for any error thrown by rpc.call. */
export function errorText(error: unknown): string {
  if (error instanceof RpcError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}
