// B-048 E4.2 – model.set by need through the tool (tools/builtin/models.ts), planTurn, the real router
// and the run journal: the answer names the model it will be, the next turn runs there (one step, then
// back), a task request holds for the task; need and model together, a pinned agent or a need nothing
// meets are refused without storing anything; stronger on the top model stays there one effort step up;
// now: true asks the dispatcher to continue at once (Dispatcher.continueNow) and says so – without it the
// request applies from the next turn. Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { FakeAccounts, FakeEngine, account, mode } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { Catalog } from '../../../src/runtime/models/catalog.ts';
import { RouterImpl } from '../../../src/runtime/routing/router.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { planTurn, routeRequest } from '../../../src/runtime/agents/turn-prepare.ts';
import { modelTools } from '../../../src/runtime/tools/builtin/models.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Effort, EngineId, RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const AGENT = 'ag_ada';
const caps = { vision: true, tools: true, structuredOutput: true };
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PRIORS = Priors.parse({
  version: 'test-need', categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ALL, strengths: { coding: 0.8, chat: 0.4, 'video-animation': -0.7 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, caps: { tools: true, structuredOutput: true }, efforts: ['none', 'low', 'medium', 'high'], strengths: { coding: 0, chat: 0.4, 'video-animation': -0.6 } },
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, caps, efforts: ALL, strengths: { coding: 0.7, chat: 0.4, 'video-animation': 0.9 } },
  ],
});
const MODES = Object.fromEntries(['coding', 'video-animation'].map((key) => [key, mode(key)]));

async function needToolSetup() {
  const h = harness({ subconscious: {} });
  h.org.add(agent(AGENT, 'Ada', { mode: 'coding' }));
  const chat = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const defaults = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  const settings = { ...defaults, routing: { ...defaults.routing, work: 'gemini-cli' } }; // a Work plan never connected here: no plan bonus
  const engines = new Map<EngineId, FakeEngine>([['codex', new FakeEngine('codex')], ['claude', new FakeEngine('claude')]]);
  engines.get('codex')!.lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL }, { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['none', 'low', 'medium', 'high'] }]);
  engines.get('claude')!.lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL }]);
  const accounts = new FakeAccounts(h.clock, h.bus);
  accounts.upsert(account('acc_codex', 'codex'), false);
  accounts.upsert(account('acc_claude', 'claude'), false);
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const switches: Array<{ agentId: string; runId: string; note: string }> = [];
  const dispatcher = {
    activity: () => [{ agentId: AGENT, runId: 'run_tool', note: '', startedAt: 0, model: LUNA, effort: 'low' as Effort }],
    continueNow: (agentId: string, runId: string, note: string) => { switches.push({ agentId, runId, note }); return true; },
  };
  Object.assign(h.services, {
    settings: { get: () => settings }, accounts, runs, dispatcher, secrets: { use: async () => { throw new Error('no secret'); } },
    engines: { get: (id: EngineId) => engines.get(id)!, all: () => [...engines.values()], disposeIdle: async () => {} },
    modes: { get: (key: string) => { if (!MODES[key]) throw new Error(`unknown mode ${key}`); return MODES[key]; }, list: () => Object.values(MODES) },
  });
  const catalog = new Catalog({ services: () => h.services, priors: PRIORS, debounceMs: 0 });
  h.services.catalog = catalog;
  const router = new RouterImpl({ services: () => h.services });
  h.services.router = router;
  await catalog.refresh({ force: true });

  let seq = 0;
  const finish = (run: Omit<Run, 'id' | 'agentId' | 'conversationId' | 'trigger' | 'status'>) => {
    const id = `run_${++seq}`;
    runs.start({ id, agentId: AGENT, conversationId: chat.id, taskId: run.taskId, trigger: run.taskId ? 'task' : 'message' });
    runs.finish(id, { status: 'done', endedAt: h.clock.now(), ...run });
    h.clock.advance(60_000);
  };
  const turn = async (taskId?: string): Promise<RouteDecision> => {
    const plan = await planTurn(h.services, {
      runId: `plan_${seq + 1}`, agentId: AGENT, conversationId: chat.id, taskId, reason: taskId ? 'task' : 'message', notes: taskId ? [{ text: 'go on', at: 0 }] : [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    });
    assert.ok(plan);
    const route = await router.route(routeRequest(plan));
    finish({ taskId, engine: route.engine, model: route.modelId, effort: route.effort, accountId: route.accountId, route: { reason: route.reason, by: route.by, category: route.category } });
    return route;
  };
  const tool = modelTools.find((item) => item.name === 'model.set')!;
  const ask = (args: Record<string, unknown>, patch: Partial<ToolContext> = {}): Promise<ToolOutput> => tool.run(args, {
    agent: h.org.get(AGENT)!, runId: 'run_tool', conversationId: chat.id, mode: 'coding', services: h.services, modelId: LUNA,
    signal: new AbortController().signal, status() {}, ...patch,
  } as ToolContext);
  return { ...h, chat, catalog, runs, finish, turn, ask, switches, dispatcher };
}

