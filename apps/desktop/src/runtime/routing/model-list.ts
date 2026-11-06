// The model comparison behind the models.list tool (RT4): the models the calling agent may use for a kind of work,
// best first as router.ts ranks them – the same inputs: the agent's effective policy band (floor, ceiling, avoid;
// prefer as the score bonus), cost mode, "never" priors, the mode's minimum tier (for its own category), the healthy accounts of each model (API keys only as a
// spill-over unless settings.json routing.allowPaidFallback allows them or nothing else is left) and scoreModel (curated priors, work plan bonus).
// One compact line per model (texts: model-facts.ts), at most MAX_MODELS lines and about MAX_CHARS characters.
// Decisions and embeddings are uses of their own (B-072): what answers them now (context/setup-facts.ts usesLine) and
// only the connected models made for them – a chat model with no prior for them is no embedding model.
// Owns: this selection and its text. Never: changes state, routes a turn, or lists a chat model outside the policy band
// (decisions and embeddings list what is connected for that use).

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { servesUse } from '../../shared/model/models-uses.ts';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { isDecisionModel, usesLine } from '../context/setup-facts.ts';
import { categoryLabel, resolveCategory } from './categories.ts';
import { effectivePolicy } from './policies.ts';
import { PIN_TEXT, resolvePin } from './pins.ts';
import { MODEL_CHOICE_LABELS } from '../../shared/model/model-guide.ts';
import { workPlanOf } from './preference.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import { NEVER, isPaid, scoreModel, strengthOf, tierRank, withinTiers, type CostMode } from './score.ts';
import { effortRange, priceText, signed, sourceOf, strengthOverview } from './model-facts.ts';

export const MAX_MODELS = 30;
export const MAX_CHARS = 2500;
export const NO_MODELS_TEXT = 'No model is connected yet. The person adds a plan, an API key or a local server in Settings → Models.';

export interface ModelListInput {
  services: RuntimeServices;
  agent: Agent;
  conversationId?: string;
  /** The caller's mode: its category is the default kind of work, its minTier applies to that category (as router.ts). */
  mode: Pick<ModeInfo, 'category' | 'minTier'>;
  category?: string;
  includeUnavailable?: boolean;
}

type State = 'ok' | 'limited' | 'paid-off' | 'none';

interface Entry { model: ModelInfo; account?: Account; state: State; score: number }

const STATE_TEXT: Record<Exclude<State, 'ok'>, string> = {
  limited: 'limited right now', 'paid-off': 'API key, used only when nothing else is left', none: 'no usable account',
};

const LEGEND = 'fit = strength -1…+1 for this work · $in/$out = API list price per 1M tokens (a plan costs nothing per turn while its quota lasts) · smarts = overall capability 0…100';

