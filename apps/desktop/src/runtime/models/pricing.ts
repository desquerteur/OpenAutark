// What an agent turn costs in real money (PR9). Budgets and the daily cap count only real charges:
// a subscription plan (a Codex or Claude Code login …) costs nothing per turn, whatever price the
// engine reports – that stays on the run as the notional list-price cost ("plan, no charge").
// Rules:
// * Paid = pay-per-use: an API key (auth 'api_key'), a key from the environment (auth 'env'),
//   or a Codex/Claude Code CLI signed in with an API key (its status check reports plan 'api').
//   Local runtimes and servers without a key are free; every other account is a plan.
// * The price of one attempt's tokens, first source that knows it: the cost the provider or
//   engine reported (OpenRouter usage.cost, Claude Code total_cost_usd) → tokens × the curated price in
//   model-priors.json → tokens × the daily keyless OpenRouter list price (B-078, price-feed.ts) → none:
//   a paid attempt is booked with amount 0 and flagged 'unpriced'. A list price is used only
//   when it covers every kind of token the attempt used (output tokens need an output price).
// * A failover turn is priced per attempt (each on its own account and model) and combined: the
//   paid amounts add up, the plan attempts' notional costs add up, and the weakest paid basis
//   names the run (one unpriced attempt flags the whole run).
// Every input token counts at the list input price, except the cached input the engine reported (Codex's
// cached input, Claude's cache reads) when the curated prior has a cached price (priceCachedInputPerM):
// that part then counts at it. Cache writes are billed a little higher and count at the input price, so
// without a cached price the estimate with prompt caching usually errs high. On a paid account a cached
// price in the priors makes budgets and the daily cap count less than the plain input price would.
// Owns: chargeOf, attemptCost, combineCosts. Never: I/O, invents a price, books spend
// (agents/turn-cost.ts does).

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { CostBasis } from '../../shared/model/runs.ts';
import { LOCAL_PROVIDERS } from '../engines/http/common.ts';
import type { CacheTokens } from '../engines/types.ts';
import { cachedInput } from '../engines/shared.ts';
import type { PriorEntry } from './priors.ts';

export type Charge = 'paid' | 'plan' | 'free';

/** Pay-per-use auth kinds ('env' is the detected environment key). */
const PAID_AUTH: ReadonlySet<string> = new Set(['api_key', 'env']);
/** The plan a Codex/Claude Code status check reports for an API-key login. */
const API_LOGIN_PLAN = 'api';

/** Does a turn on this account cost real money ('paid'), nothing per turn ('plan') or nothing at all ('free')? */
export function chargeOf(account: Pick<Account, 'auth' | 'provider' | 'plan'> | undefined): Charge {
  if (!account) return 'plan';
  if (account.auth === 'local' || LOCAL_PROVIDERS.has(account.provider)) return 'free';
  if (PAID_AUTH.has(account.auth)) return 'paid';
  if (account.auth === 'cli') return account.plan?.trim().toLowerCase() === API_LOGIN_PLAN ? 'paid' : 'plan';
  return 'free'; // 'none': a server without a key bills nobody
}

export interface TokenUsage extends CacheTokens {
  /** All input, the cached part included. */
  inputTokens: number;
  outputTokens: number;
  /** What the provider or engine reported for these tokens. */
  costUsd?: number;
}

export interface AttemptCost {
  basis: CostBasis;
  /** The real charge (paid attempts only; 0 when unpriced). */
  usd?: number;
  /** A plan attempt's list-price equivalent, when known. */
  notionalUsd?: number;
}

