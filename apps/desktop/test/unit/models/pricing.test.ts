// PR9 – plan vs paid spend: a plan turn books no spend (its notional price stays on the run), a
// paid turn books tokens × Artificial Analysis list prices, a provider-reported cost (OpenRouter)
// wins over the computed one, curated prior prices are the last source, and a paid turn without
// any price is booked with 0 and flagged 'unpriced'. A failover turn is priced per attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptCost, chargeOf, combineCosts, listPrice, tokenPrice } from '../../../src/runtime/models/pricing.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { firstUsage } from '../../../src/runtime/agents/turn-cost.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { RunCostRepo } from '../../../src/runtime/store/run-cost.ts';
import { runCostText } from '../../../src/shared/text/run-cost.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { account } from './harness.ts';
import { setup } from '../agents/fixture.ts';

const AA = { source: 'artificial-analysis', priceInputPerM: 2, priceOutputPerM: 8 } as const;
const model = (id: string, scores?: ModelInfo['scores']): ModelInfo => ({
  id, provider: id.split(':')[0] as ModelInfo['provider'], model: id.slice(id.indexOf(':') + 1), name: id, engine: 'compatible',
  efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [], ...(scores ? { scores } : {}),
});

test('who pays: API keys, env keys and API-key CLI logins are paid; plans and local models are not', () => {
  assert.equal(chargeOf(account('a', 'openai')), 'paid');
  assert.equal(chargeOf({ ...account('a', 'openrouter'), auth: 'env' as Account['auth'] }), 'paid', 'the detected environment key (PR5)');
  assert.equal(chargeOf(account('a', 'claude', { plan: 'max' })), 'plan');
  assert.equal(chargeOf(account('a', 'claude')), 'plan', 'a CLI login without a reported plan is a subscription');
  assert.equal(chargeOf(account('a', 'claude', { plan: 'api' })), 'paid', 'Claude Code signed in with an API key');
  assert.equal(chargeOf(account('a', 'codex', { plan: 'api' })), 'paid');
  assert.equal(chargeOf(account('a', 'ollama')), 'free');
  assert.equal(chargeOf(account('a', 'lmstudio', { auth: 'api_key' })), 'free', 'a local runtime never bills');
  assert.equal(chargeOf(account('a', 'compatible', { auth: 'none' })), 'free', 'a server without a key bills nobody');
});

test('prices: provider-reported → AA list price → curated prior → unpriced; never a guessed price', () => {
  const paid = account('a', 'openai');
  const usage = { inputTokens: 1_000_000, outputTokens: 250_000 };
  assert.deepEqual(attemptCost({ account: paid, usage, model: model('openai:x', AA) }), { basis: 'list-price', usd: 4 }, '1M × $2 + 0.25M × $8');
  assert.deepEqual(attemptCost({ account: paid, usage: { ...usage, costUsd: 3.1 }, model: model('openai:x', AA) }), { basis: 'provider', usd: 3.1 }, 'the reported cost wins');
  const prior = Priors.parse({ models: [{ match: 'x*', strengths: {}, priceInputPerM: 1, priceOutputPerM: 4 }, { match: 'bad*', strengths: {}, priceInputPerM: -1, priceOutputPerM: 'free' }] });
  assert.deepEqual(attemptCost({ account: paid, usage, model: model('openai:x'), prior: prior.forModel('x') }), { basis: 'prior-price', usd: 2 });
  const bad = prior.forModel('bad-model')!;
  assert.ok(!('priceInputPerM' in bad) && !('priceOutputPerM' in bad), 'implausible prices are dropped');
  assert.deepEqual(attemptCost({ account: paid, usage, model: model('openai:x') }), { basis: 'unpriced', usd: 0 });
  // A list price must cover every token kind used: output tokens without an output price stay unpriced.
  assert.equal(tokenPrice(usage, { inputPerM: 2 }), undefined);
  assert.equal(tokenPrice({ inputTokens: 500, outputTokens: 0 }, { inputPerM: 2 }), 0.001, 'embeddings: input only');
  assert.equal(listPrice(usage, model('openai:x', { source: 'artificial-analysis', priceInputPerM: 2 })), undefined);
  // Plans: no charge, the reported or list price is the notional cost.
  const plan = account('a', 'claude', { plan: 'max' });
  assert.deepEqual(attemptCost({ account: plan, usage: { ...usage, costUsd: 0.4 }, model: model('claude:x', AA) }), { basis: 'plan', notionalUsd: 0.4 });
  assert.deepEqual(attemptCost({ account: account('c', 'codex'), usage, model: model('codex:x', AA) }), { basis: 'plan', notionalUsd: 4 });
  assert.deepEqual(attemptCost({ account: account('o', 'ollama'), usage: { ...usage, costUsd: 1 } }), { basis: 'free' });
});

