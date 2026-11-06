// What settings.json names joins the catalog (runtime/models/catalog-named.ts, catalog-merge.ts) and the resolvers find it: a
// connection's own id prefix, a free name on a use, an unknown embedding model with `uses`, the older "<provider>:<model>", two
// connections on one provider kept apart, a decision connection serving decisions only.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNamedModels } from '../../../src/runtime/models/catalog-named.ts';
import { buildModel, fromRow, toRowParams, type Listing, type ModelRow } from '../../../src/runtime/models/catalog-merge.ts';
import { embeddingChoice } from '../../../src/runtime/models/embeddings.ts';
import { resolvePin } from '../../../src/runtime/routing/pins.ts';
import { servesUse } from '../../../src/shared/model/models-uses.ts';
import { modelOwner } from '../../../src/shared/model/provider-entries.ts';
import { functionCandidates, type Account, type ModelInfo, type ProviderId } from '../../../src/shared/model/providers.ts';
import type { Priors } from '../../../src/runtime/models/priors.ts';

const priors = { forModel: () => undefined } as unknown as Priors;
const account = (id: string, provider: ProviderId): Account => ({
  id, provider, label: id, auth: 'api_key', baseUrl: 'https://x.test/v1', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1,
});
const routing = (patch: object) => ({ work: 'auto', decision: 'auto', voice: 'auto', stt: 'auto', tts: 'auto', image: 'auto', video: 'auto', music: 'auto', sound: 'auto', embeddings: 'auto', costMode: 'balanced', allowPaidFallback: false, ...patch }) as never;

function catalog(accounts: Account[], listings: Record<string, string[]>, settings: { providers?: object; routing?: object }): ModelInfo[] {
  const named = { providers: settings.providers as never, routing: routing(settings.routing ?? {}) };
  const raw: Array<[string, Listing]> = Object.entries(listings).map(([id, names]) => [id, { models: names.map((model) => ({ model, name: model, efforts: [] })), at: 1 }]);
  const out: ModelInfo[] = [];
  for (const [id, listing] of withNamedModels(raw, accounts, named, 1)) {
    const owner = accounts.find((entry) => entry.id === id)!;
    for (const listed of listing.models) {
      const info = buildModel({ provider: owner.provider, engine: 'compatible', listed, priors, owner: modelOwner(owner, named.providers) });
      out.push({ ...info, available: true, accounts: [id] });
    }
  }
  return out;
}

test('two connections of one provider stay apart: the id names the connection', () => {
  const list = catalog([account('deepinfra', 'compatible'), account('mistral', 'compatible')], { deepinfra: ['same'], mistral: ['same'] }, { providers: { deepinfra: {}, mistral: {} } });
  assert.deepEqual(list.map((model) => model.id).sort(), ['deepinfra:same', 'mistral:same']);
  assert.deepEqual(resolvePin(list, 'mistral:same')?.accounts, ['mistral']);
  assert.equal(resolvePin(list, 'compatible:same')?.model, 'same', 'an older value keeps working');
  const plain = catalog([account('acc_1', 'compatible')], { acc_1: ['same'] }, { providers: {} });
  assert.equal(plain[0].id, 'compatible:same', 'an account the file does not name keeps its provider prefix');
});

test('a free name on a use is a model; a listed chat model stays free for the other uses', () => {
  const accounts = [account('deepinfra', 'compatible')];
  const providers = { deepinfra: {} };
  const list = catalog(accounts, { deepinfra: ['listed-chat'] }, { providers, routing: { work: 'deepinfra:brand-new', image: 'deepinfra:my-artist', decision: 'deepinfra:listed-chat' } });
  const pick = (id: string) => list.find((model) => model.id === id)!;
  assert.ok(resolvePin(list, 'deepinfra:brand-new'), 'pins.ts finds the free name');
  assert.ok(servesUse(pick('deepinfra:brand-new'), 'work') && servesUse(pick('deepinfra:brand-new'), 'decision'));
  assert.ok(servesUse(pick('deepinfra:listed-chat'), 'work'), 'naming it for decisions takes nothing away');
  assert.deepEqual(pick('deepinfra:my-artist').functions, ['image']);
  assert.equal(functionCandidates('image', 'deepinfra:my-artist', list)[0].source, 'settings', 'the media resolver finds the free name');
  assert.ok((pick('deepinfra:my-artist').strengths.chat ?? 0) <= -1, 'and the router never chats with it');
});

test('a name that looks like something else: `uses` and the use decide', () => {
  const list = catalog([account('mine', 'compatible')], { mine: [] }, { providers: { mine: { models: ['plain', { id: 'x-vec-2', uses: ['embeddings'] }] } }, routing: { work: 'mine:text-embedding-for-chat' } });
  const pick = (id: string) => list.find((model) => model.id === id)!;
  assert.ok(servesUse(pick('mine:x-vec-2'), 'embeddings'), 'no need to match the name');
  assert.ok(!servesUse(pick('mine:x-vec-2'), 'work'));
  assert.ok(servesUse(pick('mine:plain'), 'work'));
  assert.ok(servesUse(pick('mine:text-embedding-for-chat'), 'work'), 'a name on Work is a chat model, whatever it says');
  assert.ok((pick('mine:text-embedding-for-chat').strengths.chat ?? 0) > -0.95);
});

test('a decision connection: its models serve decisions only, and what is said survives the table', () => {
  const list = catalog([account('typesafe', 'decision-api')], {}, { providers: { typesafe: { models: ['jev-latest'] } } });
  assert.equal(list[0].id, 'typesafe:jev-latest');
  assert.ok(servesUse(list[0], 'decision') && !servesUse(list[0], 'work'));
  const params = toRowParams(list[0], 1);
  const row = { id: params[0], provider: params[1], model: params[2], name: params[3], engine: params[4], efforts: params[5], default_effort: params[6], caps: params[7], scores: params[8], tier: params[9], strengths: params[10], accounts: params[11], available: params[12], updated_at: params[13] } as unknown as ModelRow;
  const back = fromRow(row, priors);
  assert.ok(servesUse(back, 'decision') && !servesUse(back, 'work'), 'a restart reads the same');
});

test('a plan or an account outside the file gets no free name: its stale choice stays "not available"', () => {
  const list = catalog([account('acc_1', 'claude')], { acc_1: ['claude-opus-5-5'] }, { providers: {}, routing: { work: 'claude:claude-old' } });
  assert.equal(resolvePin(list, 'claude:claude-old'), undefined);
});

test('embeddings: the value names the connection, listed or not', () => {
  const accounts = [account('acc_1', 'compatible'), account('deepinfra', 'compatible')];
  const services = (value: string) => ({
    catalog: { list: () => [] }, accounts: { list: () => accounts },
    settings: { get: () => ({ routing: routing({ embeddings: value }) }) },
  }) as never;
  assert.equal((embeddingChoice(services('deepinfra:unknown-vectors'), false) as { accountId: string }).accountId, 'deepinfra');
  assert.equal((embeddingChoice(services('compatible:unknown-vectors'), false) as { accountId: string }).accountId, 'acc_1', 'an older value: the first of that provider');
});
