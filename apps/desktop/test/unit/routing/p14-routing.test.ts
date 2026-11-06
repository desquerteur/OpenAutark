// RT10 – the routing E2E's expectations (test/e2e/runtime-routing.test.mjs), checked without a
// runtime: the fake engine lists the WORKFORCE_FAKE_MODELS ids bare, the catalog merges them with
// the SHIPPED priors (resources/model-priors.json) on the demo 'compatible' account, and the real
// router with the real return rule (agents/next-route.ts) picks: coding → GPT-6.1 Sol; a Remotion
// animation after it → Claude Opus 5.5 high (weak prior, with the switch line's text); an effort
// request holds for one step; a stuck cheap-chat task on Claude Haiku → a stronger model at high.
// A change of the shipped priors that would break the E2E fails here first.
// Owns: these assertions only. Never: network, processes or real accounts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeEngine, fakeModels } from '../../../src/runtime/engines/fake.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { returnChoice } from '../../../src/runtime/agents/next-route.ts';
import { firstReason, switchText } from '../../../src/runtime/agents/switch-line.ts';
import { account, agent, mode, setup, T0 } from '../models/harness.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

/** The E2E's WORKFORCE_FAKE_MODELS (no fake-1: a strong-tier fake-1 would be the "stronger" model above Haiku). */
const MODELS = 'gpt-6.1-sol,claude-opus-5-5,claude-haiku-5-5';
const SOL = 'compatible:gpt-6.1-sol';
const OPUS = 'compatible:claude-opus-5-5';
const HAIKU = 'compatible:claude-haiku-5-5';
const CODING = 'Fix the TypeScript bug in the parser and add a unit test.';
const REMOTION = 'Now build a Remotion animation of the parser results with smooth keyframes.';
const STUCK = 'Summarize the launch notes [[fail]]';
const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');

const general = mode('chat'); // the general mode: category chat, refined by the turn's text
const vera = agent('ag_vera');

async function demo() {
  const h = setup({ priors: Priors.shipped(resources) });
  h.accounts.upsert(account('acc_demo', 'compatible', { auth: 'none', label: 'Demo engine', baseUrl: 'http://127.0.0.1:9/v1' }), false);
  h.engine('fake').lists.set('compatible', fakeModels(MODELS));
  await h.catalog.refresh({ force: true });
  const route = (patch: Partial<RouteRequest>) => h.router.route({ agent: vera, mode: general, conversationId: 'ch_1', ...patch });
  return { ...h, route };
}

let seq = 0;
function run(patch: Partial<Run>): Run {
  seq += 1;
  return { id: `run_${seq}`, agentId: vera.id, conversationId: 'ch_1', trigger: 'message', status: 'done', startedAt: T0 + seq, ...patch };
}

test('fakeModels: fake-1 by default; listed ids bare, trimmed, deduplicated and bounded; the engine reads the variable', async () => {
  for (const value of [undefined, '', ' , ', 'bad id!,x y']) assert.deepEqual(fakeModels(value).map((model) => model.model), ['fake-1'], String(value));
  assert.deepEqual(fakeModels(' gpt-6.1-sol, claude-opus-5-5,gpt-6.1-sol ,fake-1'), [
    { model: 'gpt-6.1-sol', name: 'gpt-6.1-sol', efforts: [] },
    { model: 'claude-opus-5-5', name: 'claude-opus-5-5', efforts: [] },
    { model: 'fake-1', name: 'Fake model', efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium' },
  ]);
  assert.equal(fakeModels(Array.from({ length: 30 }, (_, i) => `model-${i}`).join(',')).length, 20);
  fakeModels(undefined)[0].efforts.push('max');
  assert.deepEqual(fakeModels(undefined)[0].efforts, ['none', 'low', 'medium', 'high'], 'a caller cannot change the default entry');

  const saved = process.env.WORKFORCE_FAKE_MODELS;
  try {
    delete process.env.WORKFORCE_FAKE_MODELS;
    assert.deepEqual((await new FakeEngine().listModels()).map((model) => model.model), ['fake-1']);
    process.env.WORKFORCE_FAKE_MODELS = MODELS;
    assert.deepEqual((await new FakeEngine().listModels()).map((model) => model.model), ['gpt-6.1-sol', 'claude-opus-5-5', 'claude-haiku-5-5']);
  } finally {
    if (saved === undefined) delete process.env.WORKFORCE_FAKE_MODELS;
    else process.env.WORKFORCE_FAKE_MODELS = saved;
  }
});

test('the catalog merges the bare listing with the shipped priors (names, tiers, efforts)', async () => {
  const h = await demo();
  assert.deepEqual(h.catalog.list().filter((model) => model.available).map((model) => model.id).sort(), [HAIKU, OPUS, SOL]);
  const opus = h.catalog.get(OPUS)!;
  assert.deepEqual([opus.name, opus.tier, opus.engine, opus.defaultEffort], ['Claude Opus 5.5', 'frontier', 'fake', 'high']);
  assert.ok(opus.efforts.includes('max'), 'efforts come from the priors when the listing names none');
  assert.deepEqual([h.catalog.get(SOL)!.name, h.catalog.get(SOL)!.tier], ['GPT-6.1 Sol', 'frontier']);
  assert.deepEqual([h.catalog.get(HAIKU)!.name, h.catalog.get(HAIKU)!.tier], ['Claude Haiku 5.5', 'small']);
});

test('coding → GPT-6.1 Sol; a Remotion animation after it → Claude Opus 5.5 high, and the switch line says why', async () => {
  const h = await demo();
  const coding = await h.route({ text: CODING });
  assert.deepEqual([coding.modelId, coding.effort, coding.category, coding.by], [SOL, 'medium', 'coding', 'rules']);

  const previous = returnChoice([run({ model: SOL, effort: coding.effort, route: { reason: coding.reason, by: coding.by, category: coding.category } })], 'ch_1', undefined);
  const remotion = await h.route({ text: REMOTION, previous });
  assert.deepEqual([remotion.modelId, remotion.effort, remotion.category, remotion.by], [OPUS, 'high', 'video-animation', 'rules']);
  assert.match(remotion.reason, /^GPT-6\.1 Sol is weak at video animation · /);
  assert.equal(switchText('Claude Opus 5.5', remotion.effort, firstReason(remotion.reason, remotion.category)),
    'Switched to Claude Opus 5.5 · high — GPT-6.1 Sol is weak at video animation');
});

test('model.set {effort: max} holds for the next turn only; then the previous effort returns', async () => {
  const h = await demo();
  const video = { reason: 'video animation · strongest fit', category: 'video-animation' };
  const runs = [run({ model: OPUS, effort: 'high', route: { ...video, by: 'previous' } }), run({ model: SOL, effort: 'medium', route: { reason: 'coding', by: 'rules', category: 'coding' } })];

  const asked = returnChoice(runs, 'ch_1', { effort: 'max', at: T0 });
  const lifted = await h.route({ text: 'Continue the Remotion animation.', previous: asked });
  assert.deepEqual([lifted.modelId, lifted.effort, lifted.by], [OPUS, 'max', 'request']);

  const after = [run({ model: OPUS, effort: 'max', route: { reason: lifted.reason, by: lifted.by, category: lifted.category } }), ...runs];
  const back = await h.route({ text: 'Polish the Remotion animation.', previous: returnChoice(after, 'ch_1', undefined) });
  assert.deepEqual([back.modelId, back.effort, back.by], [OPUS, 'high', 'previous'], 'the run the request shaped is skipped');
});

