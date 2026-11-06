// WebSocket RPC client of the wf terminal client (C7): connects to 127.0.0.1:<port>/ws, sends the
// Hello with the owner token (Endpoint.hello), matches replies to request ids and fans out pushed
// events. Uses Node's global WebSocket (Node 22+), so the bundle needs no package.
// Owns: framing, request ids, what a closed socket means for open calls. Never: retries a call
// (effects must never repeat blindly), polls, prints, or keeps the token itself.

import { isEvent, isResponse } from '../../shared/api/protocol.ts';
import type { Endpoint } from './discover.ts';
import { CliError, closeError, fromRpcError } from './errors.ts';

const CONNECT_TIMEOUT_MS = 5_000;

/** What commands need from a connection (tests pass a fake). */
export interface Rpc {
  call(method: string, params?: unknown): Promise<unknown>;
  /** Every pushed event of the subscribed topics; returns the unsubscribe function. */
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  /** Resolves with the reason once the runtime closed the connection (never on close()). */
  readonly lost: Promise<CliError>;
  close(): void;
}

interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;

function defaultFactory(): SocketFactory {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) throw new CliError('unreachable', 'This Node.js has no WebSocket client. Node.js 22 or newer is needed.');
  return (url) => new Ctor(url);
}

export function connect(endpoint: Endpoint, options: { socket?: SocketFactory; timeoutMs?: number } = {}): Promise<Rpc> {
  const factory = options.socket ?? defaultFactory();
  return new Promise((resolve, reject) => {
    const ws = factory(endpoint.url);
    const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: CliError): void }>();
    const listeners = new Set<(event: string, data: unknown) => void>();
    let nextId = 1;
    let opened = false;
    let closedByUs = false;
    let failure: CliError | undefined;
    let markLost: (error: CliError) => void = () => {};
    const lost = new Promise<CliError>((done) => { markLost = done; });

    const timer = setTimeout(() => {
      if (opened) return;
      closedByUs = true;
      try { ws.close(); } catch { /* not open yet */ }
      reject(new CliError('unreachable', `The runtime on port ${endpoint.port} did not answer.`));
    }, options.timeoutMs ?? CONNECT_TIMEOUT_MS);
    timer.unref?.();

    ws.onerror = () => { /* the close event that follows decides */ };
    ws.onclose = (event) => {
      clearTimeout(timer);
      if (!opened) {
        if (!closedByUs) reject(new CliError('unreachable', `Nothing answers on port ${endpoint.port}. Is the app still running?`));
        return;
      }
      failure = closeError(event.code);
      for (const entry of pending.values()) entry.reject(failure);
      pending.clear();
      if (!closedByUs) markLost(failure);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return; // the runtime sends text frames only
      let frame: unknown;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (isEvent(frame)) {
        for (const listener of [...listeners]) listener(frame.event, frame.data);
        return;
      }
      if (!isResponse(frame)) return;
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.error) entry.reject(fromRpcError(frame.error, entry.method));
      else entry.resolve(frame.result ?? null);
    };
    ws.onopen = () => {
      clearTimeout(timer);
      opened = true;
      ws.send(JSON.stringify(endpoint.hello())); // the runtime answers a refused token with close 4401
      resolve({
        call(method, params) {
          return new Promise((done, fail) => {
            if (failure) { fail(failure); return; }
            if (ws.readyState !== OPEN) { fail(new CliError('unreachable', 'The connection to the runtime is closed.')); return; }
            const id = nextId++;
            pending.set(id, { method, resolve: done, reject: fail });
            ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
          });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        lost,
        close() {
          closedByUs = true;
          try { ws.close(1000, 'bye'); } catch { /* already closed */ }
        },
      });
    };
  });
}
