// B-044 model choice in routing: the one cost preference (Best | Balanced | Cheaper) as the agent's
// "Model preference" line and in models.list; the work plan's score bonus (agents only, while the plan
// has quota, never a pin) – the Work use naming a plan, by default Claude Code while its plan login is on; plain
// conversation routed like any agent turn (the interim small-model chat default is gone, and the return
// rule never continues from a run it routed); the chat hint's Now line and model.set note (the soft
// guide is gone); the weak task lean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T0, account, agent, mode, standardSetup } from '../models/harness.ts';
import { workPlanOf } from '../../../src/runtime/routing/preference.ts';
import { effectiveWorkPlan } from '../../../src/shared/model/model-guide.ts';
import { OLD_CHAT_DEFAULT, returnChoice } from '../../../src/runtime/agents/next-route.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import { WORK_PLAN_BONUS, workPlanBonus } from '../../../src/runtime/routing/score.ts';
import { modelList } from '../../../src/runtime/routing/model-list.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';

const LUNA = 'codex:gpt-6-luna';
const SOL = 'codex:gpt-6.1-sol';
const OPUS = 'claude:claude-opus-5-5';
const HAIKU = 'claude:claude-haiku-5-5';
const system = agent('system', { modelPolicy: { costMode: 'economy', ceilingTier: 'strong' } });
const chat = (patch: Partial<RouteRequest> = {}): RouteRequest => ({ agent: agent('ag_1'), mode: mode('chat'), ...patch });
const low = (left: number) => ({ windows: [{ name: '5h', windowMinutes: 300, usedPercent: 100 - left, resetsAt: T0 + 3_600_000 }], readAt: T0 });


test('work plan: a bonus for the preferred plan while it has quota – agents only, never a pin', async () => {
  assert.equal(workPlanBonus(account('acc_claude', 'claude'), 'claude', T0), WORK_PLAN_BONUS);
  assert.equal(workPlanBonus(account('acc_codex', 'codex'), 'claude', T0), 0);
  assert.equal(workPlanBonus(account('acc_api', 'claude', { plan: 'api' }), 'claude', T0), 0, 'an API-key login pays per use: no plan');
  assert.equal(workPlanBonus(account('acc_claude', 'claude', { limits: low(10) }), 'claude', T0), 0, 'too little quota left');
  assert.equal(workPlanBonus(account('acc_claude', 'claude'), undefined, T0), 0);

  const h = await standardSetup(); // the harness's Work use names a plan it has no login of: no plan preferred
  const coding = (patch: Partial<RouteRequest> = {}) => h.router.route(chat({ mode: mode('coding'), ...patch }));
  assert.equal((await coding()).modelId, SOL, 'no plan preferred: the rules pick Sol for coding');
  h.settings.update({ routing: { work: 'claude' } });
  const preferred = await coding();
  assert.deepEqual([preferred.modelId, preferred.by], [OPUS, 'rules']);
  assert.equal((await coding({ previous: { modelId: SOL, effort: 'medium', explicit: true } })).modelId, SOL, 'the agent may still ask for another model');
  assert.equal((await h.router.route({ agent: system, mode: mode('cheap-chat'), text: 'decision' })).modelId, LUNA, 'helper calls stay on the Luna helper');
  h.settings.update({ routing: { work: 'auto' } });
  assert.equal((await coding()).modelId, OPUS, 'auto: the enabled Claude Code plan login is preferred, exactly as if "claude" were chosen');
  h.accounts.upsert(account('acc_claude', 'claude', { limits: low(15) }), false);
  assert.equal((await coding()).modelId, SOL, 'a nearly used-up plan is not preferred');
  h.settings.update({ routing: { work: 'kimi-cli' } });
  assert.equal((await coding()).modelId, SOL, 'a work plan without a usable login changes nothing');
});

test('the work plan rule: a plan named by the Work use wins, a model pins (no plan), auto = Claude Code while an enabled Claude Code plan login exists', async () => {
  const claude = account('acc_claude', 'claude');
  assert.deepEqual(effectiveWorkPlan(undefined, [claude]), { plan: 'claude', byDefault: true });
  assert.deepEqual(effectiveWorkPlan(undefined, [{ ...claude, enabled: false }]), { byDefault: false }, 'a disabled login');
  assert.deepEqual(effectiveWorkPlan(undefined, [{ ...claude, plan: 'api' }]), { byDefault: false }, 'Claude Code signed in with an API key pays per use');
  assert.deepEqual(effectiveWorkPlan(undefined, [account('acc_codex', 'codex')]), { byDefault: false });
  assert.deepEqual(effectiveWorkPlan('auto', [claude]), { plan: 'claude', byDefault: true });
  assert.deepEqual(effectiveWorkPlan(SOL, [claude]), { byDefault: false }, 'a chosen model pins; no plan preference');
  assert.deepEqual(effectiveWorkPlan('codex', [claude]), { plan: 'codex', byDefault: false });
  const h = await standardSetup();
  h.settings.update({ routing: { work: 'auto' } });
  assert.equal(workPlanOf(h.services), 'claude');
  h.settings.update({ routing: { work: SOL } });
  assert.equal(workPlanOf(h.services), undefined);
});

test('plain conversation is routed like any agent turn: no small-model default, a Work model chosen in Settings pins', async () => {
  const h = await standardSetup();
  for (const work of ['gemini-cli', 'auto']) {
    h.settings.update({ routing: { work } });
    const plain = await h.router.route(chat());
    assert.equal(plain.by, 'rules', `work ${work}`);
    assert.doesNotMatch(plain.reason, /small model for conversation/);
    assert.notEqual(plain.modelId, LUNA, 'Balanced: Luna is for helper calls and compaction');
  }
  h.settings.update({ routing: { work: HAIKU } });
  const settingsChat = await h.router.route(chat());
  assert.deepEqual([settingsChat.modelId, settingsChat.reason], [HAIKU, 'set in Settings · chat']);
  h.settings.update({ routing: { work: LUNA } });
  assert.deepEqual([(await h.router.route(chat())).modelId, (await h.router.route(chat())).by], [LUNA, 'pin'], 'the person may choose Luna for work');
});

test('a chat the removed chat default put on Luna does not stay there: the return rule skips those runs', () => {
  const run = (id: string, model: string, reason: string, by = 'rules') => ({ id, agentId: 'ag_1', conversationId: 'ch_1', model, effort: 'low', status: 'done', route: { reason, by, category: 'chat' } }) as unknown as Run;
  const older = run('run_1', SOL, 'chat · best fit');
  const luna = run('run_2', LUNA, 'small model for conversation · chat', 'pin');
  const fallback = run('run_3', LUNA, 'pinned model unavailable · small model for conversation · chat', 'fallback');
  assert.equal(returnChoice([fallback, luna, older], 'ch_1', undefined)?.modelId, SOL);
  assert.equal(returnChoice([fallback, luna], 'ch_1', undefined), undefined, 'nothing else to return to: the rules decide');
  assert.equal(returnChoice([run('run_4', LUNA, 'chat · best value'), older], 'ch_1', undefined)?.modelId, LUNA, 'a Luna turn the rules chose still counts');
  assert.ok(luna.route!.reason.includes(OLD_CHAT_DEFAULT));
});


