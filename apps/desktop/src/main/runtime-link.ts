// Main's link to the runtime utility process: status fan-out, main's own RpcClient (re-attached
// after every start), MessagePorts for the desktop renderer, power and event pushes.
// Owns: the "port for the window" request queue (a request while the runtime restarts waits for
// the next `up`). Never: forks processes itself (RuntimeHost does), interprets RPC traffic of the
// renderer (its port goes straight to the runtime), imports electron.

import type { RuntimeStatus } from '../shared/api/desktop.ts';
import type { EventMap, EventName } from '../shared/api/events.ts';
import type { MainToRuntime, PointerMessage, PowerEvent, SideViewMessage } from '../shared/api/host-bridge.ts';
import { RpcClient } from './runtime/rpc-client.ts';
import type { PortLike } from './runtime/rpc-client.ts';

/** The RuntimeHost surface the link uses. */
export interface RuntimeHostLike<P> {
  readonly isUp: boolean;
  start(): void;
  connect(client: 'desktop' | 'main'): P | null;
  send(message: MainToRuntime): void;
  stop(reason?: 'quit' | 'update'): Promise<void>;
}

export interface RuntimeLinkOptions {
  /** How long a renderer's port request waits for a (re)starting runtime. */
  portWaitMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * Environment for the runtime process: inherited, minus switches that change how Electron runs it. AUTARK_DATA names
 * its data folder (B-072), so `wf` started by anything the runtime starts reaches this company (wf-cli/discover.ts).
 */
export function runtimeEnv(env: Record<string, string | undefined>, dataDir?: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.NODE_OPTIONS;
  if (dataDir) out.AUTARK_DATA = dataDir;
  return out;
}

interface Waiter<P> { resolve(port: P | null): void; timer: unknown }

export class RuntimeLink<P extends PortLike> {
  readonly rpc: RpcClient;
  private readonly options: RuntimeLinkOptions;
  private host: RuntimeHostLike<P> | null = null;
  private value: RuntimeStatus = { state: 'starting' };
  private readonly listeners = new Set<(status: RuntimeStatus) => void>();
  private waiters: Array<Waiter<P>> = [];

  constructor(options: RuntimeLinkOptions = {}, rpc: RpcClient = new RpcClient()) {
    this.options = options;
    this.rpc = rpc;
  }

  /** Called once by the composition root right after constructing RuntimeHost. */
  bind(host: RuntimeHostLike<P>): void {
    this.host = host;
  }

  get status(): RuntimeStatus { return { ...this.value }; }
  get isUp(): boolean { return this.value.state === 'up'; }

  onChange(listener: (status: RuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** RuntimeHost's onStatus. */
  handleStatus(status: RuntimeStatus): void {
    this.value = status;
    if (status.state === 'up') {
      const port = this.host?.connect('main');
      if (port) this.rpc.attach(port);
      for (const waiter of this.waiters.splice(0)) this.resolveWaiter(waiter, this.host?.connect('desktop') ?? null);
    } else if (status.state === 'restarting' || status.state === 'stopped') {
      this.rpc.detach();
      if (status.state === 'stopped') for (const waiter of this.waiters.splice(0)) this.resolveWaiter(waiter, null);
    }
    for (const listener of [...this.listeners]) {
      try { listener(this.status); } catch { /* a listener bug must not stop the fan-out */ }
    }
  }

  /**
   * A port for the desktop renderer. Immediate while the runtime process exists (RuntimeHost
   * queues the hand-over until it is ready); otherwise waits for the next `up`. Null when the
   * runtime is stopped or does not come up in time.
   */
  desktopPort(): Promise<P | null> {
    if (!this.host || this.value.state === 'stopped') return Promise.resolve(null);
    const port = this.value.state === 'restarting' ? null : this.host.connect('desktop');
    if (port) return Promise.resolve(port);
    return new Promise(resolve => {
      const waiter: Waiter<P> = { resolve, timer: null };
      waiter.timer = this.setTimer(() => {
        this.waiters = this.waiters.filter(entry => entry !== waiter);
        resolve(null);
      }, this.options.portWaitMs ?? 60_000);
      this.waiters.push(waiter);
    });
  }

  power(event: PowerEvent): void {
    this.host?.send({ type: 'power', event });
  }

  /** Publishes a main-produced event on the runtime bus (replayed after a runtime restart). */
  event<E extends EventName>(event: E, data: EventMap[E]): void {
    this.host?.send({ type: 'event', event, data } as MainToRuntime);
  }

  /** B-055 F1: a pointer from the side browser for the runtime's pointer hub – only while it is up (never queued or replayed). */
  pointer(point: PointerMessage['point']): void {
    if (this.isUp) this.host?.send({ type: 'pointer', point });
  }

  /** B-076: a watched side tab's frame or page for the runtime's side views – like `pointer`, only while it is up. */
  sideView(update: SideViewMessage['update']): void {
    if (this.isUp) this.host?.send({ type: 'side-view', update });
  }

  start(): void {
    this.host?.start();
  }

  stop(reason: 'quit' | 'update'): Promise<void> {
    return this.host ? this.host.stop(reason) : Promise.resolve();
  }

  private resolveWaiter(waiter: Waiter<P>, port: P | null): void {
    this.clearTimer(waiter.timer);
    waiter.resolve(port);
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (handle === null) return;
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