test('a failover run combines its attempts: paid amounts add up, the weakest paid basis names the run', () => {
  assert.deepEqual(combineCosts([{ basis: 'plan', notionalUsd: 0.4 }, { basis: 'list-price', usd: 0.25 }]), { basis: 'list-price', costUsd: 0.25, notionalUsd: 0.4 });
  assert.deepEqual(combineCosts([{ basis: 'provider', usd: 0.1 }, { basis: 'unpriced', usd: 0 }]), { basis: 'unpriced', costUsd: 0.1 });
  assert.deepEqual(combineCosts([{ basis: 'plan' }, { basis: 'free' }]), { basis: 'plan' });
  assert.deepEqual(firstUsage({ inputTokens: 1400, outputTokens: 150, costUsd: 0.75 }, { inputTokens: 400, outputTokens: 50, costUsd: 0.25 }), { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 });
  assert.deepEqual(firstUsage({ inputTokens: 1400, outputTokens: 150, costUsd: 0.25 }, { inputTokens: 400, outputTokens: 50, costUsd: 0.25 }), { inputTokens: 1000, outputTokens: 100 }, 'only the second attempt reported a cost');
  assert.equal(firstUsage({ inputTokens: 5, outputTokens: 1 }, { inputTokens: 5, outputTokens: 1 }), undefined, 'nothing before the failover');
});

