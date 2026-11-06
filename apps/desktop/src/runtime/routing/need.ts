// Model by need (B-048 E4.2): the agent says what kind of model its work needs – model.set
// { need } – and routing picks the concrete one ("Main-KI denkt, Unterbewusstsein verwaltet"). The need
// is relative to `from`, the model the agent ran on when it asked:
//   stronger     – a higher tier than `from` (the lowest such tier first, ranked in 'best' cost mode);
//                  none: the same tier with a clearly better fit for the work (STRONGER_MARGIN)
//   cheaper      – a lower real cost than `from` (relCost × the account's cost factor, score.ts
//                  marginalCost; a plan's quota counts nearly free), ranked in 'economy'
//   faster       – a higher known output speed (≥ FASTER_RATIO) where both are known, else a lower tier that
//                  is not a local runtime, ranked in 'economy'
//   vision       – reads images
//   long_context – a larger context window than `from` (unknown `from`: at least LONG_CONTEXT_MIN);
//                  the window the engine or the curated caps report
// Every need except stronger skips models that are weak at the turn's work (strength < WEAK). The
// router (router.ts) applies it in the place of the agent's own request – after a chat or agent pin,
// inside the policy band and the pool's hard filters.
// Owns: these rules and their texts. Never: I/O, leaves the router's pool, or picks a model itself.

import type { RouteRequest } from '../contracts.ts';
import type { Account, Effort, ModelInfo } from '../../shared/model/providers.ts';
import { EFFORT_ORDER, effortRank } from '../models/efforts.ts';
import { WEAK, strengthOf, tierRank, type CostMode } from './score.ts';

export type ModelNeed = NonNullable<NonNullable<RouteRequest['previous']>['need']>['kind'];

export const MODEL_NEEDS: readonly ModelNeed[] = ['stronger', 'cheaper', 'faster', 'vision', 'long_context'];

/** Same tier counts as stronger only with a category strength at least this much higher. */
export const STRONGER_MARGIN = 0.1;
/** A measured output speed at least this many times `from`'s counts as faster. */
export const FASTER_RATIO = 1.2;
/** Without a known window of `from`, a long context means at least this many tokens. */
export const LONG_CONTEXT_MIN = 400_000;

/** Route reason of a need ("asked for a stronger model"). */
export const NEED_TEXT: Record<ModelNeed, string> = {
  stronger: 'asked for a stronger model', cheaper: 'asked for a cheaper model', faster: 'asked for a faster model',
  vision: 'asked for a model that reads images', long_context: 'asked for a longer context',
};

/** Why nothing met the need (the route reason and model.set's answer). */
export const NO_FIT_TEXT: Record<ModelNeed, string> = {
  stronger: 'no stronger model fits', cheaper: 'no cheaper model fits', faster: 'no faster model fits',
  vision: 'no model that reads images fits', long_context: 'no model with a longer context fits',
};

/** The reason of a stronger need without a stronger model: the same model, one effort step higher. */
export function raisedText(need: ModelNeed): string {
  return `${NO_FIT_TEXT[need]} · effort raised`;
}

/** Whether a route's reason says the need decided it (a model meeting it, or stronger's effort step) – else the usual rules did. */
export function needMet(reason: string, need: ModelNeed): boolean {
  return reason.includes(NEED_TEXT[need]) || reason.includes(raisedText(need));
}

export function isModelNeed(value: unknown): value is ModelNeed {
  return typeof value === 'string' && (MODEL_NEEDS as readonly string[]).includes(value);
}

/** The cost mode the candidates of a need are ranked in. */
export function needCostMode(need: ModelNeed, current: CostMode): CostMode {
  if (need === 'stronger') return 'best';
  return need === 'cheaper' || need === 'faster' ? 'economy' : current;
}

