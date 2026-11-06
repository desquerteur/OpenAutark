// Cached input is counted, nothing else changes: Codex's `cachedInputTokens` and Claude's and the Anthropic API's cache reads and writes
// reach the usage event, the turn's usage, the structured runner's answer (the helper-call log reads it there), its onUsage booking and the
// subconscious's tally, while inputTokens stays the total of all input. Pricing takes a cached price only from a prior that has one.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';
import { addCache, cachedInput } from '../../../src/runtime/engines/shared.ts';
import { createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import { runFlow } from '../../../src/runtime/subconscious/flow.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { attemptCost, listPrice, tokenPrice } from '../../../src/runtime/models/pricing.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { firstUsage } from '../../../src/runtime/agents/turn-cost.ts';
import { mergeAttempts } from '../../../src/runtime/agents/turn.ts';
import type { Engine, EngineEvent, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { AttemptResult } from '../../../src/runtime/agents/turn-types.ts';
import { fakeSpawn, fakeFinder, testSupervisor, turnInput } from './fakes.ts';
import { RESOURCES, fixture } from '../context/fixture.ts';

/** A scripted app-server whose turn reports the given per-request usage updates, then completes. */
function codexWith(updates: Array<Record<string, number>>) {
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id === undefined || !msg.method) return;
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        for (const last of updates) child.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { last, total: {} } } });
        child.send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
      } else child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  return new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });
}

test('codex: each request\'s cachedInputTokens rides on its usage event and the turn sums them; inputTokens stays the total', async () => {
  const e = codexWith([
    { inputTokens: 4839, cachedInputTokens: 2560, cacheWriteInputTokens: 0, outputTokens: 44, totalTokens: 4883 },
    { inputTokens: 5100, cachedInputTokens: 4608, cacheWriteInputTokens: 0, outputTokens: 30, totalTokens: 5130 },
  ]);
  const { input, events } = turnInput();
  const result = await e.run(input);
  assert.equal(result.stop, 'done');
  const usage = events.filter((event: EngineEvent) => event.type === 'usage');
  assert.deepEqual(usage.map((event: any) => [event.inputTokens, event.cachedInputTokens, event.outputTokens]), [[4839, 2560, 44], [5100, 4608, 30]]);
  assert.deepEqual(result.usage, { inputTokens: 9939, outputTokens: 74, cachedInputTokens: 7168 });
  await e.dispose();
});

test('codex: a usage update without cachedInputTokens adds no cache field', async () => {
  const e = codexWith([{ inputTokens: 900, outputTokens: 10, totalTokens: 910 }]);
  const { input, events } = turnInput();
  const result = await e.run(input);
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 10 });
  assert.ok(!('cachedInputTokens' in events.find((event: EngineEvent) => event.type === 'usage')));
  await e.dispose();
});

test('claude: plain input + cache reads + cache writes = inputTokens; the reads and writes stand beside it on the event', () => {
  const events: EngineEvent[] = [];
  const parser = new ClaudeStreamParser((event) => events.push(event), () => 0);
  parser.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 700, output_tokens: 15 }, total_cost_usd: 0.01 });
  const event = events.find((one) => one.type === 'usage') as Extract<EngineEvent, { type: 'usage' }>;
  assert.deepEqual([event.inputTokens, event.cacheReadTokens, event.cacheWriteTokens], [9820, 9000, 700]);
  assert.equal(120 + event.cacheReadTokens! + event.cacheWriteTokens!, event.inputTokens);
  assert.equal(cachedInput(event), 9000, 'a cache write is input sent in full');
});

