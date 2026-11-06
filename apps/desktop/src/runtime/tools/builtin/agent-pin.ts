// The model pin of agents.update (RT4, split out of agents.ts): '' or 'auto' = automatic routing; else a
// catalog model by exact id, bare provider model id (routing/pins.ts) or display name, stored as its
// catalog id. A bare id or name several providers list takes the copy routing would want (available
// first, then plan or local before a pay-per-use API key) and the note names the others; a fresh install
// with an empty catalog refreshes it once. A model without a usable account is pinned with a note
// (routing falls back until it has one).
// Owns: that resolution and its notes. Never: saves the pin (agents.update does, through OrgService),
// pins a model the catalog does not know or a specialist (decision, embeddings, media) that cannot run an agent.

import type { ToolContext } from '../types.ts';
import type { ModelInfo } from '../../../shared/model/providers.ts';
import { resolvePin } from '../../routing/pins.ts';
import { sourceOf, specialistKinds } from '../../routing/model-facts.ts';
import { clip } from './util.ts';

/** The pin for agents.update (`{}` = automatic routing), or why it fails (pointing to models.list). */
export async function pinFor(ctx: ToolContext, value: string): Promise<{ pin?: string; note?: string } | { error: string }> {
  const wanted = value.trim();
  if (!wanted || wanted.toLowerCase() === 'auto') return {};
  const catalog = ctx.services.catalog;
  let matches = pinMatches(ctx, wanted);
  if (!matches.length && !catalog.list().length) { await catalog.refresh().catch(() => undefined); matches = pinMatches(ctx, wanted); } // fresh install
  const [best, ...others] = matches;
  if (!best) return { error: `Unknown model "${clip(wanted, 80)}". models.list shows the models I can pin; pass one of its ids.` };
  const { model } = best;
  const special = specialistKinds(model);
  if (special) return { error: `${model.name} is a specialist model (${special.join(', ') || 'not for agent work'}) and cannot run an agent. models.list shows the models that can.` };
  const rest = others.filter((other) => !specialistKinds(other.model)).map((other) => `${other.model.id} (${other.source})`);
  const notes = [
    ...(rest.length ? [`Several models match "${clip(wanted, 80)}": pinned ${model.id} (${best.source}); also ${rest.join(', ')}. Pass one of those ids to pin it instead.`] : []),
    ...(model.available ? [] : [`${model.name} has no usable account right now; routing uses another model until it has one.`]),
  ];
  return { pin: model.id, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

/** The catalog models a pin value names, the copy to pin first (specialists last, then unavailable, then API key). */
function pinMatches(ctx: ToolContext, wanted: string): Array<{ model: ModelInfo; source: string }> {
  const models = ctx.services.catalog.list();
  const exact = models.find((model) => model.id === wanted);
  const bare = !exact && resolvePin(models, wanted) !== undefined; // a provider-qualified id never moves provider
  const name = wanted.toLowerCase();
  const found = exact ? [exact] : models.filter((model) => (bare && model.model === wanted) || model.name.trim().toLowerCase() === name);
  return found
    .map((model) => {
      const accounts = model.accounts.map((id) => ctx.services.accounts.get(id)).filter((account) => account !== undefined);
      const source = sourceOf(model, accounts.find((account) => sourceOf(model, account) !== 'API key') ?? accounts[0]);
      return { model, source, rank: (specialistKinds(model) ? 4 : 0) + (model.available ? 0 : 2) + (source === 'API key' ? 1 : 0) };
    })
    .sort((a, b) => a.rank - b.rank) // stable: the catalog order breaks ties
    .map(({ model, source }) => ({ model, source }));
}
