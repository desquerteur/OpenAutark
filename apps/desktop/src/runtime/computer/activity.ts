// Computer use as the person sees it: which agent uses this PC's screen, mouse or keyboard right now
// (`computer.activity` events for the window-bar pill, at most one per second) and the person's
// simple Stop (`computer.stop` / `computer.resume`): running computer calls end, new ones answer
// "Stopped by the person" until Resume. The emergency stop of all agent work (agents/work-stop.ts)
// cuts a running input op the same way (cutInput) without latching computer use.
// A drag or typing cut short is ended with the helper process; a fresh one then lets go of the mouse
// buttons and Ctrl/Shift/Alt/Win keys Windows still reports held.
// Owns: the activity state, its events and the latch (kv 'computer'/'stop', so a restart does not lift it).
// Never: lifts the latch for anything but the person's Resume, or stops the person's live screen preview.

import { WorkforceError } from '../../shared/errors.ts';
import type { ComputerActivityState } from '../../shared/model/computer.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { HelperClient } from './helper.ts';
import type { HelperOp } from './protocol.ts';

export const STOPPED_BY_PERSON = 'Stopped by the person';
export const ACTIVITY_EVERY_MS = 1000;
export const ACTIVE_LINGER_MS = 10_000;
/** The release after a Stop may start a fresh helper first (Add-Type compiles once per process). */
const RELEASE_TIMEOUT_MS = 60_000;
const KV = { ns: 'computer', key: 'stop' };
/** Helper ops that move the mouse, type or change windows: refused while stopped, cut at Stop. */
const INPUT_OPS: ReadonlySet<HelperOp> = new Set<HelperOp>(['focus_window', 'act', 'click', 'move', 'path', 'scroll', 'type', 'key']);

export interface ActivityTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

const REAL_TIMERS: ActivityTimers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ComputerActivityDeps {
  now: () => number;
  /** Late-bound: events (bus), the kv row and this PC's name. */
  services?: () => RuntimeServices;
  timers?: ActivityTimers;
}

/** One agent call on this PC: who, from which linked PC (its name), which step. */
export interface ActivityCall { agent: string; agentId?: string; fromDevice?: string; summary: string; signal?: AbortSignal }

export class ComputerActivity {
  private readonly deps: ComputerActivityDeps;
  private readonly timers: ActivityTimers;
  private state: ComputerActivityState = { active: false, stopped: false, at: 0 };
  private stopper = new AbortController();
  private loaded = false;
  private calls = 0;
  private inputOps = 0;
  private inner: HelperClient | undefined;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private trailing: unknown;
  private linger: unknown;

