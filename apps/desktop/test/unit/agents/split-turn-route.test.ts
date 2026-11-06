// B-057 S10 and the route-memory exclusions: a split's model choice as RouteRequest fields (agents/split-turn.ts
// splitPrevious / splitRoute), its policy without the agent's pin and fixed effort and its plan pacing
// (routing/split-route.ts); split runs never feed the return rule (next-route.ts) nor another scope's recaps
// (context/recent-actions.ts – also when many split runs fill the journal); S12's warm Codex rule (warmSplit). Pure
// functions with small fakes. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../models/harness.ts';
import { splitPrevious, splitRoute, warmSplit } from '../../../src/runtime/agents/split-turn.ts';
import { splitPolicy } from '../../../src/runtime/routing/split-route.ts';
import { returnChoice } from '../../../src/runtime/agents/next-route.ts';
import { recentActions } from '../../../src/runtime/context/recent-actions.ts';
import type { EffectivePolicy } from '../../../src/runtime/routing/policies.ts';
import type { Pool } from '../../../src/runtime/routing/pool.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';
import type { Run, RunItem } from '../../../src/shared/model/runs.ts';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const parent = (run: Partial<Run> | undefined) => ({ runs: { get: () => run }, log }) as never;

test('S10: the part\'s model choice becomes the explicit request of its route', () => {
  const s = parent({ model: 'claude:opus', effort: 'high' });
  const base = { parentRunId: 'run_parent' };
  assert.deepEqual(splitPrevious(s, base), { modelId: 'claude:opus', effort: 'high', explicit: true }, "'same' (default): the parent's model and effort");
  assert.deepEqual(splitPrevious(s, { ...base, model: 'same', effort: 'low' }), { modelId: 'claude:opus', effort: 'low', explicit: true });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'cheap' }), { modelId: 'claude:opus', effort: 'high', explicit: true, asked: 'model', need: { kind: 'cheaper', from: 'claude:opus' } });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'cheap', effort: 'low' }), { modelId: 'claude:opus', effort: 'low', explicit: true, need: { kind: 'cheaper', from: 'claude:opus' } });
  assert.equal(splitPrevious(s, { ...base, model: 'strong' }), undefined, "'strong' leaves the model to the rules (tier floor)");
  assert.deepEqual(splitPrevious(s, { ...base, model: 'strong', effort: 'max' }), { modelId: '', effort: 'max', explicit: true, asked: 'effort' });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'codex:gpt-6-sol', effort: 'xhigh' }), { modelId: 'codex:gpt-6-sol', effort: 'xhigh', explicit: true });
  assert.deepEqual(splitPrevious(s, { ...base, model: 'codex:gpt-6-sol' }), { modelId: 'codex:gpt-6-sol', effort: 'high', explicit: true, asked: 'model' });
  assert.equal(splitPrevious(parent(undefined), base), undefined, 'no parent run: the usual rules');
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', model: 'strong' } as never }), { split: { splitId: 'sp_1' }, needs: { tier: 'strong' } });
  assert.deepEqual(splitRoute({ split: { splitId: 'sp_1', model: 'cheap' } as never }), { split: { splitId: 'sp_1' } });
  assert.deepEqual(splitRoute({}), {});
});

test('S12: only a split on a Codex app-server already warm for its account skips the heavy slot', () => {
  const acc = account('acc_plan', 'codex');
  const codex = (warm: () => boolean) => ({ engine: { id: 'codex', warm } as never, account: acc });
  const split = { split: { splitId: 'sp_1' } as never };
  assert.equal(warmSplit(split, codex(() => true)), true);
  assert.equal(warmSplit(split, codex(() => false)), false, 'a cold server starts a process: heavy');
  assert.equal(warmSplit({}, codex(() => true)), false, "the agent's own turn: unchanged");
  assert.equal(warmSplit(split, { engine: { id: 'claude', warm: () => true } as never, account: acc }), false, 'only the shared app-server');
  assert.equal(warmSplit(split, codex(() => { throw new Error('down'); })), false);
});

