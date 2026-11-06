// The agent's own model.set request and the return rule D1 (RT2), for router.ts.
// - Request (RouteRequest.previous.explicit; `asked` = 'model' or 'effort', absent = both): a named
//   model beats default pins and weak priors (never the policy band); a named effort applies to whichever
//   model the turn gets – unless the agent policy or the chat choice sets the effort. A route the request shaped reports by 'request'
//   (BY_REQUEST, stored in runs.route.by); agents/next-route.ts skips such runs when it looks for
//   the choice to return to, so a request holds for one step (or its task's turns) only.
// - D1, same category as the run `previous` comes from (or an unknown one): the previous model
//   continues unless its prior is weak (< WEAK), with its effort. After a change of category it
//   continues only while it is not weak and scores within RETURN_MARGIN (0.3) of the best
//   candidate, and its effort is not carried over.
// - Effort: agent policy > chat choice > the agent's requested effort > the previous effort (same
//   model kept, same category) > default policy > category default (clamped by the router).
// Owns: these rules and their reason texts. Never: I/O, or leaves the policy band (the router
// passes only candidates inside it).

import type { RouteRequest } from '../contracts.ts';
import type { Effort, ModelInfo, RouteDecision } from '../../shared/model/providers.ts';
import { ROUTE_BY_REQUEST } from '../../shared/model/runs.ts';
import type { EffectivePolicy } from './policies.ts';
import { categoryLabel, defaultEffortFor } from './categories.ts';
import { WEAK, strengthOf } from './score.ts';

/** After a change of category the previous model stays only while its score is at most this far below the best. */
export const RETURN_MARGIN = 0.3;

/**
 * RouteDecision.by of a route the agent's own request shaped. 'request' is not a member of
 * RouteDecision['by'] in shared/model/providers.ts yet (not owned here) – hence the cast; the
 * stored runs.route.by is a plain string.
 */
export const BY_REQUEST = ROUTE_BY_REQUEST as string as RouteDecision['by'];

/** Appended to the route reason when the agent's request set the effort of a model it did not name. */
export const EFFORT_REQUESTED = 'effort requested by the agent';

type Previous = NonNullable<RouteRequest['previous']>;

/** The agent named this model itself (an effort-only request leaves the model to the usual rules). */
export function modelAsked(previous: Previous | undefined): boolean {
  return Boolean(previous?.explicit) && previous?.asked !== 'effort';
}

function effortAsked(previous: Previous | undefined): boolean {
  return Boolean(previous?.explicit) && previous?.asked !== 'model';
}

/** The run `previous` comes from had this category (an unknown one counts as the same). */
export function sameCategory(previous: Previous | undefined, category: string): boolean {
  return !previous?.category || previous.category === category;
}

/** The effort before clamping, and whether the agent's request set it. */
export function startEffort(policy: EffectivePolicy, previous: Previous | undefined, category: string, keptPrevious: boolean): { effort: Effort; requested: boolean } {
  const chosen = policy.agentEffort ?? policy.chatEffort;
  if (chosen) return { effort: chosen, requested: false };
  if (previous && effortAsked(previous)) return { effort: previous.effort, requested: true };
  if (previous && keptPrevious && sameCategory(previous, category)) return { effort: previous.effort, requested: false };
  return { effort: policy.defaultEffort ?? defaultEffortFor(category), requested: false };
}

/**
 * D1 for the previous model (a ranked candidate): undefined = it continues, else why it does not
 * (for the route reason). `best` = the top-ranked candidate, `from` = previous.category.
 */
export function returnBlocked(input: { previous: { model: ModelInfo; score: number }; best: { score: number }; category: string; from?: string }): string | undefined {
  const { previous, category, from } = input;
  if (strengthOf(previous.model, category) < WEAK) return `${previous.model.name} is weak at ${categoryLabel(category)}`;
  if (!from || from === category || input.best.score - previous.score <= RETURN_MARGIN) return undefined;
  return `new work (${categoryLabel(from)} → ${categoryLabel(category)}) · ${previous.model.name} is not close to the best fit`;
}
