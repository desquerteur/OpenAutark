// Plan accounts (Codex, Claude Code subscriptions): which providers are plans and which plan account the
// runtime's account selection uses first (the primary rule, runtime/accounts/candidates.ts); the opt-in
// rotation decides the rest there.
// Owns: the plan providers and the primary rule.
// Never: limits or cooling (the runtime's candidates decide those) and display text.

import type { Account, ProviderId } from './providers.ts';

export function isPlanProvider(provider: ProviderId): boolean {
  return provider === 'codex' || provider === 'claude';
}

/** Switched on and signed in (or not checked yet). Limits and cooling do not change who is primary. */
export function isUsableState(account: Account): boolean {
  return account.enabled && (account.state === 'ok' || account.state === 'unknown' || account.state === 'cooling');
}

/** Lower priority first, then the older account. */
export function byPriority(a: Account, b: Account): number {
  return a.priority - b.priority || a.createdAt - b.createdAt;
}

/** The first enabled, usable account of one provider: a plan that needs sign-in never blocks the next one. */
export function planPrimary(accounts: readonly Account[]): Account | undefined {
  return [...accounts].sort(byPriority).find(isUsableState);
}