  constructor(deps: ComputerActivityDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  current(): ComputerActivityState {
    this.load();
    return { ...this.state };
  }

  get stopped(): boolean {
    this.load();
    return this.state.stopped;
  }

  /** Throws "Stopped by the person" while stopped. */
  guard(): void {
    if (this.stopped) throw stoppedError();
  }

  /** A helper whose input ops are refused while stopped and end at Stop (observing stays free). */
  wrapHelper(inner: HelperClient): HelperClient {
    this.inner = inner;
    return {
      call: async <T>(op: HelperOp, args?: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> => {
        if (!INPUT_OPS.has(op)) return inner.call<T>(op, args, options);
        this.guard();
        const stopper = this.stopper.signal;
        this.inputOps++;
        try {
          return await inner.call<T>(op, args, { ...options, signal: options.signal ? AbortSignal.any([options.signal, stopper]) : stopper });
        } catch (error) {
          throw stopper.aborted ? stoppedError() : error;
        } finally {
          this.inputOps--;
        }
      },
      running: () => inner.running(),
      dispose: () => inner.dispose(),
    };
  }

  /** Runs one agent call: refused while stopped, shown as activity, its signal aborted by Stop. */
  async run<T>(call: ActivityCall, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.guard();
    const stopper = this.stopper.signal;
    const done = this.begin(call);
    try {
      return await work(call.signal ? AbortSignal.any([call.signal, stopper]) : stopper);
    } catch (error) {
      if (!stopper.aborted) throw error;
      throw stoppedError();
    } finally {
      done();
    }
  }

  /** The person's Stop (`from`: the paired phone or browser): in-flight calls end, new ones are refused until resume(). */
  stop(from?: string): ComputerActivityState {
    this.load();
    if (this.state.stopped) return this.current();
    this.state = { active: false, stopped: true, ...(from ? { stoppedFrom: from } : {}), at: this.deps.now() };
    const busy = this.inputOps > 0;
    this.stopper.abort();
    if (busy) void this.cutShort();
    this.save();
    this.emitNow();
    return this.current();
  }

  /** The emergency stop of all agent work: a running drag or typing is cut like at Stop; nothing is latched. */
  cutInput(): boolean {
    if (this.inputOps === 0) return false;
    void this.cutShort();
    return true;
  }

  /** The person's Resume: agents may use this PC again. */
  resume(): ComputerActivityState {
    this.load();
    if (!this.state.stopped) return this.current();
    this.stopper = new AbortController();
    this.state = { active: false, stopped: false, at: this.deps.now() };
    this.save();
    this.emitNow();
    return this.current();
  }

  // ------------------------------------------------------------------ internals

  /** Ends the helper process of a cut input op, then releases held buttons and modifier keys. */
  private async cutShort(): Promise<void> {
    const helper = this.inner;
    if (!helper) return;
    try { await helper.dispose(); } catch { /* already gone */ }
    try {
      await helper.call('release', {}, { timeoutMs: RELEASE_TIMEOUT_MS });
    } catch (error) {
      try { this.services()?.log.warn('computer use: releasing held buttons and keys after Stop failed', { error: String(error) }); } catch { /* no logger */ }
    }
  }

  private begin(call: ActivityCall): () => void {
    this.calls++;
    if (this.linger !== undefined) { this.timers.clear(this.linger); this.linger = undefined; }
    this.state = { ...this.state, active: true, agent: call.agent, agentId: call.agentId, fromDevice: call.fromDevice, summary: call.summary.slice(0, 160), at: this.deps.now() };
    this.schedule();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.calls--;
      if (this.calls > 0 || this.linger !== undefined) return;
      this.linger = this.timers.set(() => {
        this.linger = undefined;
        if (this.calls > 0 || !this.state.active) return;
        this.state = { active: false, stopped: this.state.stopped, at: this.deps.now() };
        this.schedule();
      }, ACTIVE_LINGER_MS);
    };
  }

  /** At most one event per second: now, or once when the second is over (with the latest state). */
  private schedule(): void {
    const wait = this.lastEmit + ACTIVITY_EVERY_MS - this.deps.now();
    if (wait <= 0) { this.emitNow(); return; }
    this.trailing ??= this.timers.set(() => { this.trailing = undefined; this.emitNow(); }, wait);
  }

  private emitNow(): void {
    if (this.trailing !== undefined) { this.timers.clear(this.trailing); this.trailing = undefined; }
    this.lastEmit = this.deps.now();
    try { this.services()?.bus.emit('computer.activity', { ...this.state }); } catch { /* no bus yet */ }
  }

  private services(): RuntimeServices | undefined {
    try { return this.deps.services?.(); } catch { return undefined; }
  }

  private load(): void {
    if (this.loaded) return;
    const s = this.services();
    if (!s) return;
    this.loaded = true;
    try {
      const row = s.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [KV.ns, KV.key]);
      const stored = row ? JSON.parse(row.value) as { stopped?: unknown; at?: unknown; from?: unknown } : undefined;
      if (stored?.stopped === true) {
        this.state = { active: false, stopped: true, ...(typeof stored.from === 'string' ? { stoppedFrom: stored.from.slice(0, 60) } : {}), at: Number(stored.at) || 0 };
        this.stopper.abort();
      }
    } catch { /* unreadable: not stopped */ }
  }

  private save(): void {
    const s = this.services();
    if (!s) return;
    const value = { stopped: this.state.stopped, at: this.state.at, from: this.state.stoppedFrom };
    try {
      s.db.run(
        `INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [KV.ns, KV.key, JSON.stringify(value), s.clock.now()],
      );
    } catch { /* the latch still holds in memory */ }
  }
}

function stoppedError(): WorkforceError {
  return new WorkforceError('forbidden', `${STOPPED_BY_PERSON}: computer use on this PC is paused until they press Resume. I tell the person and wait.`, { details: { stopped: true } });
}

// ------------------------------------------------------------------ per runtime

/** One hub per runtime, keyed by its RuntimeServices (the RPC handlers reach it through ctx.services). */
const hubs = new WeakMap<object, ComputerActivity>();

export function bindComputerActivity(services: object, activity: ComputerActivity): void {
  hubs.set(services, activity);
}

export function computerActivityOf(services: object): ComputerActivity {
  const hub = hubs.get(services);
  if (!hub) throw new WorkforceError('unavailable', 'Computer use is not available in this runtime.');
  return hub;
}
