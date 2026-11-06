// Engine stall watchdog of one attempt (B-044, agents/turn-attempt.ts): an engine turn that sends no
// event for STALL_IDLE_MS while none of its tool calls runs – or for STALL_TOOL_MS while one does (builds
// and renders run long) – is cut through the engine's own interrupt (the attempt's signal) and ends
// 'unavailable' with STALL_MESSAGE, so the failover rule applies (accounts/failure.ts: a short cooling;
// agents/turn.ts: another account when no tool ran or every effect is known; a cut call's effect is not
// known, so such a turn is never repeated blindly). One unref'd timer per
// attempt, re-armed when it fires and when the last running call ends – never per event.
// B-059 #22: a timer that fires more than SLEEP_GAP_MS after it was due means the PC slept (or the process was
// suspended) – the engine was not silent: the quiet time starts again instead of a cut and an account cooling.
// B-059: overrun() – the turn grew past its ceiling (agents/repeat-watch.ts) – cuts the attempt through the same signal
// after its current step (at once when no call runs, else when the last running call ends), with code 'internal'
// and details.overlong: no account failure, so no failover and no cooling. cutError is the error of either cut.
// Owns: the timing, the calls in flight and the cut. Never: decides failover, or cuts a turn the
// dispatcher or the person already stopped (their abort wins: the parent signal).

import { WorkforceError, type WorkforceErrorData } from '../../shared/errors.ts';

export const STALL_IDLE_MS = 10 * 60_000;
export const STALL_TOOL_MS = 45 * 60_000;
export const STALL_MESSAGE = 'The engine stopped responding.';
/** B-059 #22: a timer this much later than due slept with the PC: no stall. */
export const SLEEP_GAP_MS = 60_000;
/** Shortest re-arm, so a late timer never spins. */
const MIN_ARM_MS = 1000;

export interface StallTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: StallTimers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface StallWatchDeps {
  now: () => number;
  /** The turn's own signal (Stop, urgent interrupt, shutdown). */
  parent: AbortSignal;
  timers?: StallTimers;
  idleMs?: number;
  toolMs?: number;
}

/** The error a stalled attempt ends with (code 'unavailable': an outage, not a model failure). */
export function stallError(): WorkforceErrorData {
  return { code: 'unavailable', message: STALL_MESSAGE, details: { stalled: true } };
}

export class StallWatch {
  /** The engine's signal: the parent's abort or the watchdog's cut. */
  readonly signal: AbortSignal;
  private readonly deps: StallWatchDeps;
  private readonly cut = new AbortController();
  private readonly calls = new Set<string>();
  private last: number;
  private handle: unknown;
  /** When the timer was armed and for how long (B-059 #22: a late timer slept). */
  private armedAt = 0;
  private armedMs = 0;
  private ended = false;
  private fired = false;
  /** B-059: the overrun's cut, waiting for the running calls to end; `overran` once it cut. */
  private overrunError: WorkforceError | undefined;
  private overran = false;

  constructor(deps: StallWatchDeps) {
    this.deps = deps;
    this.signal = AbortSignal.any([deps.parent, this.cut.signal]);
    this.last = deps.now();
  }

  /** True once the watchdog cut the attempt for silence. */
  get stalled(): boolean {
    return this.fired;
  }

  /** B-059: true once the attempt was cut for growing past its ceiling (overrun). */
  get overlong(): boolean {
    return this.overran;
  }

  /** The error of the watch's own cut (silence: stallError; ceiling: the overrun's); undefined while it has not cut. */
  get cutError(): WorkforceErrorData | undefined {
    if (this.fired) return stallError();
    return this.overran && this.overrunError ? { code: 'internal', message: this.overrunError.message, details: { overlong: true } } : undefined;
  }

  /**
   * B-059: the turn grew past its ceiling – cut it after its current step (code 'internal', details.overlong: no
   * account failure). Once; nothing after a cut or the parent's abort.
   */
  overrun(message: string): void {
    if (this.ended || this.overrunError || this.deps.parent.aborted) return;
    this.overrunError = new WorkforceError('internal', message, { details: { overlong: true } });
    if (this.calls.size === 0) this.cutOverlong();
  }

  /** Starts the quiet time (call it right before the engine runs). */
  start(): void {
    this.last = this.deps.now();
    this.arm(this.idleMs);
  }

  /** An engine event arrived. */
  activity(): void {
    this.last = this.deps.now();
  }

  /** A tool call (the engine's own, a hub call or ours) started or ended. */
  call(callId: string, running: boolean): void {
    const before = this.calls.size;
    if (callId) {
      if (running) this.calls.add(callId);
      else this.calls.delete(callId);
    }
    this.activity();
    // B-059: an overrun waited for this step to end.
    if (before > 0 && this.calls.size === 0 && this.overrunError && !this.ended) { this.cutOverlong(); return; }
    // The last running call ended: the shorter idle limit applies from now, not at the tool limit's check.
    if (before > 0 && this.calls.size === 0 && this.handle !== undefined) {
      (this.deps.timers ?? NODE_TIMERS).clear(this.handle);
      this.arm(this.idleMs);
    }
  }

  stop(): void {
    this.ended = true;
    if (this.handle !== undefined) (this.deps.timers ?? NODE_TIMERS).clear(this.handle);
    this.handle = undefined;
  }

  private get idleMs(): number { return this.deps.idleMs ?? STALL_IDLE_MS; }
  private get toolMs(): number { return this.deps.toolMs ?? STALL_TOOL_MS; }

  private arm(ms: number): void {
    if (this.ended) return;
    this.armedAt = this.deps.now();
    this.armedMs = Math.max(MIN_ARM_MS, ms);
    this.handle = (this.deps.timers ?? NODE_TIMERS).set(() => this.check(), this.armedMs);
  }

  private cutOverlong(): void {
    this.overran = true;
    this.stop();
    this.cut.abort(this.overrunError);
  }

  private check(): void {
    this.handle = undefined;
    if (this.ended || this.deps.parent.aborted) return;
    const now = this.deps.now();
    if (now - this.armedAt - this.armedMs > SLEEP_GAP_MS) { this.last = now; this.arm(this.idleMs); return; } // B-059 #22: the PC slept, the engine was not silent
    const limit = this.calls.size ? this.toolMs : this.idleMs;
    const quiet = now - this.last;
    if (quiet < limit) { this.arm(limit - quiet); return; }
    this.fired = true;
    this.ended = true;
    this.cut.abort(new WorkforceError('unavailable', STALL_MESSAGE, { details: { stalled: true } }));
  }
}
