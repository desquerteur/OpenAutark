// What settings.json names joins the catalog: a connection's `models` (providers.<id>.models, with their `uses`) and a
// model a use names on it (routing.<use> "<id>:<name>") – so a free name is a model like any other for the router, the
// media resolver and Settings. A name the server lists keeps its listing; a media, voice or embeddings use says what the
// model is for, so its name need not; a free name on work or decisions is a chat model. Only connections of the file:
// a plan's stale choice stays "not available" and falls back. A decision connection's models serve decisions only.
// Owns: this merge. Never: I/O, or a model of an account the file does not name.

import { MODEL_USES, useValue, USE_AUTO, type ModelUse } from '../../shared/model/models-uses.ts';
import { entryModels, modelOwner } from '../../shared/model/provider-entries.ts';
import { DECISION_PROVIDER, type Account } from '../../shared/model/providers.ts';
import type { Settings } from '../../shared/model/system.ts';
import type { EngineModel } from '../engines/types.ts';
import type { Listing } from './catalog-merge.ts';

const CHAT_USES: readonly ModelUse[] = ['work', 'decision'];
type Named = Pick<Settings, 'providers'> & Partial<Pick<Settings, 'routing'>>;

/** The models settings.json names on `account`, with what it says they are for. */
function namedModels(account: Account, settings: Named): Map<string, { name?: string; uses?: ModelUse[] }> {
  const out = new Map<string, { name?: string; uses?: ModelUse[] }>();
  const entry = settings.providers?.[account.id];
  if (!entry) return out;
  for (const model of entryModels(entry)) out.set(model.id, { name: model.name, uses: model.uses });
  const prefix = `${modelOwner(account, settings.providers)}:`;
  for (const use of MODEL_USES) {
    const value = useValue(settings.routing, use);
    if (value === USE_AUTO || !value.startsWith(prefix) || value.length === prefix.length) continue;
    const model = value.slice(prefix.length);
    const known = out.get(model) ?? {};
    out.set(model, { ...known, uses: [...new Set([...(known.uses ?? []), use])] });
  }
  return out;
}

/** The listings a rebuild reads, each with the models settings.json names on its account. */
export function withNamedModels(listings: Iterable<[string, Listing]>, accounts: Iterable<Account>, settings: Named, at: number): Map<string, Listing> {
  const out = new Map(listings);
  for (const account of accounts) {
    const named = namedModels(account, settings);
    if (!named.size && account.provider !== DECISION_PROVIDER) continue;
    const decision = account.provider === DECISION_PROVIDER;
    const listing = out.get(account.id);
    const models: EngineModel[] = decision ? [] : [...(listing?.models ?? [])];
    for (const [model, about] of named) {
      const index = models.findIndex((entry) => entry.model === model);
      const listed = index >= 0 ? models[index] : undefined;
      // on a listed chat model a chat use changes nothing: its name already tells, and it stays free for the other uses
      const said = about.uses?.filter((use) => !listed || !CHAT_USES.includes(use)) ?? [];
      const chat = !listed && said.some((use) => CHAT_USES.includes(use));
      const uses: readonly ModelUse[] = decision ? ['decision'] : chat ? [...new Set([...said, ...CHAT_USES])] : said;
      const next: EngineModel = { ...(listed ?? { model, name: about.name ?? model, efforts: [] }), ...(about.name ? { name: about.name } : {}), ...(uses.length ? { uses } : {}) };
      if (listed) models[index] = next;
      else models.push(next);
    }
    out.set(account.id, { models, at: listing?.at ?? at });
  }
  return out;
}
