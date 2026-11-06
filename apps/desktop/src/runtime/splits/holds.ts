// Parts that wait for an account (B-057 S11): a split run that ended because no account could run it (a usage limit or
// an outage – SplitRunEnd.wait) is queued again WITHOUT using an attempt and starts again after a pause (1 min, doubling
// up to 30 min). An account that becomes usable or a model that becomes available (agents/outages.ts OutageTracker)
// makes every held part due at once; one timer per earliest due time pumps then (no polling). A part waits at most a day
// in all (REDELIVERY_MAX_AGE_MS from its first hold); after that its end counts like any retryable failure. In memory: a
// restart starts held parts again (reconcile pumps).
// Owns: the due times of held parts and their wake-up. Never: starts a part (the runner pumps) or reads its runs.

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { REDELIVERY_MAX_AGE_MS } from '../agents/redelivery.ts';
import { OutageTracker } from '../agents/outages.ts';

/** The longest pause between two tries of a held part. */
const RECHECK_MS = 30 * 60_000;
/** The shortest hold (the first one; each further hold doubles it up to RECHECK_MS). */
export const MIN_HOLD_MS = 60_000;

export const WAIT_TEXT = 'No account can run it right now (a usage limit or an outage); it starts again when one can.';

export class SplitHolds {
  private readonly until = new Map<string, number>();
  /** splitId → its first hold and how often it was held. */
  private readonly since = new Map<string, { at: number; count: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tracker: OutageTracker | undefined;
  private readonly now: () => number;
  private readonly due: () => void;

  /** `due`: held parts may start now (the runner pumps). */
  constructor(now: () => number, due: () => void) {
    this.now = now;
    this.due = due;
  }

  /** Holds a part – a minute, doubling with each hold up to RECHECK_MS; false once it has waited a day (then its end counts as usual). */
  hold(splitId: string, _accounts: readonly Account[]): boolean {
    const now = this.now();
    const first = this.since.get(splitId)?.at ?? now;
    if (now - first >= REDELIVERY_MAX_AGE_MS) { this.until.delete(splitId); return false; } // its day is kept: it never waits again
    const count = (this.since.get(splitId)?.count ?? 0) + 1;
    this.since.set(splitId, { at: first, count });
    this.until.set(splitId, Math.min(now + Math.min(RECHECK_MS, MIN_HOLD_MS * 2 ** (count - 1)), first + REDELIVERY_MAX_AGE_MS));
    this.arm();
    return true;
  }

  /** The part is held and not due yet. */
  waiting(splitId: string): boolean {
    const at = this.until.get(splitId);
    return at !== undefined && at > this.now();
  }

  /** The part ended for good (or runs again): no hold is kept for it. */
  clear(splitId: string): void {
    this.until.delete(splitId);
    this.since.delete(splitId);
  }

  /** Account and model changes (OutageTracker transitions): a change that makes one usable makes every held part due. */
  watch(initial: { accounts: readonly Account[]; models: readonly ModelInfo[] }): { account(account: Account): void; removed(id: string): void; models(list: ModelInfo[]): void } {
    this.tracker = new OutageTracker([...initial.accounts], [...initial.models], this.now());
    return {
      account: (account) => { if (this.tracker?.account(account, this.now())) this.releaseAll(); },
      removed: (id) => this.tracker?.removed(id),
      models: (list) => { if (this.tracker?.models(list)) this.releaseAll(); },
    };
  }

  /** Every held part is due now (their day bound keeps counting). */
  private releaseAll(): void {
    if (!this.until.size) return;
    this.until.clear();
    this.disarm();
    this.due();
  }

  /** One timer for the earliest due time; when it fires, the parts due by then are no longer held. */
  private arm(): void {
    this.disarm();
    const next = Math.min(...this.until.values());
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = this.now();
      for (const [splitId, at] of this.until) if (at <= now) this.until.delete(splitId);
      this.arm();
      this.due();
    }, Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
