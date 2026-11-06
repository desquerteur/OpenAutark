// B-058 G13: the catalog's listings of media-only accounts (ElevenLabs, fal.ai – MEDIA_ONLY_PROVIDERS). They
// have no chat engine and no model listing, so the curated table (media/providers/models.ts) stands in for
// one on every rebuild – always the current table, never a stored or recovered row. In the catalog their
// models carry the placeholder engine MEDIA_ENGINE (accounts/candidates.ts): the function resolver
// (models/functions.ts) finds their accounts there, while the router never runs a turn on them (they are
// function specialists, −1 for every chat category, catalog-merge.ts).
// Owns: which listings a rebuild reads for media-only accounts and the engine id their models carry.
// Never: I/O, network, or an engine call.

import { DECISION_PROVIDER, MEDIA_ONLY_PROVIDERS, type Account, type EngineId, type ProviderId } from '../../shared/model/providers.ts';
import { MEDIA_ENGINE } from '../accounts/candidates.ts';
import { STATIC_MEDIA_MODELS } from '../media/providers/models.ts';
import type { Listing } from './catalog-merge.ts';

const mediaOnly = (provider: ProviderId) => MEDIA_ONLY_PROVIDERS.includes(provider);

/** The engine id a media-only account's models carry in the catalog (undefined for every other provider). */
export function mediaEngineOf(provider: ProviderId): EngineId | undefined {
  return mediaOnly(provider) || provider === DECISION_PROVIDER ? MEDIA_ENGINE : undefined; // a decision connection has no engine either, runtime/decision/systemone.ts answers
}

/** The listings a rebuild reads: the engine listings, with every media-only account's replaced by its curated table. */
export function* rebuildListings(listings: ReadonlyMap<string, Listing>, accounts: Iterable<Account>, at: number): Generator<[string, Listing]> {
  const media = new Map<string, Listing>();
  for (const account of accounts) {
    const models = mediaOnly(account.provider) ? STATIC_MEDIA_MODELS[account.provider] : undefined;
    if (models) media.set(account.id, { models: models.map((entry) => ({ model: entry.model, name: entry.name, efforts: [] })), at });
  }
  for (const entry of listings) if (!media.has(entry[0])) yield entry;
  yield* media;
}
