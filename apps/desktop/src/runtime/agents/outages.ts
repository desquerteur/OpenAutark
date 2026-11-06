// Outages of agent turns (a usage limit, or no model/account reachable): no failure of the work, retried when it ends.
// isOutage names those turn outcomes; OutageTracker tells which account and model changes end one (an account that
// became usable, a model that became available) – tasks/ownership.ts brings task retries forward on them and
// agents/redelivery.ts re-delivers a cut-off chat turn; onlineDeliveryAt is when a turn may run after the host's
// 'online' (after a short settle, past the short coolings the outage left).
// Owns: these pure helpers. Never: plans wakes, reads services, or polls.

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { isHealthy } from '../accounts/candidates.ts';
import { OVERLOAD_COOLDOWN_MS } from '../accounts/failure.ts';

/** A usage limit or an outage (signed out, nothing connected, connection lost): no stall, retried later. */
export const isOutage = (outcome: string): boolean => outcome === 'limit' || outcome === 'unavailable';

/** Which account and model changes end an outage. */
export class OutageTracker {
  private readonly usable = new Map<string, boolean>();
  private available: Set<string>;

  constructor(accounts: Account[], models: ModelInfo[], now: number) {
    for (const account of accounts) this.usable.set(account.id, isHealthy(account, now));
    this.available = availableIds(models);
  }

  /** True when this change made the account usable (new, signed in again, enabled, cooled down). */
  account(account: Account, now: number): boolean {
    const was = this.usable.get(account.id);
    const is = isHealthy(account, now);
    this.usable.set(account.id, is);
    return is && was !== true;
  }

  removed(accountId: string): void {
    this.usable.delete(accountId);
  }

  /** True when a model became available. */
  models(list: ModelInfo[]): boolean {
    const next = availableIds(list);
    const added = [...next].some((id) => !this.available.has(id));
    this.available = next;
    return added;
  }
}

const availableIds = (models: ModelInfo[]) => new Set(models.filter((model) => model.available).map((model) => model.id));

/** After the host's 'online' at least this long before a retry (the new connection settles). */
export const ONLINE_SETTLE_MS = 5_000;
/** Past a cooling's end before the retry: a timer may fire a few ms early. */
export const COOLING_END_MARGIN_MS = 1_000;

/** When a turn after the host's 'online' may run: not before ONLINE_SETTLE_MS, and only once the short coolings a lost connection set are over. */
export function onlineDeliveryAt(accounts: readonly Pick<Account, 'enabled' | 'coolingUntil'>[], now: number): number {
  let at = now + ONLINE_SETTLE_MS;
  for (const account of accounts) {
    const until = account.enabled ? account.coolingUntil : undefined;
    if (until !== undefined && until > now && until <= now + OVERLOAD_COOLDOWN_MS) at = Math.max(at, until + COOLING_END_MARGIN_MS);
  }
  return at;
}
