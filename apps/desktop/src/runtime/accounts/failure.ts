// What a failed engine attempt says about its account, and the consequence for that account – one
// source for agent turns (agents/turn.ts) and helper calls (decision/engine-runner.ts; audit 23.10.2026:
// a failed helper call recorded nothing, so a signed-out, used-up or missing account stayed 'ok' for the
// router and every later helper call first spent a failing attempt on it).
//   limit → cooling with the provider's retry hint or LIMIT_COOLDOWN_MS (a model's own used-up window,
//     e.g. weekly-opus, only keeps that model away until its reset – the account stays);
//   a Codex/Claude Code plan signed out → needs_login, and once per sign-out (B-047 D10) the sign-in work
//     (accounts/relogin.ts: a task for an agent, or the person's to-do) – without that service one notification
//     when the caller can send one. The service comes from the deps or, for callers whose deps do not carry it
//     (the helper calls of decision/engine-runner.ts, which often meet a sign-out first), from the account
//     service it is attached to (attachRelogin, by Relogin.watch – keyed by that instance, so runtimes never mix);
//   CLI confirmed missing ("… is not installed.") → error;
//   anything else unavailable (overload, connection, a CLI that could not start, a rejected or missing
//     API key – 401/403 may concern one model only; B-059: a provider overloaded or unreachable,
//     engines/provider-outage.ts) → a short cooling;
//   a timeout is the turn's own (B-075: a cold Codex app-server that did not open the thread in time) → nothing.
// B-059: whether any account that can run an agent turn is usable now (turnAccountUsable) – the outage holds wait
// for it (agents/redelivery.ts, tasks/outages.ts holdWakes); a media-only account (B-058) never counts.
// Owns: this classification and these consequences. Never: failover or routing (the callers decide),
// a second notification for the same sign-out (markUnavailable says whether the state changed).

import { MEDIA_ONLY_PROVIDERS, type Account } from '../../shared/model/providers.ts';
import { isPlanProvider } from '../../shared/model/plan-roles.ts';
import type { AccountService, Clock, NotificationService } from '../contracts.ts';
import type { ReloginService } from '../contracts/relogin.ts';
import type { EngineTurnResult } from '../engines/types.ts';
import { engineFor, isHealthy, modelOnlyLimit } from './candidates.ts';

export const LIMIT_COOLDOWN_MS = 15 * 60_000;
export const OVERLOAD_COOLDOWN_MS = 5 * 60_000;
/** Floor for provider retry hints of 0 (a reset "now"), so retries never spin on a used-up plan. */
export const MIN_COOLDOWN_MS = 60_000;
const SIGNED_OUT = /not signed in|not logged in|sign in|rejected this connection|api key/i;
/** Only the unambiguous message: "Codex is not installed or could not start." also covers a slow or crashed start. */
const NOT_INSTALLED = /\bis not installed\.?$/i;

export type AccountFailure = 'limit' | 'signed_out' | 'missing' | 'overload';

/** B-047 D10: the sign-in work of an account service instance (see the header); returns the detach function. */
const attached = new WeakMap<object, ReloginService>();
export function attachRelogin(accounts: object, relogin: ReloginService): () => void {
  attached.set(accounts, relogin);
  return () => { if (attached.get(accounts) === relogin) attached.delete(accounts); };
}

/** What a failed attempt says about its account; undefined when the model or the turn failed, not the account. */
export function accountFailure(result: EngineTurnResult): AccountFailure | undefined {
  if (result.stop === 'limit' || (result.stop === 'error' && result.error?.code === 'rate_limited')) return 'limit';
  if (result.stop !== 'error' || result.error?.code !== 'unavailable') return undefined;
  if (SIGNED_OUT.test(result.error.message)) return 'signed_out';
  return NOT_INSTALLED.test(result.error.message) ? 'missing' : 'overload';
}

export interface FailureDeps {
  accounts: Pick<AccountService, 'get' | 'markLimited' | 'markUnavailable'>;
  clock: Clock;
  /** The "Sign in to …" to-do; without it the account's state alone shows the sign-in (Settings). */
  notifications?: Pick<NotificationService, 'notify'>;
  /** B-047 D10: the sign-in work (a task or the person's to-do) instead of the notification. */
  relogin?: ReloginService;
}

/**
 * Records what a failed attempt on `account` running `model` (the provider's model id) says about the
 * account; returns the failure (undefined: nothing to record). Errors of the account service propagate.
 */
export function recordAccountFailure(deps: FailureDeps, account: Account, model: string, result: EngineTurnResult): AccountFailure | undefined {
  const failure = accountFailure(result);
  if (!failure) return undefined;
  // Only Codex/Claude Code plans have a sign-in to repeat (Settings › Sign in), so only they get needs_login.
  const signIn = failure === 'signed_out' && account.auth === 'cli' && isPlanProvider(account.provider);
  if (signIn || failure === 'missing') {
    const changed = deps.accounts.markUnavailable(account.id, signIn ? 'needs_login' : 'error');
    const relogin = deps.relogin ?? attached.get(deps.accounts);
    if (changed && signIn && relogin) {
      relogin.signedOut(deps.accounts.get(account.id) ?? { ...account, state: 'needs_login' });
    } else if (changed && signIn) {
      deps.notifications?.notify({
        kind: 'todo', title: `Sign in to ${account.label}`,
        body: `Agents cannot use ${account.label} until you sign in again in Settings › Models.`,
      });
    }
    return failure;
  }
  const now = deps.clock.now();
  if (failure === 'limit') {
    const fresh = deps.accounts.get(account.id);
    if (fresh && modelOnlyLimit(fresh, now, model)) return failure;
  }
  const wait = result.error?.retryAfterMs ?? (failure === 'limit' ? LIMIT_COOLDOWN_MS : OVERLOAD_COOLDOWN_MS);
  deps.accounts.markLimited(account.id, now + Math.max(MIN_COOLDOWN_MS, wait));
  return failure;
}

/** B-059: the enabled accounts that can run an agent turn (an engine, never a media-only one). */
export function turnAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => account.enabled && engineFor(account.provider) !== undefined && !MEDIA_ONLY_PROVIDERS.includes(account.provider));
}

/** B-059: one of them is usable now – not cooling, used up, signed out or failing (candidates.ts isHealthy). */
export function turnAccountUsable(accounts: readonly Account[], now: number): boolean {
  return turnAccounts(accounts).some((account) => isHealthy(account, now));
}