/** finishTurn with the real journal: what reaches the run row, the cost columns and the budget. */
async function finish(input: { account: Account; modelId: string; catalog?: ModelInfo; result: EngineTurnResult; usage: { inputTokens: number; outputTokens: number; costUsd?: number }; lastUsage?: { inputTokens: number; outputTokens: number; costUsd?: number }; before?: (runs: Journal) => void }) {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const spends: Array<{ amount: number; kind: string; ref?: string }> = [];
  const accounts = new Map([[input.account.id, input.account], ['acc_plan', account('acc_plan', 'claude', { plan: 'max' })]]);
  Object.assign(h.services, {
    runs,
    spend: { record: (spend: { amount: number; kind: string; ref?: string }) => { spends.push(spend); } },
    catalog: { get: (id: string) => (id === input.catalog?.id ? input.catalog : undefined) },
    accounts: { get: (id: string) => accounts.get(id), updateLimits: () => {} },
  });
  const request = h.request({ runId: 'run_cost' });
  runs.start({ id: request.runId, agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  input.before?.(runs);
  const plan = (await planTurn(h.services, request))!;
  const messageId = h.chats.beginAgentMessage(h.chat.id, h.tom.id, request.runId).id;
  const routed = { ...h.routed(), account: input.account, route: { ...h.route, modelId: input.modelId, accountId: input.account.id } };
  finishTurn(h.services, plan, routed, request, h.attempt(input.result, { usage: input.usage, ...(input.lastUsage ? { lastUsage: input.lastUsage } : {}) }), messageId);
  return { run: runs.get(request.runId)!, cost: new RunCostRepo(h.db).get(request.runId), spends };
}

const DONE: EngineTurnResult = { text: 'Done.', stop: 'done' };

test('a Claude plan turn books no spend: costUsd stays empty, the notional price is stored as "plan, no charge"', async () => {
  const out = await finish({ account: account('acc_max', 'claude', { plan: 'max' }), modelId: 'claude:claude-opus-5-5', result: DONE, usage: { inputTokens: 1000, outputTokens: 40, costUsd: 0.4 } });
  assert.deepEqual(out.spends, [], 'no spend row');
  assert.equal(out.run.costUsd, undefined, 'no real charge on the run');
  assert.deepEqual(out.cost, { costBasis: 'plan', notionalUsd: 0.4 });
  assert.equal(runCostText({ ...out.run, ...out.cost }), '$0.400 · plan, no charge');
});

test('an OpenAI API-key turn books tokens × AA list prices', async () => {
  const out = await finish({ account: account('acc_key', 'openai'), modelId: 'openai:gpt-x', catalog: model('openai:gpt-x', AA), result: DONE, usage: { inputTokens: 10_000, outputTokens: 2_000 } });
  assert.deepEqual(out.spends.map((spend) => [spend.amount, spend.kind, spend.ref]), [[0.036, 'tokens', 'run_cost']], '10k × $2/M + 2k × $8/M');
  assert.equal(out.run.costUsd, 0.036);
  assert.deepEqual(out.cost, { costBasis: 'list-price' });
  assert.equal(runCostText({ ...out.run, ...out.cost }), '≈ $0.036');
});

test("OpenRouter's reported cost wins over the computed one", async () => {
  const out = await finish({ account: account('acc_or', 'openrouter'), modelId: 'openrouter:openai/gpt-x', catalog: model('openrouter:openai/gpt-x', AA), result: DONE, usage: { inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.0123 } });
  assert.deepEqual(out.spends.map((spend) => spend.amount), [0.0123]);
  assert.deepEqual([out.run.costUsd, out.cost?.costBasis], [0.0123, 'provider']);
});

test('a paid model without any price is booked with 0 and flagged unpriced', async () => {
  const out = await finish({ account: account('acc_custom', 'compatible'), modelId: 'compatible:my-model', result: DONE, usage: { inputTokens: 5_000, outputTokens: 500 } });
  assert.deepEqual(out.spends, [], 'a zero amount is no spend row');
  assert.equal(out.run.costUsd, 0);
  assert.deepEqual(out.cost, { costBasis: 'unpriced' });
  assert.equal(runCostText({ ...out.run, ...out.cost }), 'unpriced');
});

test('curated prior prices from the shipped file are the last source (none are shipped unverified)', () => {
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');
  const shipped = Priors.shipped(resources);
  assert.ok(shipped.data.models.length > 0, 'the shipped priors load');
  assert.equal(Priors.shipped(resources), shipped, 'read once per process');
  assert.equal(Priors.shipped(undefined).data.models.length, 0);
  for (const entry of shipped.data.models) {
    for (const value of [entry.priceInputPerM, entry.priceOutputPerM]) assert.ok(value === undefined || (value >= 0 && value <= 10_000), entry.match);
  }
});

test('a failover from a plan to an API key books only the paid attempt', async () => {
  const out = await finish({
    account: account('acc_key', 'openai'), modelId: 'openai:gpt-x', catalog: model('openai:gpt-x', AA),
    result: DONE, usage: { inputTokens: 11_000, outputTokens: 2_100, costUsd: 0.5 }, lastUsage: { inputTokens: 10_000, outputTokens: 2_000 },
    before: (runs) => runs.item('run_cost', { kind: 'note', data: { failover: { from: 'claude:claude-opus-5-5', fromAccount: 'acc_plan', to: 'openai:gpt-x', toAccount: 'acc_key', reason: 'limit' } }, effectStatus: 'none' }),
  });
  assert.deepEqual(out.spends.map((spend) => spend.amount), [0.036], "the plan attempt's 0.5 is not booked");
  assert.equal(out.run.costUsd, 0.036);
  assert.deepEqual(out.cost, { costBasis: 'list-price', notionalUsd: 0.5 });
});

test('run cost wording: old runs keep their stored cost, local runs show nothing', () => {
  assert.equal(runCostText({ costUsd: 1.234 }), '$1.23');
  assert.equal(runCostText({ costUsd: 0.05, costBasis: 'provider' }), '$0.050');
  assert.equal(runCostText({ costBasis: 'plan' }), 'plan, no charge');
  assert.equal(runCostText({ costBasis: 'free' }), '');
});
