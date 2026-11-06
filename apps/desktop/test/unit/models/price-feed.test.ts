// B-078 (D16): the model facts – real list prices and smarts in the shipped priors (Fable 5.1 and GPT-6 Astra never above
// Opus 5.5 and GPT-6.1 Sol), relCost derived from the prices, and the keyless daily OpenRouter price list
// (runtime/models/price-feed.ts) that prices only models the priors leave unpriced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Priors, relCostOfPrices } from '../../../src/runtime/models/priors.ts';
import { buildModel, priceFor } from '../../../src/runtime/models/catalog-merge.ts';
import { feedDue, feedKey, parseFeed, PRICE_FEED_MS, refreshFeed, storedFeed } from '../../../src/runtime/models/price-feed.ts';
import { listPrice } from '../../../src/runtime/models/pricing.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { clock, memoryDb } from '../store/helpers.ts';

const shipped = Priors.load(path.resolve(import.meta.dirname, '../../../resources/model-priors.json'));
const prior = (model: string) => shipped.forModel(model)!;

test('shipped priors: the list prices, smarts, and relCost from the prices (Opus 0.4, Fable 1.0)', () => {
  assert.deepEqual([prior('claude-opus-5-5').priceInputPerM, prior('claude-opus-5-5').priceOutputPerM], [4, 20]);
  assert.deepEqual([prior('claude-fable-5-1').priceInputPerM, prior('claude-fable-5-1').priceOutputPerM], [10, 50]);
  assert.deepEqual([prior('claude-sonnet-5-5').priceInputPerM, prior('claude-sonnet-5-5').priceOutputPerM], [2, 10]);
  assert.deepEqual([prior('claude-haiku-5-5').priceInputPerM, prior('claude-haiku-5-5').priceOutputPerM], [0.1, 0.5]);
  assert.deepEqual([prior('gpt-6-astra').priceInputPerM, prior('gpt-6-astra').priceOutputPerM], [10, 50]);
  assert.deepEqual([prior('gpt-6.1-terra').priceInputPerM, prior('gpt-6.1-terra').priceOutputPerM], [1, 5]);
  assert.equal(prior('claude-opus-5-5').relCost, 0.4);
  assert.equal(prior('claude-fable-5-1').relCost, 1);
  assert.equal(prior('claude-sonnet-5-5').relCost, 0.2);
  assert.equal(relCostOfPrices(0.1, 0.5), 0.01);
  for (const entry of shipped.data.models) if (entry.smarts !== undefined) assert.ok(entry.smarts >= 0 && entry.smarts <= 100, entry.match);
});

test('shipped priors: Fable 5.1 and GPT-6 Astra are rated no higher than Opus 5.5 and GPT-6.1 Sol', () => {
  for (const [older, newer] of [['claude-fable-5-1', 'claude-opus-5-5'], ['gpt-6-astra', 'gpt-6.1-sol']] as const) {
    const a = prior(older);
    const b = prior(newer);
    assert.ok((a.smarts ?? 0) <= (b.smarts ?? 0), `${older} smarts`);
    for (const [category, value] of Object.entries(a.strengths)) {
      if (b.strengths[category] !== undefined) assert.ok(value <= b.strengths[category], `${older} ${category} ${value} > ${b.strengths[category]}`);
    }
  }
});

test('smarts and a parsed relCost: an explicit relCost wins over the prices, smarts are clamped', () => {
  const priors = Priors.parse({ models: [
    { match: 'a*', relCost: 0.3, priceInputPerM: 10, priceOutputPerM: 50, smarts: 140, strengths: {} },
    { match: 'b*', priceInputPerM: 2, priceOutputPerM: 10, smarts: 'x', strengths: {} },
  ] });
  assert.equal(priors.forModel('a1')!.relCost, 0.3);
  assert.equal(priors.forModel('a1')!.smarts, 100);
  assert.equal(priors.forModel('b1')!.relCost, 0.2);
  assert.equal(priors.forModel('b1')!.smarts, undefined);
});

