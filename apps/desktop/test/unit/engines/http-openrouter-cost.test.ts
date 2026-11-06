// PR9: OpenRouter's own price of a turn. The compatible engine asks for it (`usage.include`),
// sums it over the turn's requests (with BYOK plus the upstream cost), keeps it on a cut-off,
// and reports none when one request lacked it or when another server sends a "cost" field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { CompatibleEngine, openRouterCost } from '../../../src/runtime/engines/http/compatible.ts';
import { account, turnInput } from './fakes.ts';
import { sendSse, serve, type Recorded } from './http-fixture.ts';

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'cc', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = (prompt: number, completion: number, extra: Record<string, unknown> = {}) => ({ id: 'cc', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, ...extra } });
const call = chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tasks__create', arguments: '{"title":"A"}' } }] }, 'tool_calls');

async function setup(provider: string, route: (req: Recorded, res: ServerResponse, index: number) => void) {
  const server = await serve(route);
  const engine = new CompatibleEngine({ apiKey: async () => 'sk-or-test-0123456789' });
  return { server, engine, acc: account({ provider, auth: 'api_key', baseUrl: `${server.url}/v1` }) };
}

test('openrouter: asks for usage accounting and sums the reported cost of every request of the turn', async (t) => {
  const { server, engine, acc } = await setup('openrouter', (_req, res, index) => {
    if (index === 0) sendSse(res, [call, usage(100, 10, { cost: 0.002 }), '[DONE]']);
    else sendSse(res, [chunk({ content: 'Done.' }, 'stop'), usage(150, 20, { cost: 0.003, is_byok: true, cost_details: { upstream_inference_cost: 0.01 } }), '[DONE]']);
  });
  t.after(() => server.close());
  const result = await engine.run(turnInput({ account: acc, model: 'openai/gpt-x' }).input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 30, costUsd: 0.015 }, 'BYOK adds the upstream cost');
  assert.deepEqual(server.requests.map((req) => req.body.usage), [{ include: true }, { include: true }]);
});

test('openrouter: a request without a cost leaves the turn without one (the tokens are priced instead)', async (t) => {
  const { server, engine, acc } = await setup('openrouter', (_req, res, index) => {
    if (index === 0) sendSse(res, [call, usage(100, 10, { cost: 0.002 }), '[DONE]']);
    else sendSse(res, [chunk({ content: 'Done.' }, 'stop'), usage(150, 20), '[DONE]']);
  });
  t.after(() => server.close());
  const result = await engine.run(turnInput({ account: acc, model: 'openai/gpt-x' }).input);
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 30 });
});

test('openrouter: a cut-off answer keeps its reported cost; other servers never send usage params or count a cost field', async (t) => {
  const cut = await setup('openrouter', (_req, res) => sendSse(res, [chunk({ content: 'Half' }, 'length'), usage(9, 4, { cost: 0.0007 }), '[DONE]']));
  t.after(() => cut.server.close());
  const result = await cut.engine.run(turnInput({ account: cut.acc, model: 'm', tools: [] }).input);
  assert.equal(result.error?.message, 'The model response was cut off.');
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4, costUsd: 0.0007 });

  const other = await setup('compatible', (_req, res) => sendSse(res, [chunk({ content: 'ok' }, 'stop'), usage(5, 1, { cost: 99 }), '[DONE]']));
  t.after(() => other.server.close());
  const plain = await other.engine.run(turnInput({ account: other.acc, model: 'm', tools: [] }).input);
  assert.deepEqual(plain.usage, { inputTokens: 5, outputTokens: 1 });
  assert.equal(other.server.requests[0].body.usage, undefined);
});

test('openRouterCost: only plausible numbers', () => {
  assert.equal(openRouterCost({ cost: 0.5 }), 0.5);
  assert.equal(openRouterCost({ cost: 0.5, is_byok: false, cost_details: { upstream_inference_cost: 2 } }), 0.5, 'upstream counts only with BYOK');
  assert.equal(openRouterCost({ cost: -1 }), undefined);
  assert.equal(openRouterCost({ cost: '0.5' }), undefined);
  assert.equal(openRouterCost({ cost: 1e9 }), undefined);
  assert.equal(openRouterCost({}), undefined);
});
