// B-048 E4.2 – model by need through the real router (routing/need.ts): stronger (the next tier up; on
// the top tier a clearly better fit, else the same model one effort step higher), cheaper and faster
// (lower real cost / a lower tier, never weak at the work), vision, long context; the model model.set
// named is kept while it still fits; nothing fits → the usual rules, the reason says so; a pin wins.
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, mode, standardSetup } from '../models/harness.ts';
import { needCandidates, type ModelNeed } from '../../../src/runtime/routing/need.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { Effort, ModelInfo } from '../../../src/shared/model/providers.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const HAIKU = 'claude:claude-haiku-5-5';

async function needSetup() {
  const h = await standardSetup();
  const route = (category: string, need: ModelNeed, from: string, extra: Partial<NonNullable<RouteRequest['previous']>> = {}, effort: Effort = 'medium') =>
    h.router.route({ agent: agent('ag_1'), mode: mode(category), previous: { modelId: extra.modelId ?? from, effort, explicit: true, asked: 'model', need: { kind: need, from }, ...extra } });
  return { ...h, route };
}

test('stronger: from a small model to the next tier; on the top tier a clearly better fit, else one effort step up', async () => {
  const h = await needSetup();
  const up = await h.route('chat', 'stronger', LUNA);
  assert.equal(h.catalog.get(up.modelId)!.tier, 'frontier');
  assert.equal(up.by, 'request');
  assert.match(up.reason, /^asked for a stronger model · chat/);
  // Opus → Sol for coding (0.8 vs 0.7: at least STRONGER_MARGIN better on the same tier).
  assert.equal((await h.route('coding', 'stronger', OPUS)).modelId, SOL);
  // Video: Opus is the best fit there – it stays, one effort step higher.
  const raised = await h.route('video-animation', 'stronger', OPUS, {}, 'high');
  assert.equal(raised.modelId, OPUS);
  assert.equal(raised.effort, 'xhigh');
  assert.match(raised.reason, /no stronger model fits · effort raised/);
  // A requested effort is kept as asked (model.set stores the raised one itself).
  const asked = await h.route('video-animation', 'stronger', OPUS, { asked: undefined }, 'max');
  assert.equal(asked.effort, 'max');
});

test('cheaper, faster, vision, long context', async () => {
  const h = await needSetup();
  const cheaper = await h.route('chat', 'cheaper', OPUS);
  assert.ok([LUNA, HAIKU].includes(cheaper.modelId), cheaper.modelId);
  assert.match(cheaper.reason, /asked for a cheaper model/);
  const faster = await h.route('chat', 'faster', OPUS);
  assert.equal(h.catalog.get(faster.modelId)!.tier, 'small', 'no measured speed: a lower tier');
  const vision = await h.route('chat', 'vision', LUNA);
  assert.equal(h.catalog.get(vision.modelId)!.caps.vision, true);
  const long = await h.route('chat', 'long_context', SOL);
  assert.equal(long.modelId, OPUS, 'the only window ≥ 400k tokens');
  // The model model.set named is kept while it still meets the need.
  assert.equal((await h.route('chat', 'cheaper', OPUS, { modelId: HAIKU })).modelId, HAIKU);
  assert.equal((await h.route('chat', 'cheaper', OPUS, { modelId: SOL })).modelId, SOL, 'Sol costs less than Opus too: the named one is kept');
  const moved = await h.route('chat', 'cheaper', SOL, { modelId: OPUS });
  assert.notEqual(moved.modelId, OPUS, 'a named model that no longer meets the need gives way');
  assert.match(moved.reason, /asked for a cheaper model/);
});

test('nothing meets the need: the usual rules, led by why; a chat or agent pin wins', async () => {
  const h = await needSetup();
  const none = await h.route('chat', 'long_context', OPUS);
  assert.match(none.reason, /^no model with a longer context fits/);
  assert.notEqual(none.by, 'request');
  const pinned = await h.router.route({ agent: agent('ag_1', { modelPolicy: { pin: LUNA } }), mode: mode('chat'), previous: { modelId: OPUS, effort: 'medium', explicit: true, asked: 'model', need: { kind: 'stronger', from: LUNA } } });
  assert.equal(pinned.modelId, LUNA);
  assert.equal(pinned.by, 'pin');
});

test('needCandidates: never weak at the work (except stronger), cost from the account, speed where measured', () => {
  const model = (id: string, patch: Partial<ModelInfo>): ModelInfo => ({ id, provider: 'codex', model: id, name: id, engine: 'codex', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [], ...patch });
  const entry = (m: ModelInfo) => ({ model: m, accounts: [] });
  const base = model('base', { tier: 'frontier', relCost: 0.6, scores: { outputTokensPerSecond: 50, source: 'artificial-analysis' } });
  const fast = model('fast', { relCost: 0.2, scores: { outputTokensPerSecond: 100, source: 'artificial-analysis' } });
  const slowSmall = model('slow', { tier: 'small', relCost: 0.05, scores: { outputTokensPerSecond: 40, source: 'artificial-analysis' } });
  const weak = model('weak', { tier: 'small', relCost: 0.01, strengths: { chat: -0.5 } });
  const local = model('local', { tier: 'local', relCost: 0 });
  const entries = [base, fast, slowSmall, weak, local].map(entry);
  const cost = (e: { model: ModelInfo }) => e.model.relCost ?? 1;
  const ids = (need: ModelNeed) => needCandidates(entries, { need, from: base, category: 'chat', cost }).map((e) => e.model.id);
  assert.deepEqual(ids('cheaper'), ['fast', 'slow', 'local'], 'weak is never offered');
  assert.deepEqual(ids('faster'), ['fast'], 'measured speeds decide (slow is not faster); local has none and is never the faster guess');
  assert.deepEqual(needCandidates(entries, { need: 'faster', from: model('x', { tier: 'frontier' }), category: 'chat', cost }).map((e) => e.model.id), ['fast', 'slow'], 'without measured speeds: a lower tier, not local');
});