test('the catalog model carries smarts and its price; local models have none', () => {
  const opus = buildModel({ provider: 'claude', engine: 'claude', listed: { model: 'claude-opus-5-5', name: 'claude-opus-5-5', efforts: [] }, priors: shipped });
  assert.equal(opus.smarts, 94);
  assert.deepEqual(opus.price, { inputPerM: 4, outputPerM: 20, source: 'priors' });
  assert.equal(opus.relCost, 0.4);
  const local = buildModel({ provider: 'ollama', engine: 'compatible', listed: { model: 'qwen3.8:8b', name: 'qwen3.8:8b', efforts: [] }, priors: shipped });
  assert.equal(local.price, undefined);
  assert.equal(local.relCost, 0);
});

const FEED = { data: [
  { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000005', completion: '0.000025' } },
  { id: 'mistralai/mistral-large-3', pricing: { prompt: '0.000002', completion: '0.000006' } },
  { id: 'mistralai/mistral-large-3:free', pricing: { prompt: '0', completion: '0' } },
  { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
  { id: 'broken' },
  'junk',
] };

test('the feed: keys match across vendors and spellings; odd entries are skipped', () => {
  assert.equal(feedKey('anthropic/claude-opus-5.5'), feedKey('claude-opus-5-5'));
  assert.equal(feedKey('Mistral_Large 3'), 'mistral-large-3');
  const prices = parseFeed(FEED);
  assert.deepEqual(prices.get('mistral-large-3'), { inputPerM: 2, outputPerM: 6 });
  assert.deepEqual(prices.get('mistral-large-3-free'), { inputPerM: 0, outputPerM: 0 });
  assert.equal(prices.has('auto'), false, '"-1" = a price that varies');
  assert.equal(prices.has('broken'), false);
  assert.equal(parseFeed({}).size, 0);
});

test('the feed fills only prices the priors lack; the priors always win', () => {
  const feed = parseFeed(FEED);
  const listed = priceFor({ local: false, prior: shipped.forModel('mistral-large-3'), model: 'mistral-large-3', feed });
  assert.deepEqual(listed, { inputPerM: 2, outputPerM: 6, source: 'feed' });
  assert.deepEqual(priceFor({ local: false, prior: prior('claude-opus-5-5'), model: 'claude-opus-5-5', feed }), { inputPerM: 4, outputPerM: 20, source: 'priors' });
  const model = buildModel({ provider: 'openrouter', engine: 'compatible', listed: { model: 'mistralai/mistral-large-3', name: 'mistralai/mistral-large-3', efforts: [] }, priors: shipped, feed });
  assert.deepEqual(model.price, { inputPerM: 2, outputPerM: 6, source: 'feed' });
  assert.equal(model.relCost, relCostOfPrices(2, 6));
  // a paid turn on it is booked at the feed's price
  assert.deepEqual(listPrice({ inputTokens: 1_000_000, outputTokens: 0 }, model), { usd: 2, basis: 'list-price' });
});

test('refreshFeed: once a day, a failure is logged and skipped (the stored list stays), retried after 6 h', async () => {
  const db = memoryDb();
  const time = clock();
  const log = new MemoryLogger();
  let calls = 0;
  let answer: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = async () => ({ ok: true, status: 200, json: async () => FEED });
  const deps = { db, clock: time, log, fetch: async () => { calls += 1; return answer(); } };
  assert.equal(await refreshFeed(deps), true);
  assert.deepEqual(storedFeed(db).get('claude-opus-5-5'), { inputPerM: 5, outputPerM: 25 });
  assert.equal(await refreshFeed(deps), false, 'not due again the same day');
  assert.equal(calls, 1);
  time.advance(PRICE_FEED_MS);
  answer = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await refreshFeed(deps), false);
  assert.equal(calls, 2);
  assert.ok(log.entries.some((entry) => entry.message === 'model list prices skipped'));
  assert.equal(storedFeed(db).size, 3, 'the stored list stays');
  assert.equal(feedDue(db, time.now()), false, 'a failure waits');
  time.advance(6 * 60 * 60_000);
  assert.equal(feedDue(db, time.now()), true);
  answer = async () => { throw new Error('offline'); };
  assert.equal(await refreshFeed(deps), false, 'a thrown fetch never throws on');
});
