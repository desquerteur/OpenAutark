// RT5: routing.preview answers what Auto would pick for the chat's next turn – with the chat's last
// done run as RouteRequest.previous like a turn (agents/next-route.ts returnChoice), so the return
// rule and the previous effort hold; `ignorePin` (a pinned chat) leaves the chat's own model/effort
// choice out but still returns to its last run; without a chat it is a fresh recommendation.
// Real router and catalog (models harness), fake run journal and modes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable, allowedScope, secureScope } from '../../../src/runtime/rpc/table.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import { returnChoice } from '../../../src/runtime/agents/next-route.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import { agent, mode, standardSetup } from '../models/harness.ts';

const VERA = 'ag_vera00000001';
const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';

const run = (id: string, conversationId: string, model: string, effort: Run['effort'], by = 'rules'): Run =>
  ({ id, agentId: VERA, conversationId, trigger: 'message', model, effort, status: 'done', route: { reason: '', by, category: 'chat' } }) as Run;

async function previewSetup(runs: Run[]) {
  const h = await standardSetup();
  const vera = agent(VERA, { mode: 'chat' });
  h.agents.set(VERA, vera);
  const services = h.services as unknown as Record<string, unknown>;
  services.modes = { get: (key: string) => mode(key) };
  services.runs = { list: (agentId: string) => runs.filter((entry) => entry.agentId === agentId) }; // newest first
  const table = new HandlerTable();
  registerProviders(table);
  const preview = async (params: Record<string, unknown>): Promise<RouteDecision> => {
    const entry = table.get('routing.preview')!;
    assert.ok(allowedScope(entry.scope, { kind: 'owner' }));
    const ctx = { scope: { kind: 'owner' }, services: h.services, extras: {} as RpcExtras, topics: new Set<string>(), signal: new AbortController().signal, secure: secureScope({ kind: 'owner' }) } as unknown as HandlerContext;
    return entry.handler({ agentId: VERA, ...params } as never, ctx) as Promise<RouteDecision>;
  };
  /** What the chat's next turn routes on (agents/turn-prepare.ts: the chat, and the return choice of its runs). */
  const turn = (conversationId: string) => h.router.route({ agent: vera, conversationId, mode: mode('chat'), previous: returnChoice(runs, conversationId, undefined) });
  return { ...h, vera, preview, turn };
}

test('the chat\'s last run continues in the preview like in the turn (return rule and its effort)', async () => {
  const h = await previewSetup([run('run_2', 'ch_other', OPUS, 'max'), run('run_1', 'ch_main', LUNA, 'high')]);
  h.addChat('ch_main', [VERA]);
  h.addChat('ch_fresh', [VERA]);
  const fresh = await h.preview({});
  assert.equal(fresh.modelId, SOL, 'without a chat: a fresh recommendation (the best fit)');
  assert.equal(fresh.by, 'rules');
  assert.equal((await h.preview({ conversationId: 'ch_fresh' })).modelId, SOL, 'a chat without runs: nothing to return to');

  const main = await h.preview({ conversationId: 'ch_main' });
  assert.equal(main.modelId, LUNA, 'Luna is not weak at chat: it continues');
  assert.equal(main.by, 'previous');
  assert.equal(main.effort, 'high', 'the previous effort holds in the same category');
  const next = await h.turn('ch_main');
  assert.deepEqual([main.modelId, main.effort, main.by], [next.modelId, next.effort, next.by], 'the caption names what the turn runs on');
});

test('a pinned chat: ignorePin leaves the pin out, the pinned run is still the choice Auto returns to', async () => {
  const h = await previewSetup([run('run_1', 'ch_pinned', LUNA, 'low', 'pin')]);
  h.addChat('ch_pinned', [VERA], { models: { [VERA]: LUNA }, efforts: { [VERA]: 'low' } });
  const pinned = await h.preview({ conversationId: 'ch_pinned' });
  assert.equal(pinned.by, 'pin', 'without ignorePin the chat\'s pin answers');

  const auto = await h.preview({ conversationId: 'ch_pinned', ignorePin: true });
  assert.equal(auto.modelId, LUNA, 'not ranked[0] (Sol): after switching to Auto the pinned model continues');
  assert.equal(auto.by, 'previous');
  // Switching to Auto clears the chat's model and effort (ModelChip setChatModel 'auto'); the next turn:
  h.conversations.set('ch_pinned', { ...h.conversations.get('ch_pinned')!, settings: {} });
  const next = await h.turn('ch_pinned');
  assert.deepEqual([auto.modelId, auto.effort, auto.by], [next.modelId, next.effort, next.by]);
});

test('an agent pinned to a model: without a chat, ignorePin names what its unpinned option would run (B-072)', async () => {
  const h = await previewSetup([]);
  h.agents.set(VERA, { ...h.vera, modelPolicy: { pin: OPUS } });
  const pinned = await h.preview({});
  assert.deepEqual([pinned.modelId, pinned.by], [OPUS, 'pin'], 'the agent\'s pin answers');
  const unpinned = await h.preview({ ignorePin: true });
  assert.deepEqual([unpinned.modelId, unpinned.by], [SOL, 'rules'], 'the agent page\'s unpinned option shows a model, not the pin');
});

test('ignorePin is a boolean; unknown keys are refused', async () => {
  const h = await previewSetup([]);
  await assert.rejects(h.preview({ conversationId: 'ch_x', ignorePin: 'yes' }));
  await assert.rejects(h.preview({ previous: { modelId: OPUS, effort: 'max' } }), 'a caller cannot inject the previous choice');
});
