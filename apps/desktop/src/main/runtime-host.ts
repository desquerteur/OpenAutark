// Supervises the runtime utility process (app/runtime.mjs): fork, launch-token handshake,
// host-bridge requests, MessagePort hand-out, restart with backoff, graceful shutdown, and the
// restart the runtime asks for itself (MM7 'runtime.restart': answered first, then stop + start
// without backoff, reported as 'restarting') plus a longer boot wait while a staged restore is
// applied ('runtime.booting').
// Owns: the child's lifecycle and the main side of src/shared/api/host-bridge.ts (the two
// runtime.* ops are answered here; every other op goes to `handle`).
// Never: imports electron at runtime (fork/channel factories are injected so tests use fakes),
// never interprets RPC traffic (ports go straight to the runtime), never logs secrets.

import type { Readable, Writable } from 'node:stream';
import type { RuntimeStatus } from '../shared/api/desktop.ts';
import type { AppInfo, ConnectMessage, HostRequest, MainToRuntime } from '../shared/api/host-bridge.ts';
import { HOST_BRIDGE_PROTOCOL, parseRuntimeMessage } from '../shared/api/host-bridge.ts';
import { toErrorData } from '../shared/errors.ts';
import { Backoff } from './runtime/backoff.ts';

/** The subset of Electron's UtilityProcess the supervisor uses. */
export interface RuntimeChild {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface ForkOptionsLike {
  serviceName: string;
  execArgv: string[];
  stdio: 'pipe';
  env: Record<string, string | undefined>;
}

export interface RuntimeHostDeps<P> {
  fork(modulePath: string, args: string[], options: ForkOptionsLike): RuntimeChild;
  createChannel(): { port1: P; port2: P };
  modulePath: string;
  env: Record<string, string | undefined>;
  token: string;
  app: AppInfo;
  /** Executes a host op for the runtime (host-services.ts). */
  handle(request: HostRequest): Promise<unknown>;
  onStatus(status: RuntimeStatus): void;
  log?: Writable | null;
  logLine?(message: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  bootTimeoutMs?: number; // default 30 s
  restoreBootMs?: number; // default 20 min: boot wait after the runtime announced a restore
  stopTimeoutMs?: number; // default 8 s
  backoff?: Backoff;
}

/** How long main waits for `ready` once the runtime said it applies a staged restore. */
export const RESTORE_BOOT_MS = 20 * 60_000;

export class RuntimeHost<P> {
  private readonly deps: RuntimeHostDeps<P>;
  private readonly backoff: Backoff;
  private child: RuntimeChild | null = null;
  private up = false;
  private stopping = false;
  private startedAt = 0;
  private bootTimer: unknown = null;
  private restartTimer: unknown = null;
  private queued: Array<{ message: MainToRuntime; transfer?: P[] }> = [];
  private readonly sticky = new Map<string, MainToRuntime>(); // last value per main-produced event
  private exitWaiters: Array<() => void> = [];
  /** A restart is under way: the coming exit reports 'restarting' and start() follows. */
  private restartWanted = false;
  private restarting: Promise<void> | null = null;

  constructor(deps: RuntimeHostDeps<P>) {
    this.deps = deps;
    this.backoff = deps.backoff ?? new Backoff();
  }

  get isUp(): boolean { return this.up; }

  /**
   * Starts the runtime. After a completed stop() (child gone) this starts it again – needed when
   * an update restart is cancelled after the runtime was already drained. While a stop is still
   * waiting for the child to exit, it is a no-op.
   */
  start(): void {
    if (this.child) return;
    if (this.stopping) {
      this.stopping = false;
      this.backoff.reset();
    }
    this.spawn();
  }

  /**
   * Creates a channel, gives port2 to the runtime and returns port1 for the caller
   * (a renderer or main's RpcClient). Null when the runtime is not running right now.
   */
  connect(client: ConnectMessage['client']): P | null {
    if (!this.child || this.stopping) return null;
    const { port1, port2 } = this.deps.createChannel();
    this.post({ type: 'connect', client }, [port2]);
    return port1;
  }

  /** Best-effort push (power, event). `event` messages are replayed to a restarted runtime. */
  send(message: MainToRuntime): void {
    if (message.type === 'event') this.sticky.set(message.event, message);
    if (this.child && !this.stopping) this.post(message);
  }

  /** Asks the runtime to drain and exit; kills it after the stop timeout. Ends a restart under way. */
  async stop(reason: 'quit' | 'update' = 'quit'): Promise<void> {
    this.restartWanted = false;
    return this.drain(reason);
  }

  /**
   * Drains the runtime and starts it again right away (no backoff). Status: 'restarting'
   * (inMs 0) when the old process is gone, then 'starting' and 'up' as at launch. A stop()
   * meanwhile (quit, update) wins: nothing is started again. One restart at a time.
   */
  restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    const run = (async () => {
      this.restartWanted = true;
      if (this.child) await this.drain('quit');
      else this.clear('restartTimer'); // a crash backoff was pending: start now instead
      if (!this.restartWanted) return;
      this.restartWanted = false;
      this.start();
    })();
    this.restarting = run.finally(() => { this.restarting = null; });
    return this.restarting;
  }

