// RT5: a model switch says why – "Switched to <model> · <effort> — <first reason>" (at most 120
// characters) after a routing switch (the real router's reason) and after a failover (limit or
// outage of the model before; the same model on another account names no account); the agent reads
// the same line in its delta. RT2: the agent's own model.set request and the return to the choice
// before it are switches too (judged against the chat's last turn), a first turn in a chat is none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { RETURN_WHY, STATUS_MAX, capText, failoverText, firstReason, switchText, switchWhy } from '../../../src/runtime/agents/switch-line.ts';
import { setNextRoute } from '../../../src/runtime/agents/next-route.ts';
import { renderMessages } from '../../../src/runtime/context/render.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';
import { account, agent, mode, standardSetup } from '../models/harness.ts';
import { setup } from './fixture.ts';

const LIMIT: EngineTurnResult = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };
const OUTAGE: EngineTurnResult = { text: '', stop: 'error', error: { code: 'unavailable', message: 'The provider is overloaded. Retry later.' } };

/** The turn fixture with catalog entries and accounts of the routing harness, and a scripted router. */
async function switchSetup(route: (request: RouteRequest) => RouteDecision) {
  const routing = await standardSetup();
  const h = setup();
  const known = new Map<string, ModelInfo>(routing.catalog.list().map((model) => [model.id, model]));
  const accounts = new Map([h.account, account('acc_codex', 'codex'), account('acc_claude_2', 'claude', { label: 'hello@example.com' })].map((item) => [item.id, item]));
  Object.assign(h.services, {
    router: { route: async (request: RouteRequest) => route(request) },
    catalog: { get: (id: string) => known.get(id) },
    accounts: { get: (id: string) => accounts.get(id), updateLimits: () => {}, markLimited: () => true, markUnavailable: () => false },
  });
  const lines = () => h.chats.messages(h.chat.id).filter((message) => message.meta.status?.type === 'model_switched');
  const agentSees = () => renderMessages({ services: h.services, agentId: h.tom.id, humanName: 'Sam', zone: 'UTC', now: Date.now() }, h.chats.messages(h.chat.id), { images: false }).lines;
  return { h, routing, lines, agentSees, run: (runId = 'run_1') => new TurnExecutor(() => h.services).execute(h.request({ runId })) };
}

test('a video turn after a Sol run says the previous model is weak at video animation; the agent reads it too', async () => {
  const routing = await standardSetup();
  const decision = await routing.router.route({ agent: agent('ag_1'), mode: mode('video-animation', { minTier: 'strong' }), previous: { modelId: 'codex:gpt-6.1-sol', effort: 'medium' } });
  assert.equal(decision.modelId, 'claude:claude-opus-5-5');
  assert.match(decision.reason, /^GPT-6\.1 Sol is weak at video animation · /, 'the router puts the switch reason first');

  const s = await switchSetup(() => ({ ...decision, accountId: 'acc_claude' }));
  s.h.runs.push({ id: 'run_0', agentId: s.h.tom.id, conversationId: s.h.chat.id, model: 'codex:gpt-6.1-sol', effort: 'medium', status: 'done' });
  const outcome = await s.run();
  assert.equal(outcome.status, 'done');

  const [line] = s.lines();
  assert.equal(line.body, `Switched to Claude Opus 5.5 · ${decision.effort} — GPT-6.1 Sol is weak at video animation`);
  assert.equal(line.meta.status?.text, line.body);
  assert.equal(line.silent, true, 'still a quiet line');
  assert.deepEqual(line.meta.status?.details, { from: 'codex:gpt-6.1-sol', to: 'claude:claude-opus-5-5', effort: decision.effort, reason: decision.reason, by: decision.by });
  assert.ok(s.agentSees().includes(`· ${line.body}`), 'the agent sees the same text in its delta');

  // No switch, no line (runs are listed newest first).
  s.h.runs.unshift({ id: 'run_1', agentId: s.h.tom.id, conversationId: s.h.chat.id, model: 'claude:claude-opus-5-5', effort: decision.effort, status: 'done' });
  await s.run('run_2');
  assert.equal(s.lines().length, 1);
});

