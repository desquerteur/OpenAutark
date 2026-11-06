// The person's emergency stop of all agent work on this PC (window, tray, global shortcut, phone):
//   stop(): the latch goes on (kv 'work'/'stop', so a restart does not quietly lift it), the dispatcher starts no turn
//     while it holds (setHalted) and aborts every running turn at once as the person's Stop (haltAll: a task pauses –
//     "Stopped by you"); a computer drag or typing in progress is cut by ending the helper process
//     (computer/activity.ts cutInput); every background command the engines' sessions left running ends
//     (Engine.stopBackground); calls running here for a linked PC get the abort of `signal` (hold()).
//   resume(): the latch goes off and what waited runs; the paused tasks wait for the person (task Resume, or a message).
//   `working` (not stored): agent turns run here or calls held for linked PCs run – announced with 'work.state' when it
//   flips, so main offers the global shortcut only then.
// Owns: the latch and the 'work.state' event. Never: lifts the latch for anything but the person's Resume, or stops
// work running on another PC.

import { WorkforceError } from '../../shared/errors.ts';
import type { WorkStopState } from '../../shared/model/work-stop.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { Engine } from '../engines/types.ts';
import { computerActivityOf } from '../computer/activity.ts';
import { KvRepo } from '../store/kv.ts';

const KV = { ns: 'work', key: 'stop' };
export const WORK_STOP_REASON = 'All agent work was stopped by the person.';

export interface WorkStopDeps {
  services: () => RuntimeServices;
}

export class WorkStop {
  private readonly deps: WorkStopDeps;
  private state: WorkStopState = { stopped: false, at: 0 };
  private loaded = false;
  /** Aborted at the stop (and while a stored stop holds); a fresh one after Resume. */
  private stopper = new AbortController();
  private turns = false;
  private held = 0;
  private watching = false;

  constructor(deps: WorkStopDeps) {
    this.deps = deps;
  }

  current(): WorkStopState {
    this.load();
    return { ...this.state, working: this.working };
  }

  get stopped(): boolean {
    this.load();
    return this.state.stopped;
  }

  /** Agent turns run on this PC, or calls of linked PCs run here. */
  get working(): boolean {
    return this.turns || this.held > 0;
  }

  /** Aborts at the person's stop (already aborted while stopped). */
  get signal(): AbortSignal {
    this.load();
    return this.stopper.signal;
  }

  /** A tool call a linked PC runs here: its signal also aborts at the stop; it counts as work until `end()`. */
  hold(signal: AbortSignal): { signal: AbortSignal; end(): void } {
    const combined = AbortSignal.any([signal, this.signal]);
    if (this.stopped) return { signal: combined, end: () => {} };
    const before = this.working;
    this.held++;
    if (this.working !== before) this.emit();
    let ended = false;
    return {
      signal: combined,
      end: () => {
        if (ended) return;
        ended = true;
        const was = this.working;
        this.held = Math.max(0, this.held - 1);
        if (this.working !== was) this.emit();
      },
    };
  }

  /** Composition: a stored stop holds the dispatcher before it starts; `working` follows the turns. */
  restore(): void {
    if (this.stopped) this.deps.services().dispatcher.setHalted?.(true);
    this.watch();
  }

  /** Follows 'agent.activity' (the running turns) once; a flip of `working` is announced. */
  watch(): void {
    if (this.watching) return;
    try {
      this.deps.services().bus.on('agent.activity', ({ active }) => {
        const was = this.working;
        this.turns = active.length > 0;
        if (this.working !== was) this.emit();
      });
      this.watching = true;
    } catch { /* no bus: `working` follows the held calls only */ }
  }

  /** The person's emergency stop (`from`: the paired phone or browser). */
  stop(from?: string): WorkStopState {
    this.load();
    if (this.state.stopped) return this.current();
    const services = this.deps.services();
    const dispatcher = services.dispatcher;
    if (typeof dispatcher.setHalted !== 'function' || typeof dispatcher.haltAll !== 'function') {
      throw new WorkforceError('unavailable', 'Agent work cannot be stopped in this runtime.');
    }
    dispatcher.setHalted(true);
    this.state = { stopped: true, at: services.clock.now(), ...(from ? { stoppedFrom: from } : {}) };
    try { if (computerActivityOf(services).cutInput()) services.log.info('agent work stop: running computer input cut'); } catch { /* no computer use here */ }
    this.stopper.abort(new WorkforceError('cancelled', WORK_STOP_REASON)); // calls run here for linked PCs
    const halted = dispatcher.haltAll(WORK_STOP_REASON);
    this.stopBackground(services);
    services.log.warn('all agent work stopped by the person', { runs: halted.runIds.length, from: from ?? 'this PC' });
    this.state = { ...this.state, stoppedRuns: halted.runIds.length };
    this.save();
    this.emit();
    return this.current();
  }

  /** Every engine ends the background commands its sessions left running (returns at once; a failure is logged). */
  private stopBackground(services: RuntimeServices): void {
    if (!services.engines) return;
    let engines: Engine[] = [];
    try { engines = services.engines.all(); } catch (error) {
      services.log.warn('agent work stop: engines not reached for their background commands', { error: String(error) });
      return;
    }
    for (const engine of engines) {
      const failed = (error: unknown) => services.log.warn('agent work stop: background commands not ended', { engine: engine.id, error: String(error) });
      try { engine.stopBackground?.().catch(failed); } catch (error) { failed(error); }
    }
  }

  /** The person's Resume: agents work again; what waited runs. */
  resume(from?: string): WorkStopState {
    this.load();
    if (!this.state.stopped) return this.current();
    const services = this.deps.services();
    this.state = { stopped: false, at: services.clock.now() };
    this.save();
    this.stopper = new AbortController();
    services.log.info('agent work resumed by the person', { from: from ?? 'this PC' });
    services.dispatcher.setHalted?.(false);
    this.emit();
    return this.current();
  }

  private emit(): void {
    try { this.deps.services().bus.emit('work.state', this.current()); } catch { /* no listeners */ }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = new KvRepo(this.deps.services().db).get<WorkStopState>(KV.ns, KV.key);
      if (stored && typeof stored === 'object' && stored.stopped === true) {
        this.state = { ...stored, stopped: true, at: Number(stored.at) || 0 };
        delete this.state.working; // describes the running process, never stored meaningfully
        this.stopper.abort(new WorkforceError('cancelled', WORK_STOP_REASON));
      }
    } catch { /* no stored stop */ }
  }

  private save(): void {
    const services = this.deps.services();
    try {
      const kv = new KvRepo(services.db);
      if (this.state.stopped) kv.set(KV.ns, KV.key, this.state, services.clock.now());
      else kv.delete(KV.ns, KV.key);
    } catch (error) {
      services.log.warn('stop state not stored', { error: String(error) });
    }
  }
}

// ------------------------------------------------------------------ per runtime

/** One latch per runtime, keyed by its RuntimeServices (the RPC handlers reach it through ctx.services). */
const latches = new WeakMap<object, WorkStop>();

export function bindWorkStop(services: object, stop: WorkStop): void {
  latches.set(services, stop);
}

export function workStopOf(services: object): WorkStop {
  const stop = latches.get(services);
  if (!stop) throw new WorkforceError('unavailable', 'Agent work cannot be stopped in this runtime.');
  return stop;
}

/** The latch of this runtime, if it has one. */
export function findWorkStop(services: object): WorkStop | undefined {
  return latches.get(services);
}