/** Context window of a model: the engine's or the curated one. */
export function contextOf(model: ModelInfo): number | undefined {
  const value = model.caps.contextTokens ?? model.scores?.contextTokens;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function speedOf(model: ModelInfo): number | undefined {
  const value = model.scores?.outputTokensPerSecond;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The lowest supported effort above `effort` (unknown support: the next one); the same at the top. */
export function stepUpEffort(effort: Effort, supported: readonly Effort[]): Effort {
  const order = supported.length ? EFFORT_ORDER.filter((item) => supported.includes(item)) : EFFORT_ORDER;
  return order.find((item) => effortRank(item) > effortRank(effort)) ?? effort;
}

export interface NeedInput<T> {
  need: ModelNeed;
  /** The model the agent ran on when it asked (undefined: unknown – every candidate qualifies by kind). */
  from?: ModelInfo;
  category: string;
  /** Real relative cost of an entry (score.ts marginalCost with its first account). */
  cost: (entry: T) => number;
}

/** The pool entries that meet the need (empty: none fits); ranking stays the router's. */
export function needCandidates<T extends { model: ModelInfo; accounts: Account[] }>(entries: readonly T[], input: NeedInput<T>): T[] {
  const { need, from, category } = input;
  const others = entries.filter((entry) => entry.model.id !== from?.id);
  const fit = others.filter((entry) => need === 'stronger' || strengthOf(entry.model, category) >= WEAK);
  switch (need) {
    case 'stronger': {
      if (!from) return fit;
      const above = fit.filter((entry) => tierRank(entry.model.tier) > tierRank(from.tier) && strengthOf(entry.model, category) >= WEAK);
      if (above.length) {
        const lowest = Math.min(...above.map((entry) => tierRank(entry.model.tier)));
        return above.filter((entry) => tierRank(entry.model.tier) === lowest);
      }
      return fit.filter((entry) => tierRank(entry.model.tier) === tierRank(from.tier) && strengthOf(entry.model, category) >= strengthOf(from, category) + STRONGER_MARGIN);
    }
    case 'cheaper': {
      const base = from ? entries.find((entry) => entry.model.id === from.id) : undefined;
      const limit = base ? input.cost(base) : from ? (from.relCost ?? Infinity) : Infinity;
      return fit.filter((entry) => input.cost(entry) < limit - 1e-9);
    }
    case 'faster': {
      const speed = from ? speedOf(from) : undefined;
      return fit.filter((entry) => {
        const own = speedOf(entry.model);
        if (speed !== undefined && own !== undefined) return own >= speed * FASTER_RATIO;
        return entry.model.tier !== 'local' && (!from || tierRank(entry.model.tier) < tierRank(from.tier));
      });
    }
    case 'vision':
      return fit.filter((entry) => entry.model.caps.vision === true);
    case 'long_context': {
      const base = from ? contextOf(from) : undefined;
      return fit.filter((entry) => {
        const window = contextOf(entry.model);
        return window !== undefined && (base !== undefined ? window > base : window >= LONG_CONTEXT_MIN);
      });
    }
  }
}

export interface NeedChoice<R> {
  /** The need's candidates as the router ranks them (empty: none fits). */
  ranked: R[];
  /** The model model.set named in its answer, while it still meets the need. */
  named?: R;
  /** stronger without a stronger model: `from` itself, to run one effort step higher. */
  raised?: R;
}

/**
 * The candidates of a need, ranked in its cost mode. `scope` = the pool's entries (cheaper and faster
 * may go below the mode's qualified tier like a model the agent names itself: the pool's `all`).
 */
export function needChoice<T extends { model: ModelInfo; accounts: Account[] }, R extends T>(input: NeedInput<T> & {
  scope: readonly T[]; rank: (entries: readonly T[], mode: CostMode) => R[]; costMode: CostMode; named?: string;
}): NeedChoice<R> {
  const ranked = input.rank(needCandidates(input.scope, input), needCostMode(input.need, input.costMode));
  const named = input.named ? ranked.find((entry) => entry.model.id === input.named) : undefined;
  if (ranked.length || input.need !== 'stronger' || !input.from) return { ranked, ...(named ? { named } : {}) };
  const own = input.scope.filter((entry) => entry.model.id === input.from!.id);
  const raised = own.length ? input.rank(own, input.costMode)[0] : undefined;
  return { ranked, ...(raised ? { raised } : {}) };
}
