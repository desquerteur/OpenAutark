// The cost of one finished turn (PR9): only real charges reach the agent's budget.
// A failover turn is priced per attempt: turn.ts mergeAttempts keeps the final attempt's own
// usage as `lastUsage`, the difference is the first attempt's, and the run's 'failover' note
// names that attempt's account and model. Each attempt is priced on its own account and model
// (models/pricing.ts with the catalog's Artificial Analysis prices and the shipped priors'
// curated prices; the cached input an attempt reported at the prior's cached price, when it has one); the paid amount is
// booked as the agent's 'tokens' spend, the cost basis and a plan's notional list-price cost are stored on the run (store/run-cost.ts).
// Owns: the attempt split, the price lookups and the booking.
// Never: books a plan's or a local model's cost, invents a price, or fails the turn (a lookup or
// write that fails is logged; without the failover note the whole turn counts on its account).

import type { RuntimeServices } from '../contracts.ts';
import { priorFor } from '../models/catalog-merge.ts';
import { Priors } from '../models/priors.ts';
import { attemptCost, combineCosts, type AttemptCost, type RunCost, type TokenUsage } from '../models/pricing.ts';
import { addCache } from '../engines/shared.ts';
import { RunCostRepo } from '../store/run-cost.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { AttemptResult, RoutedTurn } from './turn-types.ts';

export interface TurnCost {
  /** The whole run: the real charge (`costUsd`), the basis and the notional plan cost. */
  run: RunCost;
  /** The final attempt alone (its model's outcome statistics). */
  last: AttemptCost;
}

/** Prices the turn's attempts (see the header); a lookup that throws prices the whole turn on its account without list prices. */
export function priceTurn(services: RuntimeServices, turn: Pick<RoutedTurn, 'account' | 'route'>, attempt: Pick<AttemptResult, 'usage' | 'lastUsage'>, runId: string): TurnCost {
  try {
    return priceAttempts(services, turn, attempt, runId);
  } catch (error) {
    services.log.warn('pricing the turn failed', { runId, error: String(error) });
    const last = attemptCost({ account: turn.account, usage: attempt.usage });
    return { run: combineCosts([last]), last };
  }
}

function priceAttempts(services: RuntimeServices, turn: Pick<RoutedTurn, 'account' | 'route'>, attempt: Pick<AttemptResult, 'usage' | 'lastUsage'>, runId: string): TurnCost {
  const priors = Priors.shipped(services.paths?.resources, (error) => services.log.warn('model priors not loaded for pricing', { error: String(error) }));
  const last = priceAttempt(services, priors, turn.account, turn.route.modelId, attempt.lastUsage ?? attempt.usage);
  const parts = [last];
  const first = attempt.lastUsage ? firstUsage(attempt.usage, attempt.lastUsage) : undefined;
  if (first) {
    const from = failoverFrom(services, runId);
    const account = from ? services.accounts.get(from.account) : turn.account; // a removed account is no charge
    parts.unshift(priceAttempt(services, priors, account, from?.model ?? turn.route.modelId, first));
  }
  return { run: combineCosts(parts), last };
}

/** Stores the basis and notional cost on the run (before runs.finish, so its event can carry them). */
export function saveRunCost(services: RuntimeServices, runId: string, cost: RunCost): void {
  try { new RunCostRepo(services.db).save(runId, { basis: cost.basis, notionalUsd: cost.notionalUsd }); } catch (error) {
    services.log.warn('storing the run cost failed', { runId, error: String(error) });
  }
}

/** Books the real charge as the agent's model usage (nothing for plans, local models or 0). */
export function bookTurnCost(services: RuntimeServices, agentId: string, runId: string, cost: RunCost): void {
  if (!cost.costUsd || cost.costUsd <= 0) return;
  try { services.spend.record({ agentId, amount: cost.costUsd, currency: 'USD', kind: 'tokens', ref: runId }); } catch (error) {
    services.log.warn('recordSpend failed', { error: String(error) });
  }
}

function priceAttempt(services: RuntimeServices, priors: Priors, account: Account | undefined, modelId: string, usage: TokenUsage): AttemptCost {
  let model: ModelInfo | undefined;
  try { model = services.catalog.get(modelId); } catch { model = undefined; }
  const providerModel = model?.model ?? modelId.slice(modelId.indexOf(':') + 1);
  return attemptCost({ account, usage, model, prior: priorFor(priors, providerModel, modelId) });
}

/** The first attempt's usage: the merged total minus the final attempt's own (its cached input too, when reported). */
export function firstUsage(total: TokenUsage, last: TokenUsage): TokenUsage | undefined {
  const inputTokens = Math.max(0, total.inputTokens - last.inputTokens);
  const outputTokens = Math.max(0, total.outputTokens - last.outputTokens);
  let costUsd: number | undefined;
  if (total.costUsd !== undefined) {
    const rest = total.costUsd - (last.costUsd ?? 0);
    // Both reported and nothing is left: the first attempt reported none (mergeAttempts adds a missing cost as 0).
    costUsd = last.costUsd === undefined ? total.costUsd : rest > 1e-9 ? rest : undefined;
  }
  if (!inputTokens && !outputTokens && costUsd === undefined) return undefined;
  const cache = addCache(total, last, -1);
  return costUsd === undefined ? { inputTokens, outputTokens, ...cache } : { inputTokens, outputTokens, costUsd, ...cache };
}

/** The account and model of the attempt before the failover (turn.ts journals them as a note). */
function failoverFrom(services: RuntimeServices, runId: string): { account: string; model: string } | undefined {
  try {
    const items = services.runs.items(runId);
    for (let index = items.length - 1; index >= 0; index--) {
      const failover = items[index].kind === 'note' ? items[index].data.failover : undefined;
      if (!failover || typeof failover !== 'object') continue;
      const { from, fromAccount } = failover as { from?: unknown; fromAccount?: unknown };
      if (typeof from === 'string' && typeof fromAccount === 'string') return { account: fromAccount, model: from };
    }
  } catch { /* no journal to read (tests): the whole turn counts on its account */ }
  return undefined;
}
