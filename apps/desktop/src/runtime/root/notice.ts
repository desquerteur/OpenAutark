// The quiet notice of the open data folder's documents (B-044; extracted from agent-core/store.ts setNotice): one
// problem per document (an invalid section, a file too large to use …), deduplicated, so the owner's hook – a
// log line, an event the UI shows quietly – hears it only when it comes, changes or goes.
// Owns: this state. Never: shows anything itself or decides what a problem is (the owner does).

import type { Clock } from '../contracts.ts';

export interface TextNotice<P extends string = string> {
  problem: P;
  at: number;
  /** One short line for the person (no paths, no file content). */
  detail?: string;
}

export type NoticeHook<P extends string> = (notice: TextNotice<P> | undefined) => void;

/** A deduplicated notice: the hook hears it only when the problem (or its detail) comes, changes or goes. */
export class QuietNotice<P extends string = string> {
  current?: TextNotice<P>;
  private readonly clock: Clock;
  private readonly hook?: NoticeHook<P>;

  constructor(clock: Clock, hook?: NoticeHook<P>) {
    this.clock = clock;
    this.hook = hook;
  }

  /** Sets (or with undefined clears) the problem; true when it changed and the hook was told. */
  set(problem: P | undefined, detail?: string): boolean {
    if (this.current?.problem === problem && this.current?.detail === detail) return false;
    this.current = problem === undefined ? undefined : { problem, at: this.clock.now(), ...(detail ? { detail } : {}) };
    this.hook?.(this.current);
    return true;
  }
}
