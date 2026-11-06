// A person's own request (E1, 01.11.2026 – live D5: the Manager's answers to the person ran on Sonnet/medium as
// "chat · strongest fit" and answered from memory): a turn that answers a new line of a person runs on the strongest
// model the Work use allows – the highest tier connected, ranked like cost mode 'best' (the work plan keeps its bonus) –
// at effort high or above. Everything else – task, schedule and colleague wakes, the runtime's helper calls – keeps
// the usual score and stays cheap. One rule, applied by router.ts after pins, the agent's own model.set and the Work
// model chosen in Settings, and not while the person chose the cheaper cost mode.
// B-078 (D16, owner 06.11.2026: "2 % smarter at three times the price makes no sense; 20 % smarter at 1.5 times, for
// hard work, does"): the strongest pick weighs how capable a model is (its curated smarts) against its list price
// (relCost, not discounted by a plan – a plan's quota runs down at the same ratio), on top of the usual score in cost mode
// 'best'. So an ordinary line on a Claude plan runs on Opus 5.5, not on the older, 2.5x pricier Fable 5.1.
// Owns: what counts as a person's request and the strongest pick. Never: changes state, or overrides an effort the
// person or the agent fixed.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Effort } from '../../shared/model/providers.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { effortRank } from '../models/efforts.ts';
import type { PoolEntry } from './pool.ts';
import { WEAK, strengthOf, tierRank } from './score.ts';

/** The lowest effort a person's own request runs at (clamped to what the model offers). */
export const PERSON_EFFORT: Effort = 'high';

/** The route reason's part for such a turn. */
export const PERSON_TEXT = "a person's request · strongest model";

/** Lines a person writes to an agent: a chat message or an answer to the agent's question (not a task card or status line). */
const REQUEST_KINDS: ReadonlySet<string> = new Set(['text', 'answer']);

/** New chat lines the agent has not read yet (its read cursor) hold a line written by a person. */
export function personAsks(s: Pick<RuntimeServices, 'chats'>, request: Pick<RouteRequest, 'agent' | 'conversationId' | 'split'>): boolean {
  if (!request.conversationId || request.agent.id === SYSTEM_ID || request.split) return false;
  try {
    const member = s.chats.members(request.conversationId).find((item) => item.memberId === request.agent.id && !item.leftAt);
    if (!member) return false;
    const unseen = s.chats.messages(request.conversationId, { afterSeq: member.readSeq ?? 0, limit: 40 });
    return unseen.some((message) => message.authorKind === 'human' && REQUEST_KINDS.has(message.kind));
  } catch {
    return false; // a chat service without messages (a fake) or a read error: the usual route
  }
}

/** The pool's entries of its highest tier (the strongest kind of model connected for this work). */
export function topTier<T extends Pick<PoolEntry, 'model'>>(pool: readonly T[]): T[] {
  const top = Math.max(-1, ...pool.map((entry) => tierRank(entry.model.tier)));
  return pool.filter((entry) => tierRank(entry.model.tier) === top);
}

/** One smarts point is worth 0.01 of score (a prior strength spans −1…+1). */
const SMARTS_WEIGHT = 0.01;
/** Smarts of a model the priors do not rate. */
const SMARTS_UNKNOWN = 70;
/** What the whole price range (relCost 0 → 1) costs in score: Fable at 2.5x Opus needs 30 smarts points more to win. */
export const PRICE_WEIGHT = 0.5;
const TIER_PRICE: Record<string, number> = { local: 0, small: 0.05, strong: 0.3, frontier: 0.6 };

type Scored = Pick<PoolEntry, 'model'> & { score?: number };

/** A model's list price on the 0..1 scale (relCost, else a guess from its tier). */
function priceOf(model: Scored['model']): number {
  return model.relCost ?? TIER_PRICE[model.tier] ?? 0.3;
}

/** A model's worth for a person's request: its score + smarts − list price (see the header). */
export function personValue(entry: Scored): number {
  const { model } = entry;
  const smarts = typeof model.smarts === 'number' ? model.smarts : SMARTS_UNKNOWN;
  return (entry.score ?? 0) + SMARTS_WEIGHT * smarts - PRICE_WEIGHT * priceOf(model);
}

/** The previous model's session goes on unless the best one is worth this much more (Fable 5.1 → Opus 5.5 is about 0.3). */
export const KEEP_MARGIN = 0.2;

/**
 * The model for a person's request from `ranked` (the top tier, scored in cost mode 'best'): reordered by personValue
 * (smarts against list price), then the previous model when it is among them, not weak for the work and not clearly
 * worse value than the best (its session goes on), else the first – `left`: the previous model it leaves, `why`: for
 * being weak at the work, for costing more than the cheaper best ('value'), or for being clearly less capable than a
 * best that costs as much or more ('stronger') – the switch line names that why.
 */
export function strongestPick<T extends Scored>(ranked: readonly T[], category: string, previousId?: string): { entry: T; kept: boolean; left?: T; why?: 'weak' | 'value' | 'stronger' } | undefined {
  const order = ranked.map((entry, index) => ({ entry, index, value: personValue(entry) }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  const best = order[0];
  if (!best) return undefined;
  const previous = previousId ? order.find((item) => item.entry.model.id === previousId) : undefined;
  const weak = previous !== undefined && strengthOf(previous.entry.model, category) < WEAK;
  if (previous && !weak && best.value - previous.value <= KEEP_MARGIN) return { entry: previous.entry, kept: true };
  if (!previous || previous === best) return { entry: best.entry, kept: false };
  const why = weak ? 'weak' as const : priceOf(best.entry.model) < priceOf(previous.entry.model) ? 'value' as const : 'stronger' as const;
  return { entry: best.entry, kept: false, left: previous.entry, why };
}

/** `effort` raised to PERSON_EFFORT when lower. */
export function personEffort(effort: Effort): Effort {
  return effortRank(effort) < effortRank(PERSON_EFFORT) ? PERSON_EFFORT : effort;
}