export interface RunCost {
  basis: CostBasis;
  /** The real charge of the turn: booked as the agent's spend (undefined: no paid attempt). */
  costUsd?: number;
  notionalUsd?: number;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** Tokens × list prices per 1M (the cached input at `cachedInputPerM` when given); undefined when a needed price is missing. */
export function tokenPrice(usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | keyof CacheTokens>, prices: { inputPerM?: number; outputPerM?: number; cachedInputPerM?: number }): number | undefined {
  const input = Math.max(0, usage.inputTokens || 0);
  const output = Math.max(0, usage.outputTokens || 0);
  if ((input > 0 && prices.inputPerM === undefined) || (output > 0 && prices.outputPerM === undefined)) return undefined;
  if (prices.inputPerM === undefined && prices.outputPerM === undefined) return undefined;
  const cached = prices.cachedInputPerM === undefined ? 0 : Math.min(input, cachedInput(usage));
  return round(((input - cached) * (prices.inputPerM ?? 0) + cached * (prices.cachedInputPerM ?? 0) + output * (prices.outputPerM ?? 0)) / 1_000_000);
}

/**
 * The list price of the tokens: the model's own list price when its row carries one (older rows), else the curated prior
 * (with its cached price, when it has one), else the daily keyless list's price on the model (B-078, models/price-feed.ts).
 */
export function listPrice(usage: TokenUsage, model?: Pick<ModelInfo, 'scores' | 'price'>, prior?: Pick<PriorEntry, 'priceInputPerM' | 'priceOutputPerM' | 'priceCachedInputPerM'>): { usd: number; basis: 'list-price' | 'prior-price' } | undefined {
  const scores = model?.scores;
  const listed = scores ? tokenPrice(usage, { inputPerM: valid(scores.priceInputPerM), outputPerM: valid(scores.priceOutputPerM) }) : undefined;
  if (listed !== undefined) return { usd: listed, basis: 'list-price' };
  const curated = prior ? tokenPrice(usage, { inputPerM: valid(prior.priceInputPerM), outputPerM: valid(prior.priceOutputPerM), cachedInputPerM: valid(prior.priceCachedInputPerM) }) : undefined;
  if (curated !== undefined) return { usd: curated, basis: 'prior-price' };
  const fed = model?.price?.source === 'feed' ? tokenPrice(usage, { inputPerM: valid(model.price.inputPerM), outputPerM: valid(model.price.outputPerM) }) : undefined;
  return fed !== undefined ? { usd: fed, basis: 'list-price' } : undefined;
}

function valid(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reported(usage: TokenUsage): number | undefined {
  const cost = usage.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? round(cost) : undefined;
}

/** The cost of one attempt on its account and model (see the header). */
export function attemptCost(input: { account?: Pick<Account, 'auth' | 'provider' | 'plan'>; usage: TokenUsage; model?: Pick<ModelInfo, 'scores' | 'price'>; prior?: Pick<PriorEntry, 'priceInputPerM' | 'priceOutputPerM' | 'priceCachedInputPerM'> }): AttemptCost {
  const charge = chargeOf(input.account);
  if (charge === 'free') return { basis: 'free' };
  const own = reported(input.usage);
  if (charge === 'plan') {
    const notional = own ?? listPrice(input.usage, input.model, input.prior)?.usd;
    return notional !== undefined ? { basis: 'plan', notionalUsd: notional } : { basis: 'plan' };
  }
  if (own !== undefined) return { basis: 'provider', usd: own };
  const list = listPrice(input.usage, input.model, input.prior);
  return list ? { basis: list.basis, usd: list.usd } : { basis: 'unpriced', usd: 0 };
}

/** Paid bases from the most to the least certain: the weakest one names a combined run. */
const PAID_ORDER: readonly CostBasis[] = ['provider', 'list-price', 'prior-price', 'unpriced'];

/** The run's cost from its attempts (one, or two after a failover). */
export function combineCosts(parts: readonly AttemptCost[]): RunCost {
  const paid = parts.filter((part) => part.usd !== undefined);
  const notional = parts.filter((part) => part.notionalUsd !== undefined);
  const out: RunCost = { basis: 'free' };
  if (paid.length) {
    out.basis = paid.map((part) => part.basis).reduce((worst, basis) => (PAID_ORDER.indexOf(basis) > PAID_ORDER.indexOf(worst) ? basis : worst), 'provider');
    out.costUsd = round(paid.reduce((sum, part) => sum + (part.usd ?? 0), 0));
  } else if (parts.some((part) => part.basis === 'plan')) out.basis = 'plan';
  if (notional.length) out.notionalUsd = round(notional.reduce((sum, part) => sum + (part.notionalUsd ?? 0), 0));
  return out;
}
