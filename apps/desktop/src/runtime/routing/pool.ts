// The candidate pool of one route (router.ts; model-list.ts filters on its own): stage-wise hard filters – connected
// and not excluded → capability needs → not "never" for the category → inside the agent's policy band –, the mode's
// minimum tier as a preference (models below it only when none at or above it is connected), the accounts that can
// run each model now (its provider and listed accounts, healthy for that model – accounts.candidates gets it –, not
// excluded), and pay-per-use API keys only as a spill-over (unless Settings allow them or nothing else is left).
// Owns: these filters, their order and why a single model is unusable (for pins).
// Never: scores or picks a model, reads the policy itself, or changes state.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { EffectivePolicy } from './policies.ts';
import { NEVER, isPaid, strengthOf, tierRank, unmetNeed, withinTiers, type Tier } from './score.ts';

export interface PoolInput {
  s: RuntimeServices;
  models: readonly ModelInfo[];
  category: string;
  policy: Pick<EffectivePolicy, 'floorTier' | 'ceilingTier' | 'avoid'>;
  needs?: RouteRequest['needs'];
  minTier?: Tier | 'any';
  /** Model and account ids that just failed. */
  exclude?: ReadonlySet<string>;
}

export interface PoolEntry { model: ModelInfo; accounts: Account[] }

export interface Pool {
  /** The filter stages, so the error can say which one left nothing (unfit.ts nothingFits). */
  connected: ModelInfo[];
  capable: ModelInfo[];
  tiered: ModelInfo[];
  suitable: ModelInfo[];
  bounded: ModelInfo[];
  /** Runnable models with their accounts. */
  entries: PoolEntry[];
  accountsFor(model: ModelInfo): Account[];
  /** Why the model cannot run at all: 'unavailable', an unmet need or 'never'; undefined = it can. */
  unusable(model: ModelInfo): string | undefined;
  inBand(model: ModelInfo): boolean;
}

export function buildPool(input: PoolInput): Pool {
  const { s, category, policy, needs, minTier } = input;
  const exclude = input.exclude ?? new Set<string>();
  const allowPaid = s.settings.get().routing.allowPaidFallback;
  const memo = new Map<string, Account[]>();
  const accountsFor = (model: ModelInfo): Account[] => {
    let list = memo.get(model.id);
    if (!list) {
      list = s.accounts.candidates(model.engine, model.model).filter((account) => account.provider === model.provider
        && (!model.accounts.length || model.accounts.includes(account.id)) && !exclude.has(account.id));
      memo.set(model.id, list);
    }
    return list;
  };
  const structured = (model: ModelInfo) => { try { return s.engines.get(model.engine).caps.structured; } catch { return false; } };
  const tierOk = (model: ModelInfo) => !minTier || tierRank(model.tier) >= tierRank(minTier);
  const inBand = (model: ModelInfo) => withinTiers(model.tier, policy.floorTier, policy.ceilingTier) && !policy.avoid.includes(model.id);
  const unusable = (model: ModelInfo): string | undefined => {
    if (!model.available || exclude.has(model.id)) return 'unavailable';
    const need = unmetNeed(model, needs, structured(model));
    if (need) return need;
    if (strengthOf(model, category) <= NEVER) return 'never';
    return undefined;
  };

  // Stage-wise filtering keeps the reason when nothing is left.
  const connected = input.models.filter((model) => model.available && !exclude.has(model.id));
  const capable = connected.filter((model) => !unmetNeed(model, needs, structured(model)));
  const atTier = capable.filter(tierOk);
  const tiered = atTier.length ? atTier : capable; // the mode's tier is a preference, never a refusal
  const suitable = tiered.filter((model) => strengthOf(model, category) > NEVER);
  const bounded = suitable.filter(inBand);
  let all = bounded.map((model) => ({ model, accounts: accountsFor(model) })).filter((entry) => entry.accounts.length > 0);
  // Pay-per-use API keys are a spill-over only when the user allowed it (or nothing else exists).
  if (!allowPaid && all.some((entry) => entry.accounts.some((account) => !isPaid(account)))) {
    all = all.map((entry) => ({ model: entry.model, accounts: entry.accounts.filter((account) => !isPaid(account)) })).filter((entry) => entry.accounts.length > 0);
  }
  return { connected, capable, tiered, suitable, bounded, entries: all, accountsFor, unusable, inBand };
}
