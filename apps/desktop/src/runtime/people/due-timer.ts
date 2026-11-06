// One re-armable timer for "the earliest next step" (agents/redelivery, day/keep-awake, day/morning) – armed
// for one moment at a time, never ticking. A moment
// beyond what setTimeout holds (~24.8 days) fires early and the owner simply arms it again.
// Owns: the one handle. Never: decides what is due (its owner recomputes on every fire).

import type { Timers } from './join.ts';

const MAX_DELAY_MS = 2_147_483_647;

export const REAL_DUE_TIMERS: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clear: (handle) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export class DueTimer {
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly fire: () => void;
  private handle: unknown;
  private at: number | undefined;

  constructor(timers: Timers, now: () => number, fire: () => void) {
    this.timers = timers;
    this.now = now;
    this.fire = fire;
  }

  /** Armed for `at` (undefined = nothing due); the same moment again keeps the running timer. */
  arm(at: number | undefined): void {
    if (at === this.at && (this.handle !== undefined || at === undefined)) return;
    this.stop();
    if (at === undefined) return;
    this.at = at;
    this.handle = this.timers.set(() => { this.handle = undefined; this.at = undefined; this.fire(); }, Math.min(MAX_DELAY_MS, Math.max(0, at - this.now())));
  }

  stop(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
    this.at = undefined;
  }
}
