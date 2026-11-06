// Time source for the runtime. Everything that needs "now" receives a Clock, so tests can
// control time without fake timers.
// Owns: the system clock and a manual test clock. Never: timers or scheduling (see schedules/).

import type { Clock } from '../contracts.ts';

/** Wall-clock time in epoch milliseconds. */
export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to (tests, replays). */
export class ManualClock implements Clock {
  private value: number;

  constructor(start = Date.UTC(2026, 9, 17, 9, 0, 0)) {
    this.value = start;
  }

  now(): number {
    return this.value;
  }

  set(ms: number): void {
    this.value = ms;
  }

  advance(ms: number): number {
    this.value += ms;
    return this.value;
  }
}
