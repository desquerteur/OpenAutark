// Helper default for runtime text calls (SG, wishes 21.10. 17:55/17:57): subconscious, decision
// fallback, verification, compaction and widget fills run as the SYSTEM agent (decision/
// engine-runner.ts). This is what the Decisions use's "auto" means (shared/model/models-uses.ts): a
// connected Codex subscription (plan login, not an API key) with quota left (≥ HELPER_MIN_HEADROOM %) and a
// small model – the newest "Luna" the account lists, else the smallest it lists – at low effort; compaction
// starts at medium, and a caller may ask for more (an effort-only request, e.g. the LLM decision fallback's
// one retry at medium after an unsure answer, decision/llm-fallback.ts). A Decisions model chosen in
// Settings wins first (router.ts, routing/pins.ts settingsPin), then this default.
// Transport: the per-account `codex app-server` the agents use (engines/codex) – often already
// running, our own short instructions, structured output, limit pushes; no extra `codex exec`
// process per call (decision and probe numbers: concept card model-execution-providers, 23.10.).
// The pick names the model AND the accounts that may run it (`accountIds`, the qualifying plan
// logins): the router takes only those (router.ts), so a primary API-key login or a low primary
// plan never runs the default even when it lists the same model; with none left it falls through.
// B-044 (integration): this default serves SYSTEM calls only (helpers and compaction) – an agent's turn,
// plain conversation included, is routed by the model choice and the work plan (router.ts).
// helperModel reads that pick without a route, else names the router's fallback (API keys only as its spill-over).
// Owns: these choices. Never: reads token or auth files; the default never takes a pay-per-use login, a used-up or
// low plan, or a model a hard filter (needs, exclusions, the helper band) keeps out.

import type { RouteRequest, RuntimeServices } from '../contracts.ts';
import type { Account, Effort, ModelInfo } from '../../shared/model/providers.ts';
import { isChatModel } from '../../shared/model/models-uses.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { headroom, selectCandidates } from '../accounts/candidates.ts';
import { chargeOf } from '../models/pricing.ts';
import type { Pool } from './pool.ts';
import { isPaid, tierRank } from './score.ts';

/** A plan with less quota left than this (percent) is kept for agent work. */
export const HELPER_MIN_HEADROOM = 20;
const MEDIUM_PURPOSES: ReadonlySet<string> = new Set(['compact', 'compaction']);
const LUNA = /luna/i;

export interface HelperPick {
  modelId: string;
  source: 'helper';
  effort: Effort;
  /** Only these accounts may run it (plan logins with quota left). */
  accountIds: ReadonlySet<string>;
}

/** The start effort of a helper call: low, medium for compaction. */
export function helperEffort(purpose: string | undefined): Effort {
  return purpose && MEDIUM_PURPOSES.has(purpose) ? 'medium' : 'low';
}

/** Codex plan logins that may serve helper calls now (not an API-key login, quota left). */
export function helperPlans(s: RuntimeServices): Set<string> {
  const now = s.clock.now();
  let accounts;
  try { accounts = s.accounts.candidates('codex'); } catch { return new Set(); }
  return new Set(accounts.filter((account) => account.provider === 'codex' && chargeOf(account) === 'plan'
    && (headroom(account, now) ?? 100) >= HELPER_MIN_HEADROOM).map((account) => account.id));
}

/** Smallest tier first, then the cheaper. */
const byCost = (a: ModelInfo, b: ModelInfo) => tierRank(a.tier) - tierRank(b.tier) || (a.relCost ?? 1) - (b.relCost ?? 1) || a.id.localeCompare(b.id);

/** The newest Luna, else the smallest and cheapest model. */
function smallest(models: readonly ModelInfo[]): ModelInfo | undefined {
  const luna = models.filter((model) => LUNA.test(model.model)).sort((a, b) => b.model.localeCompare(a.model, 'en', { numeric: true }));
  return luna[0] ?? [...models].sort(byCost)[0];
}

/** The helper default of a SYSTEM route, or undefined (agents, no fitting subscription). */
export function helperDefault(s: RuntimeServices, request: RouteRequest, pool: Pool, models: readonly ModelInfo[]): HelperPick | undefined {
  if (request.agent.id !== SYSTEM_ID) return undefined;
  const asked = request.previous?.explicit && request.previous.asked === 'effort' ? request.previous.effort : undefined;
  const effort = asked ?? helperEffort(request.text?.trim().toLowerCase());
  const plan = planSmallModel(s, pool, models);
  return plan ? { modelId: plan.model.id, source: 'helper', effort, accountIds: plan.accountIds } : undefined;
}

/**
 * The model SYSTEM helper calls run on now, read without a route (the live line, context/setup-facts.ts): this default's
 * pick on its plan, else the smallest chat model an account can run now, pay-per-use keys only as the pool's spill-over
 * (routing/pool.ts) – close to the router's best-value pick, which can differ for a moment (quota, scores, the band).
 * `accountId`: the account it is shown on.
 */
export function helperModel(s: RuntimeServices): { model: ModelInfo; accountId?: string } | undefined {
  let models: ModelInfo[];
  try { models = s.catalog.list().filter((model) => model.available && isChatModel(model)); } catch { return undefined; }
  const plans = helperPlans(s);
  const plan = (model: ModelInfo) => (model.accounts.length ? model.accounts : [...plans]).find((id) => plans.has(id));
  const onPlan = smallest(models.filter((model) => model.provider === 'codex' && plan(model)));
  if (onPlan) return { model: onPlan, accountId: plan(onPlan) };
  let allowPaid = false;
  try { allowPaid = s.settings.get().routing.allowPaidFallback === true; } catch { /* off */ }
  const runners = (model: ModelInfo): Account[] => { // accounts.candidates, read from the list (any services stub has one)
    try {
      return selectCandidates(s.accounts.list(), model.engine, s.clock.now(), model.model).filter((account) => account.provider === model.provider
        && (!model.accounts.length || model.accounts.includes(account.id)));
    } catch { return []; }
  };
  const runnable = models.map((model) => ({ model, accounts: runners(model) })).filter((entry) => entry.accounts.length);
  const free = runnable.map((entry) => ({ model: entry.model, accounts: entry.accounts.filter((account) => !isPaid(account)) })).filter((entry) => entry.accounts.length);
  const pick = (allowPaid || !free.length ? runnable : free).sort((a, b) => byCost(a.model, b.model))[0];
  return pick ? { model: pick.model, accountId: pick.accounts[0].id } : undefined;
}

/** The newest Luna (else the smallest model) a Codex plan login with quota left can run inside the pool's filters and band. */
function planSmallModel(s: RuntimeServices, pool: Pool, models: readonly ModelInfo[]): { model: ModelInfo; accountIds: ReadonlySet<string> } | undefined {
  const plans = helperPlans(s);
  if (!plans.size) return undefined;
  const usable = models.filter((model) => model.provider === 'codex' && !model.functions?.length
    && !pool.unusable(model) && pool.inBand(model) && pool.accountsFor(model).some((account) => plans.has(account.id)));
  const pick = smallest(usable);
  return pick ? { model: pick, accountIds: plans } : undefined;
}