test('the structured runner hands the engine\'s cached figure to its answer and to onUsage', async () => {
  const f = fixture();
  const engine = { run: async (_input: EngineTurnInput) => ({ text: '', structured: { tool: 'done', args: '{}' }, stop: 'done' as const, usage: { inputTokens: 5100, outputTokens: 40, cachedInputTokens: 3072 } }) } as unknown as Engine;
  const booked: unknown[] = [];
  const runner = createEngineRunner({
    engines: { get: () => engine } as never, clock: f.services.clock, paths: { temp: tmpdir() } as never,
    router: { route: async (_request: RouteRequest) => ({ modelId: 'p:m', engine: 'compatible', accountId: 'acc', effort: 'low', category: 'cheap-chat', reason: '', by: 'rules', alternatives: [] }) } as never,
    accounts: { get: () => ({ id: 'acc' }), updateLimits: () => {}, markLimited: () => {}, markUnavailable: () => false } as never,
    catalog: { get: () => ({ id: 'p:m', model: 'm', efforts: ['low'] }) } as never,
    onUsage: (entry) => { booked.push(entry.usage); },
  });
  const reply = await runner({ purpose: 'subconscious', system: 's', prompt: 'p', schema: { type: 'object' } });
  assert.deepEqual(reply.usage, { inputTokens: 5100, outputTokens: 40, cachedInputTokens: 3072 });
  assert.deepEqual(booked, [{ inputTokens: 5100, outputTokens: 40, cachedInputTokens: 3072 }]);
});

test('the flow tally: used stays input + output of every call, cached is the cached part of their input', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const script = [{ tool: 'agent.tell', args: { text: 'Notiz.' } }, { tool: 'done', args: {} }];
  const decision: StructuredRunner = async () => {
    const next = script.shift()!;
    return { text: '', structured: { tool: next.tool, args: JSON.stringify(next.args) }, by: 'fake', usage: { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 640 } };
  };
  const result = await runFlow(f.services, { decision }, { kind: 'after-turn', agent: f.vid, thread: 'th' });
  assert.equal(result.end, 'done');
  assert.deepEqual([result.used, result.cached], [2 * 1050, 2 * 640]);
});

test('pricing: the cached part counts at a cached price only when the prior has one; of the shipped priors only the new Terra has one', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 600_000 };
  assert.equal(tokenPrice(usage, { inputPerM: 2, outputPerM: 8 }), 2, 'no cached price: every input token at the input price, as before');
  assert.equal(tokenPrice(usage, { inputPerM: 2, outputPerM: 8, cachedInputPerM: 0.2 }), 0.92);
  assert.equal(tokenPrice({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheWriteTokens: 100_000 }, { inputPerM: 3, cachedInputPerM: 0.3 }), 0.57, 'reads at the cached price, writes at the input price');
  const prior = Priors.parse({ models: [{ match: 'm', strengths: {}, priceInputPerM: 2, priceOutputPerM: 8, priceCachedInputPerM: 0.2 }] }).forModel('m');
  assert.equal(prior?.priceCachedInputPerM, 0.2);
  assert.deepEqual(listPrice(usage, undefined, prior), { usd: 0.92, basis: 'prior-price' });
  assert.deepEqual(attemptCost({ account: { auth: 'api_key', provider: 'openai' } as never, usage, prior }), { basis: 'prior-price', usd: 0.92 });
  const shipped = Priors.load(path.join(RESOURCES, 'model-priors.json'));
  // B-078 D16: real list prices; only the new GPT-6.1 Terra entry ships its cached price, so nothing booked before changes.
  assert.deepEqual(shipped.data.models.filter((entry) => entry.priceCachedInputPerM !== undefined).map((entry) => entry.match), ['gpt-6.1-terra*'], 'nothing booked before changes');
});

test('a failover turn: the attempts\' cached parts add up, and the first attempt\'s is the total minus the last one\'s', () => {
  const attempt = (usage: AttemptResult['usage']): AttemptResult => ({ result: { text: '', stop: 'done' }, streamed: '', reasoning: '', toolCalls: 0, usage, ms: 1 });
  const merged = mergeAttempts(attempt({ inputTokens: 3000, outputTokens: 10, cachedInputTokens: 1000 }), attempt({ inputTokens: 5000, outputTokens: 20, cachedInputTokens: 4000 }));
  assert.deepEqual(merged.usage, { inputTokens: 8000, outputTokens: 30, cachedInputTokens: 5000 });
  assert.deepEqual(firstUsage(merged.usage, merged.lastUsage!), { inputTokens: 3000, outputTokens: 10, cachedInputTokens: 1000 });
  assert.deepEqual(addCache({ cacheReadTokens: 5 }, {}), { cacheReadTokens: 5 }, 'only what one of them reports');
  assert.deepEqual(addCache({}, {}), {});
});
