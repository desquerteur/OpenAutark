// The pure charge rule of an account, shared so the UI labels pay-per-use models the way the
// runtime bills them (runtime/models/pricing.ts chargeOf keeps the same rule; a unit test holds
// both together): an API key or environment key pays per use, a Codex/Claude Code CLI signed in
// with an API key (status plan 'api') too; local runtimes and keyless servers are free; every
// other login is a plan. Plus the UI's "first usable account" of a model (SG cost-guide labels).
// Owns: this rule for UI use. Never: I/O, prices, or which account a turn really gets (routing).

import type { Account, ModelInfo } from './providers.ts';

export type AccountCharge = 'paid' | 'plan' | 'free';

/** Local runtimes (runtime engines/http/common.ts LOCAL_PROVIDERS). */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
const PAID_AUTH: ReadonlySet<string> = new Set(['api_key', 'env']);

export function accountCharge(account: Pick<Account, 'auth' | 'provider' | 'plan'> | undefined): AccountCharge {
  if (!account) return 'plan';
  if (account.auth === 'local' || LOCAL_PROVIDER_IDS.has(account.provider)) return 'free';
  if (PAID_AUTH.has(account.auth)) return 'paid';
  if (account.auth === 'cli') return account.plan?.trim().toLowerCase() === 'api' ? 'paid' : 'plan';
  return 'free';
}

/** The account a model would most likely run on: its provider, listed accounts, enabled and signed in, lowest priority first. */
export function firstAccount(model: Pick<ModelInfo, 'provider' | 'accounts'>, accounts: readonly Account[]): Account | undefined {
  return accounts
    .filter((account) => account.provider === model.provider && account.enabled && account.state !== 'disabled' && account.state !== 'needs_login'
      && (!model.accounts.length || model.accounts.includes(account.id)))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
}
