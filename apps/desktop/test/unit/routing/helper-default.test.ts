// SG – helper default for runtime text calls (SYSTEM routes): a Codex plan's newest Luna (else its
// smallest model) at low effort, medium for compaction/playbooks or when asked – the Decisions use's "auto"; a
// Decisions model chosen in Settings wins for every helper call; a used-up or low plan and an API-key Codex login
// are skipped; helperModel reads the same pick without a route, else the router's fallback (the live line of the decisions use).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, account, agent, mode, setup, standardSetup } from '../models/harness.ts';
import { HELPER_MIN_HEADROOM, helperEffort, helperModel } from '../../../src/runtime/routing/helper-default.ts';
import { routeHelper } from '../../../src/runtime/decision/engine-runner.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';

const system = agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } });
const LUNA = 'codex:gpt-6-luna';

function helper(text: string, patch: Partial<RouteRequest> = {}): RouteRequest {
  return { agent: system, mode: mode('cheap-chat'), text, ...patch };
}

test('subscription default: the Codex plan\'s Luna at low effort; compaction starts at medium; an asked effort holds', async () => {
  const h = await standardSetup();
  const decision = await h.router.route(helper('decision'));
  assert.deepEqual([decision.modelId, decision.effort, decision.by], [LUNA, 'low', 'pin']);
  assert.match(decision.reason, /helper default/);
  assert.equal((await h.router.route(helper('compact'))).effort, 'medium');
  const asked = await h.router.route(helper('decision', { previous: { modelId: '', effort: 'medium', explicit: true, asked: 'effort' } }));
  assert.deepEqual([asked.modelId, asked.effort], [LUNA, 'medium']);
});

test('the Decisions model chosen in Settings wins for every helper call; "auto" is the helper default', async () => {
  const h = await standardSetup();
  h.settings.update({ routing: { decision: 'claude:claude-haiku-5-5' } });
  assert.equal((await h.router.route(helper('compact'))).modelId, 'claude:claude-haiku-5-5');
  const chosen = await h.router.route(helper('verify'));
  assert.equal(chosen.modelId, 'claude:claude-haiku-5-5');
  assert.match(chosen.reason, /set in Settings/);
  h.settings.update({ routing: { decision: 'auto' } });
  const auto = await h.router.route(helper('verify'));
  assert.match(auto.reason, /helper default/);
  assert.equal(auto.modelId, 'codex:gpt-6-luna');
  // Agents never get the helper default (nor the Decisions model).
  h.settings.update({ routing: { decision: 'claude:claude-haiku-5-5' } });
  const turn = await h.router.route({ agent: agent('ag_1'), mode: mode('chat') });
  assert.doesNotMatch(turn.reason, /helper default|set in Settings/);
});

test('quota and charge: a low or limited plan and an API-key Codex login are skipped', async () => {
  const h = await standardSetup();
  const low = { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 100 - HELPER_MIN_HEADROOM + 1, resetsAt: T0 + 3_600_000 }], readAt: T0 };
  h.accounts.upsert(account('acc_codex', 'codex', { limits: low }), false);
  const skipped = await h.router.route(helper('decision'));
  assert.doesNotMatch(skipped.reason, /helper default/);
  h.accounts.upsert(account('acc_codex', 'codex', { plan: 'api' }), false);
  assert.doesNotMatch((await h.router.route(helper('decision'))).reason, /helper default/);
});

test('the helper default runs only on a qualifying plan login, not on the primary API-key or low login listing the same model', async () => {
  const lists = [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] as const, vision: true },
    { model: 'gpt-6-luna', name: 'Luna', efforts: ['low', 'medium'] as const, vision: false },
  ];
  const make = async (accounts: ReturnType<typeof account>[]) => {
    const h = setup();
    for (const item of accounts) h.accounts.upsert(item, false);
    h.engine('codex').lists.set('codex', lists.map((item) => ({ ...item, efforts: [...item.efforts] })));
    await h.catalog.refresh({ force: true });
    return h;
  };
  const viaPlan = await make([account('acc_api', 'codex', { plan: 'api', priority: 0 }), account('acc_plan', 'codex', { priority: 1, rotation: true })]);
  const planRoute = await viaPlan.router.route(helper('decision'));
  assert.deepEqual([planRoute.modelId, planRoute.accountId, planRoute.by], [LUNA, 'acc_plan', 'pin'], 'never the pay-per-use API-key login');
  assert.match(planRoute.reason, /helper default/);

  const low = { windows: [{ name: '5h', windowMinutes: 300, usedPercent: 90, resetsAt: T0 + 3_600_000 }], readAt: T0 };
  const viaHealthy = await make([account('acc_low', 'codex', { priority: 0, limits: low }), account('acc_ok', 'codex', { priority: 1, rotation: true })]);
  const healthy = await viaHealthy.router.route(helper('decision'));
  assert.deepEqual([healthy.modelId, healthy.accountId], [LUNA, 'acc_ok'], 'never the plan below the quota floor');

  // Only the API-key login lists the model: no helper default – the old cheapest fit decides, without a fallback note.
  const apiOnly = await make([account('acc_api', 'codex', { plan: 'api' })]);
  const fallback = await apiOnly.router.route(helper('decision'));
  assert.doesNotMatch(fallback.reason, /helper default|pinned model/);
  assert.notEqual(fallback.by, 'fallback');
});

test('the newest Luna the account lists, else its smallest model inside the helper band', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('codex').lists.set('codex', [
    { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium'] },
    { model: 'gpt-6.10-luna', name: 'GPT-6.10 Luna', efforts: ['low', 'medium'] },
    { model: 'gpt-6.2-luna', name: 'GPT-6.2 Luna', efforts: ['low', 'medium'] },
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium'] },
  ]);
  await h.catalog.refresh({ force: true });
  assert.equal((await h.router.route(helper('decision'))).modelId, 'codex:gpt-6.10-luna');

  const plain = setup();
  plain.accounts.upsert(account('acc_codex', 'codex'), false);
  plain.engine('codex').lists.set('codex', [
    { model: 'gpt-6-sol-small', name: 'Sol Small', efforts: ['low'] },
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium'] },
  ]);
  await plain.catalog.refresh({ force: true });
  const route = await plain.router.route(helper('decision'));
  assert.equal(route.modelId, 'codex:gpt-6-sol-small');
  assert.match(route.reason, /helper default/);
  assert.equal(helperModel(plain.services)?.model.id, 'codex:gpt-6-sol-small', 'read without a route: the same pick');
});

test('helperModel: the helper default\'s pick on its plan, else the router\'s fallback; API keys only as its spill-over', async () => {
  const h = await standardSetup();
  const pick = helperModel(h.services);
  assert.deepEqual([pick?.model.id, pick?.accountId], [(await routeHelper({ router: h.router, clock: h.clock }, 'decision', {})).modelId, 'acc_codex']);
  // Codex on an API key, Claude on a plan: decisions run on the plan's small model, not on the key's Luna.
  h.accounts.upsert(account('acc_codex', 'codex', { plan: 'api' }), false);
  await h.catalog.refresh({ force: true });
  const route = await routeHelper({ router: h.router, clock: h.clock }, 'Which model decides', {});
  const other = helperModel(h.services);
  assert.deepEqual([other?.model.id, other?.accountId], [route.modelId, route.accountId]);
  assert.equal(other?.model.id, 'claude:claude-haiku-5-5');
  assert.equal(helperModel({ ...h.services, catalog: { list: () => [] } } as never), undefined, 'no model, no pick');
});