test('failover: the line names the model that hit its limit or is unavailable, never an account label', async () => {
  const sol: RouteDecision = { modelId: 'codex:gpt-6.1-sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'coding', reason: 'coding · strongest fit', by: 'rules', alternatives: [] };
  const opus: RouteDecision = { ...sol, modelId: 'claude:claude-opus-5-5', engine: 'claude', accountId: 'acc_claude', effort: 'high' };
  for (const [result, why] of [[LIMIT, 'GPT-6.1 Sol hit its usage limit'], [OUTAGE, 'GPT-6.1 Sol is unavailable right now']] as const) {
    const s = await switchSetup((request) => (request.exclude?.includes('acc_codex') ? opus : sol));
    s.h.state.script = async (input) => (input.account.id === 'acc_codex' ? result : { text: 'Done.', stop: 'done' });
    const outcome = await s.run();
    assert.equal(outcome.status, 'done', why);
    const lines = s.lines();
    assert.equal(lines.length, 1, why);
    assert.equal(lines[0].body, `Switched to Claude Opus 5.5 · high — ${why}`);
    assert.equal((lines[0].meta.status?.details as { reason: string }).reason, result === LIMIT ? 'limit' : 'unavailable');
    assert.match(lines[0].body, /limit|unavailable/);
  }

  // The same model on a second plan: "another account", no label (it may hold an e-mail address).
  const first: RouteDecision = { ...opus, accountId: 'acc_claude', effort: 'medium' };
  const s = await switchSetup((request) => (request.exclude?.includes('acc_claude') ? { ...first, accountId: 'acc_claude_2' } : first));
  s.h.state.script = async (input) => (input.account.id === 'acc_claude' ? LIMIT : { text: 'Done.', stop: 'done' });
  await s.run();
  const [line] = s.lines();
  assert.equal(line.body, 'Switched to another account · Claude Opus 5.5 · medium — the first one hit its usage limit');
  assert.ok(!line.body.includes('hello@example.com'));
});

test('first reason: the switch note or pin wins; a bare category joins what follows; empty adds nothing', () => {
  assert.equal(firstReason('GPT-6.1 Sol is weak at video animation · video animation · strongest fit', 'video-animation'), 'GPT-6.1 Sol is weak at video animation');
  assert.equal(firstReason('pinned in this chat · coding', 'coding'), 'pinned in this chat');
  assert.equal(firstReason('coding · strongest fit', 'coding'), 'strongest fit for coding');
  assert.equal(firstReason('video animation', 'video-animation'), 'for video animation');
  assert.equal(firstReason('pinned model unavailable · chat · best fit', 'chat'), 'pinned model unavailable');
  assert.equal(firstReason('', 'chat'), undefined);
  assert.equal(switchText('Claude Opus 5.5', 'high'), 'Switched to Claude Opus 5.5 · high');
  assert.equal(failoverText({ modelName: 'Claude Opus 5.5', effort: 'high', failedName: 'GPT-6.1 Sol', sameModel: false, limited: false }),
    'Switched to Claude Opus 5.5 · high — GPT-6.1 Sol is unavailable right now');
});

test('the text is capped at 120 characters at a word boundary', () => {
  const long = switchText('Claude Opus 5.5', 'high', `GPT-6.1 Sol is weak at ${'very long category words '.repeat(8)}`);
  assert.ok(long.length <= STATUS_MAX, `${long.length} characters`);
  assert.ok(long.endsWith('…'));
  assert.ok(long.startsWith('Switched to Claude Opus 5.5 · high — GPT-6.1 Sol is weak at very long'));
  assert.ok(!/\s…$/.test(long), 'no space before the ellipsis');
  const name = 'x'.repeat(200);
  assert.equal(switchText(name, 'low').length, STATUS_MAX, 'one unbroken word is cut hard');
  assert.equal(capText('  short   text '), 'short text');
});

test('RT2: the agent\'s own effort request and the return to the choice before it each get a line', async () => {
  const routing = await standardSetup();
  const OPUS = 'claude:claude-opus-5-5';
  const video = mode('video-animation', { minTier: 'strong' });
  const route = (previous: RouteRequest['previous']) => routing.router.route({ agent: agent('ag_1'), mode: video, previous });
  const kept = await route({ modelId: OPUS, effort: 'high', category: 'video-animation' });
  const asked = await route({ modelId: OPUS, effort: 'max', explicit: true, asked: 'effort', category: 'video-animation' });
  assert.deepEqual([kept.modelId, kept.effort, kept.by], [OPUS, 'high', 'previous']);
  assert.deepEqual([asked.modelId, asked.effort, asked.by], [OPUS, 'max', 'request']);

  let next = asked;
  const s = await switchSetup(() => ({ ...next, accountId: 'acc_claude' }));
  const ran = (id: string, decision: RouteDecision) => s.h.runs.unshift({
    id, agentId: s.h.tom.id, conversationId: s.h.chat.id, model: decision.modelId, effort: decision.effort, status: 'done',
    route: { reason: decision.reason, by: decision.by, category: decision.category },
  });
  ran('run_0', kept);
  setNextRoute(s.h.services.db, s.h.tom.id, s.h.chat.id, { effort: 'max', reason: 'tricky timing', at: 1 });
  await s.run('run_1');
  const [lifted] = s.lines();
  assert.equal(lifted.body, 'Switched to Claude Opus 5.5 · max — effort requested by the agent');
  assert.deepEqual(lifted.meta.status?.details, { from: OPUS, to: OPUS, effort: 'max', reason: asked.reason, by: 'request' });

  // The turn after the requested one returns to high: that is a switch as well.
  ran('run_1', asked);
  next = kept;
  await s.run('run_2');
  assert.equal(s.lines()[1]?.body, `Switched to Claude Opus 5.5 · high — ${RETURN_WHY}`);
  assert.deepEqual(s.lines()[1].meta.status?.details, { from: OPUS, to: OPUS, effort: 'high', reason: kept.reason, by: 'previous' });
  ran('run_2', kept);
  await s.run('run_3');
  assert.equal(s.lines().length, 2, 'no switch, no line');
});

test('RT2: a request for another model says so; a first turn in a chat is no switch, also not a requested one', async () => {
  const routing = await standardSetup();
  const SOL = 'codex:gpt-6.1-sol';
  const asked = await routing.router.route({ agent: agent('ag_1'), mode: mode('video-animation'), previous: { modelId: SOL, effort: 'medium', explicit: true, asked: 'model' } });
  assert.deepEqual([asked.modelId, asked.by], [SOL, 'request']);
  const s = await switchSetup(() => ({ ...asked, accountId: 'acc_codex' }));
  setNextRoute(s.h.services.db, s.h.tom.id, s.h.chat.id, { effort: 'max', at: 1 });
  await s.run('run_1');
  assert.equal(s.lines().length, 0, 'nothing ran in this chat before');

  s.h.runs.unshift({ id: 'run_1', agentId: s.h.tom.id, conversationId: s.h.chat.id, model: 'claude:claude-opus-5-5', effort: 'high', status: 'done', route: { reason: 'video animation · strongest fit', by: 'rules', category: 'video-animation' } });
  setNextRoute(s.h.services.db, s.h.tom.id, s.h.chat.id, { modelId: SOL, at: 2 });
  await s.run('run_2');
  assert.equal(s.lines()[0]?.body, `Switched to GPT-6.1 Sol · ${asked.effort} — requested by the agent`);
});

test('switch why: an effort-only request names it, a return after a request says so, else the first reason', () => {
  const base: RouteDecision = { modelId: 'm1', engine: 'claude', accountId: 'a', effort: 'max', category: 'coding', reason: 'continues on the previous model · coding · effort requested by the agent', by: 'request' as RouteDecision['by'], alternatives: [] };
  assert.equal(switchWhy(base, { modelId: 'm1' }), 'effort requested by the agent');
  assert.equal(switchWhy(base, { modelId: 'm0' }), 'continues on the previous model', 'another model: the reason for the model');
  assert.equal(switchWhy({ ...base, reason: 'continues on the previous model · coding', by: 'previous' }, { modelId: 'm1', requested: true }), RETURN_WHY);
  assert.equal(switchWhy({ ...base, reason: 'coding · strongest fit', by: 'rules' }, { modelId: 'm1', requested: true }), 'strongest fit for coding', 'new work after a request: the rules say why');
  // an escalation says it in plain words, without the work category
  assert.equal(switchWhy({ ...base, reason: 'frontend ui · stuck 4 turns · no stronger model fits · effort raised', by: 'rules' }, { modelId: 'm0' }), 'no progress in the last 4 turns');
  assert.equal(switchWhy({ ...base, reason: 'coding · stuck 1 turn → stronger model', by: 'rules' }, { modelId: 'm0' }), 'no progress in the last turn');
});
