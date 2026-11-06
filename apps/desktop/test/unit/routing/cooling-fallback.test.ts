// B-072 live run (04.11.2026): in the owner's real install one Codex failure ("could not open the session") cooled the
// Codex plan for 5 minutes and every following turn failed with "Every account that can run a suitable model is
// limited right now". Claude was NOT free that day (its weekly window was at 100 %), so that message was right; the
// cause was a cold Codex app-server that opened the thread after ~65 s, now a timeout that cools nothing (B-075,
// engines/codex-helper-open.test.ts). What this file checks still holds: a turn takes a free account of another plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, agent, mode, standardSetup, T0 } from '../models/harness.ts';

const JONAS = 'ag_jonas0000001';

for (const [label, minTier, work] of [['no mode tier', undefined, undefined], ['a mode that prefers the top tier', 'frontier', undefined], ['Work on auto, as on the owner PC', undefined, 'auto'], ['Work on the Codex plan', undefined, 'codex']] as const) {
  test(`a cooling plan: the turn moves to the free plan (${label}), also after it ran on the cooling one`, async () => {
    const h = await standardSetup();
    if (work) h.settings.update({ routing: { work } } as never);
    h.agents.set(JONAS, agent(JONAS));
    h.addChat('ch_main', [JONAS]);
    h.accounts.upsert(account('acc_codex', 'codex', { state: 'cooling', coolingUntil: T0 + 5 * 60_000 }), false);
    const decision = await h.router.route({
      agent: h.agents.get(JONAS)!, conversationId: 'ch_main', mode: mode('chat', minTier ? { minTier } : {}), text: 'mach mal den ton an',
      previous: { modelId: 'codex:gpt-6.1-sol', effort: 'high' } as never,
    });
    assert.equal(decision.engine, 'claude', JSON.stringify(decision));
  });
}