  private async drain(reason: 'quit' | 'update'): Promise<void> {
    this.stopping = true;
    this.clear('restartTimer');
    const child = this.child;
    if (!child) { this.deps.onStatus({ state: 'stopped' }); return; }
    const exited = new Promise<void>(resolve => this.exitWaiters.push(resolve));
    try { child.postMessage({ type: 'shutdown', reason }); } catch { /* channel already gone */ }
    const timer = this.timer(() => { try { child.kill(); } catch { /* gone */ } }, this.deps.stopTimeoutMs ?? 8000);
    await exited;
    this.deps.clearTimer ? this.deps.clearTimer(timer) : clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  private spawn(): void {
    const { deps } = this;
    this.up = false;
    this.startedAt = this.now();
    deps.onStatus({ state: 'starting' });
    let child: RuntimeChild;
    try {
      child = deps.fork(deps.modulePath, [], {
        serviceName: 'workforce-runtime',
        execArgv: ['--max-old-space-size=512'],
        stdio: 'pipe',
        env: deps.env,
      });
    } catch (error) {
      deps.logLine?.(`runtime fork failed: ${(error as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    if (deps.log) {
      child.stdout?.pipe(deps.log, { end: false });
      child.stderr?.pipe(deps.log, { end: false });
    }
    child.on('message', message => this.receive(child, message));
    child.on('exit', code => this.exited(child, code));
    // The token travels in a message, never in env (env is inherited by the runtime's children).
    child.postMessage({ type: 'init', token: deps.token, protocol: HOST_BRIDGE_PROTOCOL, app: deps.app });
    this.bootTimer = this.timer(() => {
      if (this.child === child && !this.up) {
        deps.logLine?.('runtime did not become ready in time; restarting');
        child.kill();
      }
    }, deps.bootTimeoutMs ?? 30_000);
  }

  private receive(child: RuntimeChild, raw: unknown): void {
    if (child !== this.child) return;
    const message = parseRuntimeMessage(raw);
    if (!message) return;
    if (message.type === 'ready') {
      if (message.token !== this.deps.token || message.protocol !== HOST_BRIDGE_PROTOCOL) {
        this.deps.logLine?.('runtime handshake failed (token or protocol mismatch)');
        child.kill();
        return;
      }
      this.clear('bootTimer');
      this.up = true;
      const queued = this.queued;
      this.queued = [];
      for (const message of this.sticky.values()) child.postMessage(message);
      for (const entry of queued) child.postMessage(entry.message, entry.transfer as unknown[] | undefined);
      this.deps.onStatus({ state: 'up' });
      return;
    }
    void this.answer(child, message);
  }

  private async answer(child: RuntimeChild, request: HostRequest): Promise<void> {
    if (request.op === 'runtime.restart' || request.op === 'runtime.booting') { this.lifecycleOp(child, request); return; }
    let reply: unknown;
    try {
      const result = await this.deps.handle(request);
      reply = { id: request.id, type: 'host-result', ok: true, result };
    } catch (error) {
      reply = { id: request.id, type: 'host-result', ok: false, error: toErrorData(error) };
    }
    if (child === this.child) {
      try { child.postMessage(reply); } catch { /* runtime exited meanwhile */ }
    }
  }

  /** The runtime.* ops: answered before acting, so the reply reaches the runtime ahead of the shutdown. */
  private lifecycleOp(child: RuntimeChild, request: HostRequest): void {
    try { child.postMessage({ id: request.id, type: 'host-result', ok: true, result: { ok: true } }); } catch { /* runtime exited meanwhile */ }
    if (request.op === 'runtime.restart') {
      this.deps.logLine?.('runtime asked for a restart');
      void this.restart().catch(error => this.deps.logLine?.(`runtime restart failed: ${(error as Error).message}`));
      return;
    }
    // runtime.booting: only while this child boots; the wait is re-armed once with the restore timeout.
    if (child !== this.child || this.up || this.bootTimer === null) return;
    this.clear('bootTimer');
    this.bootTimer = this.timer(() => {
      if (this.child === child && !this.up) {
        this.deps.logLine?.('runtime did not finish applying the restore in time; restarting');
        child.kill();
      }
    }, this.deps.restoreBootMs ?? RESTORE_BOOT_MS);
  }

  private exited(child: RuntimeChild, code: number): void {
    if (child !== this.child) return;
    this.child = null;
    this.up = false;
    this.queued = [];
    this.clear('bootTimer');
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const wake of waiters) wake();
    if (this.stopping) { this.deps.onStatus(this.restartWanted ? { state: 'restarting', inMs: 0 } : { state: 'stopped' }); return; }
    this.deps.logLine?.(`runtime exited with code ${code}`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const delay = this.backoff.next(this.now() - this.startedAt);
    this.deps.onStatus({ state: 'restarting', inMs: delay });
    this.restartTimer = this.timer(() => {
      this.restartTimer = null;
      if (!this.stopping && !this.child) this.spawn();
    }, delay);
  }

  private post(message: MainToRuntime, transfer?: P[]): void {
    if (!this.up) { this.queued.push({ message, transfer }); return; }
    this.child?.postMessage(message, transfer as unknown[] | undefined);
  }

  private timer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  }

  private clear(name: 'bootTimer' | 'restartTimer'): void {
    const handle = this[name];
    if (handle === null) return;
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
    this[name] = null;
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
}
