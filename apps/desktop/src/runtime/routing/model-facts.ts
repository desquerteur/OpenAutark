// Model facts for agents (RT4): compact texts of what the catalog knows about one model – where it runs (plan, API key,
// local, endpoint), its efforts, prior strength per category, its list price and smarts (B-078) – and which models are
// specialists that cannot run an agent (agents.update pins). B-078 (D16): the one models line every agent carries in the
// stable part of its prompt (factsLine – context/setup-facts.ts modelsFactsLine, rendered in "My environment"): at most
// FACTS_MODELS connected work models, the smartest first, each with price, smarts and how a turn on it is paid – the same
// text while the connections stay the same, so the prompt cache holds.
// Owns: these texts. Never: ranks or decides (router.ts, model-list.ts do) or writes anything.

import type { Account, Effort, ModelInfo } from '../../shared/model/providers.ts';
import { EFFORT_ORDER, effortRank } from '../models/efforts.ts';
import { CATEGORIES } from '../models/priors.ts';
import { chargeOf } from '../models/pricing.ts';
import { LOCAL_PROVIDERS } from '../engines/http/common.ts';
import { categoryLabel } from './categories.ts';
import { NEVER, strengthOf } from './score.ts';

const PLAN_PROVIDERS: ReadonlySet<string> = new Set(['codex', 'claude']);
/** Categories shown in a model's strong/weak overview (the specialist ones are not work agents do). */
const WORK_CATEGORIES: readonly string[] = CATEGORIES.filter((category) => category !== 'decision' && category !== 'embeddings');
const OVERVIEW = 3;
const STRONG = 0.3;
const WEAK = -0.3;

/** "+0.90" / "-0.70" (two decimals, sign always shown). */
export function signed(value: number): string {
  const fixed = Math.abs(value).toFixed(2);
  return `${value < 0 && fixed !== '0.00' ? '-' : '+'}${fixed}`;
}

/** "low–max" for a run of consecutive efforts, else "none, high"; undefined when none are known. */
export function effortRange(efforts: readonly Effort[]): string | undefined {
  if (!efforts.length) return undefined;
  const ranks = efforts.map(effortRank).sort((a, b) => a - b);
  const consecutive = ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1);
  if (efforts.length > 2 && consecutive) return `${EFFORT_ORDER[ranks[0]]}–${EFFORT_ORDER[ranks[ranks.length - 1]]}`;
  return ranks.map((rank) => EFFORT_ORDER[rank]).join(', ');
}

/** How a turn on this model is paid: a subscription plan, an API key, a local runtime or a keyless endpoint. */
export function sourceOf(model: ModelInfo, account?: Account): 'plan' | 'API key' | 'local' | 'endpoint' {
  if (account) {
    if (account.auth === 'local') return 'local';
    // A key from the environment (PR5) and a CLI signed in with an API key are pay-per-use too.
    if (account.auth === 'api_key' || account.auth === 'env' || (account.auth === 'cli' && chargeOf(account) === 'paid')) return 'API key';
    if (account.auth === 'cli') return 'plan';
    return 'endpoint';
  }
  if (LOCAL_PROVIDERS.has(model.provider)) return 'local';
  return PLAN_PROVIDERS.has(model.provider) ? 'plan' : 'API key';
}

/**
 * The specialist kinds (decision, embeddings, media functions) of a model that is "never" for
 * every kind of agent work – it cannot run an agent's turns; undefined for general models.
 */
export function specialistKinds(model: ModelInfo): string[] | undefined {
  if (!model.functions?.length && WORK_CATEGORIES.some((category) => strengthOf(model, category) > NEVER)) return undefined;
  const kinds = Object.keys(model.strengths).filter((category) => !WORK_CATEGORIES.includes(category) && strengthOf(model, category) > NEVER);
  return [...new Set([...(model.functions ?? []), ...kinds])];
}

/** "4", "0.1", "0.05", "2.5": a price per 1M without trailing zeros. */
function dollars(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** "$4/$20" (USD per 1M input/output tokens); undefined without a known list price. */
export function priceText(model: Pick<ModelInfo, 'price'>): string | undefined {
  return model.price ? `$${dollars(model.price.inputPerM)}/$${dollars(model.price.outputPerM)}` : undefined;
}

/** Models named in the facts line. */
export const FACTS_MODELS = 8;

/** The facts line's ways to pay, as the line says them. */
const PAID: Record<ReturnType<typeof sourceOf>, string> = { plan: 'plan', 'API key': 'API key', local: 'local', endpoint: 'server' };

/**
 * "Models I can use ($ in/out per 1M tokens · smarts 0–100 · how a turn is paid): Claude Opus 5.5 $4/$20 · 94 · plan; …
 * A plan costs me nothing per turn while its quota lasts, an API key pays every token, a local model costs nothing." –
 * the connected work models (no specialists), the smartest first; '' when none is connected.
 */
export function factsLine(models: readonly ModelInfo[], accounts: readonly Account[]): string {
  const work = models.filter((model) => model.available && !specialistKinds(model));
  if (!work.length) return '';
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const ranked = [...work].sort((a, b) => (b.smarts ?? -1) - (a.smarts ?? -1) || (b.relCost ?? 0) - (a.relCost ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const distinct: string[] = [];
  for (const model of ranked) {
    const account = model.accounts.map((id) => byId.get(id)).find((entry) => entry !== undefined);
    const price = priceText(model);
    const item = [`${model.name}${price ? ` ${price}` : ''}`, model.smarts !== undefined ? String(model.smarts) : undefined, PAID[sourceOf(model, account)]].filter(Boolean).join(' · ');
    if (!distinct.includes(item)) distinct.push(item); // the same model on two connections of one kind: once
  }
  const items = distinct.slice(0, FACTS_MODELS);
  const more = distinct.length > items.length ? ` (+${distinct.length - items.length} more in models.list)` : '';
  return `Models I can use ($ in/out per 1M tokens · smarts 0–100 · how a turn is paid): ${items.join('; ')}${more}. A plan costs me nothing per turn while its quota lasts, an API key pays every token, a local model costs nothing.`;
}

/** "strong: coding +0.70, research +0.60 · weak: cheap chat -0.60" (top 3 each, `skip` left out). */
export function strengthOverview(model: ModelInfo, skip?: string): string | undefined {
  const known = WORK_CATEGORIES.filter((category) => category !== skip && typeof model.strengths[category] === 'number')
    .map((category) => ({ category, value: strengthOf(model, category) }));
  const strong = known.filter((entry) => entry.value >= STRONG).sort((a, b) => b.value - a.value || a.category.localeCompare(b.category)).slice(0, OVERVIEW);
  const weak = known.filter((entry) => entry.value <= WEAK).sort((a, b) => a.value - b.value || a.category.localeCompare(b.category)).slice(0, OVERVIEW);
  const list = (entries: typeof known) => entries.map((entry) => `${categoryLabel(entry.category)} ${signed(entry.value)}`).join(', ');
  const parts = [strong.length ? `strong: ${list(strong)}` : '', weak.length ? `weak: ${list(weak)}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