test('S10: a split\'s policy drops the agent pin (the Work use still applies in the router) and the fixed effort when it names one', () => {
  const policy: EffectivePolicy = { pin: { modelId: 'claude:haiku', source: 'agent' }, agentEffort: 'low', chatEffort: 'medium', prefer: [], avoid: [] };
  assert.equal(splitPolicy(policy, {}), policy, 'not a split: unchanged');
  const named = splitPolicy(policy, { split: { splitId: 'sp_1' }, previous: { modelId: 'claude:opus', effort: 'high', explicit: true } });
  assert.equal(named.pin, undefined);
  assert.equal(named.agentEffort, undefined);
  assert.equal(named.chatEffort, undefined);
  const modelOnly = splitPolicy(policy, { split: { splitId: 'sp_1' }, previous: { modelId: 'x', effort: 'high', explicit: true, asked: 'model' } });
  assert.equal(modelOnly.agentEffort, 'low', 'no effort named: the fixed effort holds');
  assert.equal(splitPolicy(policy, { split: { splitId: 'sp_1' } }).pin, undefined, 'the default model is the Work use (settings), never a policy pin');
});

test('split runs never feed the return rule nor another scope\'s recap', () => {
  const run = (id: string, patch: Partial<Run>): Run => ({ id, agentId: 'ag_tom', trigger: 'message', status: 'done', startedAt: 1, ...patch } as Run);
  const runs = [
    run('run_split', { model: 'claude:haiku', effort: 'low', splitId: 'sp_1' }), // newest: a split's (chat-free) run
    run('run_own', { model: 'claude:opus', effort: 'high' }),
  ];
  assert.equal(returnChoice(runs, undefined, undefined)?.modelId, 'claude:opus', 'a chat-free turn returns to its own model, never a split\'s');

  const call = (runId: string): RunItem => ({ id: `ri_${runId}`, runId, seq: 1, kind: 'tool_call', name: 'files.read', data: { callId: 'c1', args: 'notes.md', own: true }, effectStatus: 'none', createdAt: 5 } as RunItem);
  const journal = [
    run('run_split_failed', { status: 'failed', splitId: 'sp_1', origin: { source: 'mail:inbox' } as never }),
    run('run_mail_failed', { status: 'failed', origin: { source: 'mail:inbox' } as never }),
  ];
  const s = { runs: { list: () => journal, items: (runId: string) => [call(runId)], get: () => undefined }, secrets: { redact: (text: string) => text } } as never;
  assert.deepEqual(recentActions(s, { agentId: 'ag_tom', source: 'mail:inbox' }).map((action) => action.runId), ['run_mail_failed'], 'the source scope leaves the split out');
  assert.deepEqual(recentActions(s, { agentId: 'ag_tom', splitId: 'sp_1' }).map((action) => action.runId), ['run_split_failed'], 'a split sees only its own runs');

  // A group's many split runs never push the agent's own unfinished run out of the recap window.
  const crowd = Array.from({ length: 40 }, (_, i) => run(`run_part_${i}`, { status: 'failed', splitId: `sp_${i}` }));
  const own = run('run_own_cut', { status: 'interrupted', conversationId: 'ch_1' });
  const journal2 = {
    list: (_agentId: string, limit: number) => [...crowd, own].slice(0, limit),
    listTopLevel: (_agentId: string, limit: number) => [own].slice(0, limit),
    listBySplit: (ids: readonly string[]) => crowd.filter((item) => ids.includes(item.splitId!)),
    items: (runId: string) => [call(runId)], get: () => undefined,
  };
  const s2 = { runs: journal2, secrets: { redact: (text: string) => text } } as never;
  assert.deepEqual(recentActions(s2, { agentId: 'ag_tom', conversationId: 'ch_1' }).map((action) => action.runId), ['run_own_cut']);
  assert.deepEqual(recentActions(s2, { agentId: 'ag_tom', splitId: 'sp_7' }).map((action) => action.runId), ['run_part_7']);
});