type Answer = { model?: string; modelId?: string; effort?: Effort; appliesTo: string; now?: string; stays?: string };
const ok = (output: ToolOutput): Answer => { assert.ok(!output.isError, JSON.stringify(output.content)); return output.structured as Answer; };
const err = (output: ToolOutput) => { assert.equal(output.isError, true); return String((output.content[0] as { text: string }).text); };

test('need stronger: the answer names the model; the next turn runs there, then routing returns', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'codex', model: LUNA, effort: 'low', route: { reason: 'seed', by: 'rules', category: 'coding' } });
  const answer = ok(await h.ask({ need: 'stronger', reason: 'the tricky part' }));
  const named = h.catalog.get(answer.modelId!)!;
  assert.equal(named.tier, 'frontier');
  assert.equal(answer.model, named.name);
  assert.equal(answer.appliesTo, 'next turn');
  assert.equal(answer.now, undefined);
  const next = await h.turn();
  assert.equal(next.modelId, answer.modelId, 'the model the answer named');
  assert.equal(next.by, 'request');
  assert.match(next.reason, /asked for a stronger model/);
  const back = await h.turn();
  assert.equal(back.modelId, LUNA, 'one step only');
  // for: task – every turn on the task.
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  const onTask = ok(await h.ask({ need: 'stronger', for: 'task' }, { taskId: task.id }));
  assert.match(onTask.appliesTo, /every turn on task/);
  for (let i = 0; i < 2; i++) assert.equal((await h.turn(task.id)).modelId, onTask.modelId);
});

test('refusals store nothing: need with model, a pinned agent, a need nothing meets', async () => {
  const h = await needToolSetup();
  assert.match(err(await h.ask({ need: 'stronger', model: OPUS })), /not both/);
  assert.match(err(await h.ask({})), /Give a need/);
  h.org.add({ ...h.org.get(AGENT)!, modelPolicy: { pin: LUNA } });
  assert.match(err(await h.ask({ need: 'cheaper' })), /pinned by my manager/);
  h.org.add({ ...h.org.get(AGENT)!, modelPolicy: {} });
  assert.match(err(await h.ask({ need: 'long_context' }, { modelId: OPUS })), /^No model with a longer context fits within my model policy right now – I stay on Claude Opus 5\.5/);
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns IN ('next_route', 'next_route_task')")!.n, 0);
});

test('stronger on the best model: it stays, one effort step up – said in the answer and kept for the turn', async () => {
  const h = await needToolSetup();
  h.finish({ engine: 'claude', model: OPUS, effort: 'high', route: { reason: 'seed', by: 'rules', category: 'video-animation' } });
  h.org.add({ ...h.org.get(AGENT)!, mode: 'video-animation' });
  h.dispatcher.activity = () => [{ agentId: AGENT, runId: 'run_tool', note: '', startedAt: 0, model: OPUS, effort: 'high' }];
  const answer = ok(await h.ask({ need: 'stronger' }, { modelId: OPUS, mode: 'video-animation' }));
  assert.equal(answer.modelId, OPUS);
  assert.equal(answer.effort, 'xhigh');
  assert.equal(answer.stays, 'No stronger model fits: I stay on Claude Opus 5.5 at effort xhigh.');
  const next = await h.turn();
  assert.equal(`${next.modelId}/${next.effort}`, `${OPUS}/xhigh`, 'not raised twice');
});

test('now: true continues at once through the dispatcher and says so; without it the next turn', async () => {
  const h = await needToolSetup();
  const answer = ok(await h.ask({ model: OPUS, effort: 'high', now: true }));
  assert.equal(answer.now, 'my turn ends after this call and continues at once on this model');
  assert.deepEqual(h.switches, [{ agentId: AGENT, runId: 'run_tool', note: 'I switched to Claude Opus 5.5 · high (model.set now) – I continue my work where I stopped; what I did so far is kept.' }]);
  const vision = ok(await h.ask({ need: 'vision', now: true }));
  assert.equal(h.switches.length, 2);
  assert.match(h.switches[1].note, new RegExp(`^I switched to ${vision.model}`));
  (h.dispatcher as { continueNow?: unknown }).continueNow = undefined;
  assert.equal(ok(await h.ask({ effort: 'max', now: true })).now, 'cannot switch inside this turn – it applies from my next turn');
});
