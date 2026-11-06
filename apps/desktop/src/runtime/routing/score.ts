// Deterministic routing math: tier bounds, capability needs, and the score of a model for a category under a cost
// mode – the curated prior strength (models/priors.ts, resources/model-priors.json) + tier fit + plan headroom −
// relative cost, subscriptions nearly free while quota remains. Headroom is the smallest remaining share of the
// windows that limit this model on the account (5h, weekly, the model's own window such as weekly-opus).
// B-044 work plan: with a work plan (the Work use naming a plan, Settings.routing.work; auto = 'claude' while a Claude Code plan login is
// enabled – preference.ts workPlanOf) an agent turn's model on that provider's plan login gets WORK_PLAN_BONUS while
// the plan has at least WORK_PLAN_MIN_HEADROOM % left – a preference, never a pin.
// "Paid" is the booking rule of models/pricing.ts (chargeOf), so routing and spend agree.
// Owns: the weights. Never: I/O – the router passes models and accounts in.

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { headroom as remaining } from '../accounts/candidates.ts';
import { LOCAL_PROVIDERS } from '../engines/http/common.ts';
import { chargeOf } from '../models/pricing.ts';
import { TIER_ORDER } from './policies.ts';

export type CostMode = 'economy' | 'balanced' | 'best';
export type Tier = ModelInfo['tier'];

/** Strength at or below this means "never for this category" (priors use −1 for that). */
export const NEVER = -0.95;
/** Return rule: the previous model is kept unless its strength for the category is below this. */
export const WEAK = -0.3;

const TIER_FIT: Record<CostMode, Record<Tier, number>> = {
  economy: { local: 0.15, small: 0.3, strong: 0, frontier: -0.3 },
  balanced: { local: -0.15, small: -0.05, strong: 0.1, frontier: 0.1 },
  best: { local: -0.4, small: -0.3, strong: 0, frontier: 0.3 },
};
const COST_WEIGHT: Record<CostMode, number> = { economy: 0.8, balanced: 0.35, best: 0.1 };
const PREFER_BONUS = 0.25;
const HEADROOM_WEIGHT = 0.2;
const TIER_COST: Record<Tier, number> = { local: 0, small: 0.05, strong: 0.3, frontier: 0.6 };
const PLAN_PROVIDERS: ReadonlySet<string> = new Set(['codex', 'claude']);
/** B-044: bonus of a model on the preferred work plan (the Work use, preference.ts workPlanOf) while it has quota. */
export const WORK_PLAN_BONUS = 0.3;
/** Below this share left (percent) the work plan is no longer preferred. */
export const WORK_PLAN_MIN_HEADROOM = 20;

export function tierRank(tier: Tier | 'any' | undefined): number {
  return tier && tier !== 'any' ? TIER_ORDER.indexOf(tier) : -1;
}

export function withinTiers(tier: Tier, floor?: Tier, ceiling?: Tier): boolean {
  const rank = tierRank(tier);
  return (floor === undefined || rank >= tierRank(floor)) && (ceiling === undefined || rank <= tierRank(ceiling));
}

export function strengthOf(model: ModelInfo, category: string): number {
  const value = model.strengths[category];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type Need = 'vision' | 'computerUse' | 'structured';

/** First unmet need, or undefined. `engineStructured` = the engine can enforce output schemas. */
export function unmetNeed(model: ModelInfo, needs: { vision?: boolean; computerUse?: boolean; structured?: boolean } | undefined, engineStructured: boolean): Need | undefined {
  if (needs?.vision && model.caps.vision !== true) return 'vision';
  if (needs?.computerUse && model.caps.computerUse !== true) return 'computerUse';
  if (needs?.structured && model.caps.structuredOutput !== true && !(model.caps.structuredOutput !== false && engineStructured)) return 'structured';
  return undefined;
}

/**
 * Pay-per-use connection: an API key (typed, or from the environment – auth 'env'), or a Codex/Claude
 * Code login with an API key (plan 'api') – the same accounts whose turns are booked as spend
 * (models/pricing.ts). Plans and local runtimes are not.
 */
export function isPaid(account: Account): boolean {
  return chargeOf(account) === 'paid';
}

/**
 * Share of the list price that a turn on this account really costs at the margin:
 * local 0, plans with quota left ~0.15 (less headroom for `model` → closer to full), paid 1.
 */
export function costFactor(account: Account | undefined, now: number, model?: string): number {
  if (!account) return 1;
  if (isPaid(account)) return 1;
  if (account.auth === 'local' || LOCAL_PROVIDERS.has(account.provider)) return 0;
  if (!PLAN_PROVIDERS.has(account.provider) || account.auth !== 'cli') return 0.5;
  const headroom = remaining(account, now, model);
  if (headroom === undefined) return 0.3;
  if (headroom < 10) return 1;
  return headroom < 30 ? 0.5 : 0.15;
}

/** What a turn on this model and account really costs, relative (relCost × costFactor) – the 'cheaper' need compares it. */
export function marginalCost(model: ModelInfo, account: Account | undefined, now: number): number {
  return (model.relCost ?? TIER_COST[model.tier]) * costFactor(account, now, model.model);
}

function headroomBonus(account: Account | undefined, now: number, model?: string): number {
  if (!account || !PLAN_PROVIDERS.has(account.provider)) return 0;
  const headroom = remaining(account, now, model);
  return headroom === undefined ? 0 : ((headroom - 50) / 100) * HEADROOM_WEIGHT;
}

/** The part of a score that prefers a plan rather than a model (headroom bonus + work plan bonus). */
function planPreference(account: Account | undefined, workPlan: string | undefined, now: number, model?: string): number {
  return headroomBonus(account, now, model) + workPlanBonus(account, workPlan, now, model);
}

/** WORK_PLAN_BONUS for a plan login of the work plan's provider with quota left (unknown limits count as left). */
export function workPlanBonus(account: Account | undefined, workPlan: string | undefined, now: number, model?: string): number {
  if (!workPlan || !account || account.provider !== workPlan || chargeOf(account) !== 'plan') return 0;
  const left = remaining(account, now, model);
  return left === undefined || left >= WORK_PLAN_MIN_HEADROOM ? WORK_PLAN_BONUS : 0;
}

export interface ScoreInput {
  model: ModelInfo;
  account?: Account; // best account for the model
  category: string;
  costMode: CostMode;
  preferred: boolean;
  now: number;
  /** B-044: the provider agent work prefers (preference.ts workPlanOf); agents only. */
  workPlan?: string;
}

export function scoreModel(input: ScoreInput): number {
  const { model, account, costMode, now } = input;
  const relCost = model.relCost ?? TIER_COST[model.tier];
  return strengthOf(model, input.category)
    + TIER_FIT[costMode][model.tier]
    - COST_WEIGHT[costMode] * relCost * costFactor(account, now, model.model)
    + (input.preferred ? PREFER_BONUS : 0)
    + planPreference(account, input.workPlan, now, model.model);
}
