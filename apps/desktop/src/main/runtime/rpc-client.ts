// Main's own JSON-RPC client to the runtime (over a MessagePortMain transferred like a renderer's).
// Owns: request ids, timeouts, typed calls, event fan-out and re-subscription after reconnects.
// Never: holds business state – main asks the runtime and forgets. Never imports electron.

import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import type { EventMap, EventName } from '../../shared/api/events.ts';
import type { Topic } from '../../shared/api/protocol.ts';
import { isEvent, isResponse } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';

/** The subset of MessagePortMain the client needs (fakes in tests). */
export interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener = (data: unknown) => void;

export class RpcClient {
  private port: PortLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly topics = new Map<Topic, number>(); // topic → subscriber count
  private readonly defaultTimeoutMs: number;
  private waiters: Array<() => void> = [];

  constructor(options: { timeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? 20_000;
  }

  get connected(): boolean { return this.port !== null; }

  /** Attaches a fresh port (after every runtime start) and restores subscriptions. */
  attach(port: PortLike): void {
    this.detach(new WorkforceError('unavailable', 'The runtime restarted.'));
    this.port = port;
    port.on('message', event => this.receive(event.data));
    port.on('close', () => { if (this.port === port) this.detach(new WorkforceError('unavailable', 'The runtime is not running.')); });
    port.start();
    const topics = [...this.topics.keys()];
    if (topics.length) void this.call('events.subscribe', { topics }).catch(() => {});
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Drops the port; pending calls fail with `error`. */
  detach(error: unknown = new WorkforceError('unavailable', 'The runtime is not running.')): void {
    const port = this.port;
    this.port = null;
    try { port?.close(); } catch { /* already closed */ }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  /** Resolves when a port is attached (or after `timeoutMs`, rejecting). */
  ready(timeoutMs = 30_000): Promise<void> {
    if (this.port) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(entry => entry !== wake);
        reject(new WorkforceError('unavailable', 'The runtime is not running.'));
      }, timeoutMs);
      const wake = () => { clearTimeout(timer); resolve(); };
      this.waiters.push(wake);
    });
  }

  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs = this.defaultTimeoutMs): Promise<ResultOf<M>> {
    const port = this.port;
    if (!port) return Promise.reject(new WorkforceError('unavailable', 'The runtime is not running.'));
    const id = this.nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkforceError('timeout', 'The runtime did not answer in time.'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      port.postMessage(params === undefined ? { id, method } : { id, method, params });
    });
  }

  on<E extends EventName>(event: E, listener: (data: EventMap[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => { set!.delete(listener as Listener); };
  }

  /** Reference-counted topic subscription; survives reconnects. */
  async subscribe(topic: Topic): Promise<() => void> {
    const count = this.topics.get(topic) ?? 0;
    this.topics.set(topic, count + 1);
    if (count === 0 && this.port) await this.call('events.subscribe', { topics: [topic] }).catch(() => {});
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.topics.get(topic) ?? 1) - 1;
      if (left > 0) { this.topics.set(topic, left); return; }
      this.topics.delete(topic);
      if (this.port) void this.call('events.unsubscribe', { topics: [topic] }).catch(() => {});
    };
  }

  private receive(frame: unknown): void {
    if (isEvent(frame)) {
      for (const listener of this.listeners.get(frame.event) ?? []) {
        try { listener(frame.data); } catch { /* a listener bug must not break the client */ }
      }
      return;
    }
    if (!isResponse(frame) || typeof frame.id !== 'number') return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(new WorkforceError(frame.error.code, frame.error.message, { retryAfterMs: frame.error.retryAfterMs, details: frame.error.details }));
    else entry.resolve(frame.result);
  }
}