export function modelList(input: ModelListInput): string {
  const s = input.services;
  if (input.category === 'decision' || input.category === 'embeddings') return useModelList(s, input.category);
  const models = s.catalog.list();
  if (!models.length) return NO_MODELS_TEXT;
  const settings = s.settings.get().routing;
  const policy = effectivePolicy(s, input.agent, input.conversationId);
  const own = resolveCategory(input.mode.category, undefined);
  const category = input.category ?? own;
  const explicit = input.category !== undefined;
  const costMode: CostMode = policy.costMode ?? settings.costMode ?? 'balanced';

  const minTier = category === own ? input.mode.minTier : undefined;
  const fits = models.filter((model) => withinTiers(model.tier, policy.floorTier, policy.ceilingTier) && !policy.avoid.includes(model.id)
    && strengthOf(model, category) > NEVER && (!minTier || tierRank(model.tier) >= tierRank(minTier)));
  const candidates = fits.map((model) => {
    const all = model.available ? accountsOf(s, model) : [];
    return { model, all, usable: all };
  });
  const paidSpill = !settings.allowPaidFallback && candidates.some((entry) => entry.usable.some((account) => !isPaid(account)));
  const now = s.clock.now();
  const states = candidates.map((entry) => {
    const usable = paidSpill ? entry.usable.filter((account) => !isPaid(account)) : entry.usable;
    const state: State = !entry.model.available ? 'none' : !entry.all.length ? 'limited' : !usable.length ? 'paid-off' : 'ok';
    return { model: entry.model, account: usable[0] ?? entry.all[0], state };
  });
  const prefer = new Set(policy.prefer);
  const workPlan = input.agent.id === SYSTEM_ID ? undefined : workPlanOf(s);
  const ranked: Entry[] = states
    .map((entry) => ({ ...entry, score: scoreModel({ model: entry.model, account: entry.account, category, costMode, preferred: prefer.has(entry.model.id), now, workPlan }) }))
    .sort((a, b) => Number(b.state === 'ok') - Number(a.state === 'ok') || b.score - a.score || a.model.id.localeCompare(b.model.id));
  const shown = input.includeUnavailable ? ranked : ranked.filter((entry) => entry.state === 'ok');
  const hidden = ranked.length - shown.length;

  const pin = policy.pin;
  const pinned = pin ? resolvePin(models, pin.modelId) : undefined;
  const lines = shown.slice(0, MAX_MODELS).map((entry) => lineOf(entry, category, explicit, pinned?.id));

  const bounds = policy.floorTier || policy.ceilingTier ? `; my model policy spans ${policy.floorTier ?? 'local'} to ${policy.ceilingTier ?? 'frontier'} models` : '';
  const title = `Models I can use for ${categoryLabel(category)}${explicit ? '' : " (my mode's kind of work; category picks another)"}, best first as routing ranks them (model preference ${MODEL_CHOICE_LABELS[costMode]}${bounds}):`;
  const footer: string[] = [];
  if (hidden) footer.push(`${hidden} more cannot run right now (includeUnavailable: true lists ${hidden === 1 ? 'it' : 'them'} with the reason).`);
  if (pin) footer.push(`My model is ${PIN_TEXT[pin.source]} (${pinned?.name ?? pin.modelId}): model.set cannot change it.`);
  else if (shown.length) footer.push('I ask for one with model.set (its id, or a need such as "stronger" or "cheaper"; for: "task" keeps it for my whole task).');

  if (!shown.length) return [title, `No model I can use fits ${categoryLabel(category)} right now.`, ...footer].join('\n');
  const moreLine = (count: number) => `… ${count} more not shown${explicit ? '' : ' (category narrows it)'}.`;
  const fixed = [title, LEGEND, ...footer, moreLine(shown.length)].join('\n').length;
  const picked: string[] = [];
  let used = fixed;
  for (const line of lines) {
    if (picked.length && used + line.length + 1 > MAX_CHARS) break;
    picked.push(line);
    used += line.length + 1;
  }
  const more = shown.length - picked.length;
  return [title, LEGEND, ...picked, ...(more ? [moreLine(more)] : []), ...footer].join('\n');
}

/** Decisions or embeddings: the model that answers now, then the connected models made for that use. */
function useModelList(s: RuntimeServices, use: 'decision' | 'embeddings'): string {
  let now = '';
  let accounts: Account[] = [];
  try { now = usesLine(s); } catch { /* a source that cannot be read: the list alone */ }
  try { accounts = s.accounts.list(); } catch { /* source as the provider tells */ }
  const made = s.catalog.list().filter((model) => model.available
    && (use === 'embeddings' ? servesUse(model, 'embeddings') : isDecisionModel(model)));
  const lines = made.slice(0, MAX_MODELS).map((model) => {
    const named = model.name && model.name.toLowerCase() !== model.model.toLowerCase();
    return `- ${named ? `${model.id} (${model.name})` : model.id} · ${sourceOf(model, accounts.find((account) => model.accounts.includes(account.id)))}`;
  });
  const kind = use === 'embeddings' ? 'Embedding models' : 'Decision models';
  return [
    ...(now ? [`Now: ${now}`] : []),
    lines.length ? `${kind} connected (settings.json routing.${use} takes the id):` : `${kind} connected: none (skill ai-providers shows the ways to add one).`,
    ...lines,
  ].join('\n');
}

function lineOf(entry: Entry, category: string, explicit: boolean, pinnedId: string | undefined): string {
  const { model } = entry;
  const named = model.name && model.name.toLowerCase() !== model.model.toLowerCase();
  const parts = [named ? `${model.id} (${model.name})` : model.id, model.tier, sourceOf(model, entry.account)];
  const efforts = effortRange(model.efforts);
  if (efforts) parts.push(efforts);
  parts.push(`fit ${signed(strengthOf(model, category))}`);
  if (!explicit) {
    const overview = strengthOverview(model, category);
    if (overview) parts.push(overview);
  }
  const price = priceText(model); // B-078: the real list price and smarts instead of the relative cost
  if (price) parts.push(price);
  if (model.smarts !== undefined) parts.push(`smarts ${model.smarts}`);
  if (entry.state !== 'ok') parts.push(STATE_TEXT[entry.state]);
  if (model.id === pinnedId) parts.push('pinned');
  return `- ${parts.join(' · ')}`;
}

/** Accounts that can run the model now (the router's rule: its provider, its listed accounts, healthy). */
function accountsOf(s: RuntimeServices, model: ModelInfo): Account[] {
  try {
    return s.accounts.candidates(model.engine, model.model)
      .filter((account) => account.provider === model.provider && (!model.accounts.length || model.accounts.includes(account.id)));
  } catch {
    return [];
  }
}
