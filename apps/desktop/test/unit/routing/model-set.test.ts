// RT2 – model.set is really one step, and the return rule knows categories. Through the model.set
// tool, planTurn (agents/next-route.ts), the real router and the run journal: Sol/low → a requested
// max effort for one turn → back to Sol/low (also after a requested model); a task request holds on
// every turn of its task – not on the chat's other turns, with a next-step request on top for one
// turn – until the task is done; after a change of category the old effort is not carried and the
// old model stays only within 0.3 of the best score. Plus the wave-7 RT1 leftovers: an effort-only
// request leaves the model to the escalation and keeps its effort; a kept stalled model is raised
// above the effort it stalled at, also when that run failed; a task request whose model stalled
// gives way to the stronger_model rung (a next-step request and a non-stalled model still win).
// Owns: these assertions only. Never: real engines, accounts, timers or network.

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
import { returnChoice, temperatureOf } from '../../../src/runtime/agents/next-route.ts';
import { modelTools } from '../../../src/runtime/tools/builtin/models.ts'; // B-048: model.set moved here from skills.ts
import type { RouteRequest } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Effort, EngineId, RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

const SOL = 'codex:gpt-6.1-sol';
const LUNA = 'codex:gpt-6-luna';
const OPUS = 'claude:claude-opus-5-5';
const AGENT = 'ag_ada';
const caps = { vision: true, tools: true, structuredOutput: true };
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Balanced scores (no AA data, plan accounts): coding Sol 0.87 > Opus 0.74; research Opus 0.84, Sol 0.77; cheap chat Luna 0.75 ≫ Sol −0.13. */
const PRIORS = Priors.parse({
  version: 'test-rt2',
  categories: {},
  models: [
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps, efforts: ALL, strengths: { coding: 0.8, research: 0.7, chat: 0.4, 'cheap-chat': -0.2 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, caps, efforts: ['none', 'low', 'medium', 'high'], strengths: { coding: 0, research: 0.2, chat: 0.4, 'cheap-chat': 0.8 } },
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, caps, efforts: ALL, strengths: { coding: 0.7, research: 0.8, chat: 0.4, 'cheap-chat': -0.6 } },
  ],
});
const MODES = Object.fromEntries(['coding', 'cheap-chat', 'research'].map((key) => [key, mode(key)]));

async function rt2Setup() {
  const h = harness({ subconscious: {} });
  h.org.add(agent(AGENT, 'Ada', { mode: 'coding' }));
  const chat = h.chats.create({ agentIds: [AGENT], createdBy: 'human' });
  const defaults = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  const settings = { ...defaults, routing: { ...defaults.routing, work: 'gemini-cli' } }; // the RT2 scores below are without B-044's Claude Code work plan default (a plan never connected here)
  const engines = new Map<EngineId, FakeEngine>([['codex', new FakeEngine('codex')], ['claude', new FakeEngine('claude')]]);
  engines.get('codex')!.lists.set('codex', [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ALL },
    { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['none', 'low', 'medium', 'high'] },
  ]);
  engines.get('claude')!.lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ALL }]);
  const accounts = new FakeAccounts(h.clock, h.bus);
  accounts.upsert(account('acc_codex', 'codex'), false);
  accounts.upsert(account('acc_claude', 'claude'), false);
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  Object.assign(h.services, {
    settings: { get: () => settings }, accounts, runs, secrets: { use: async () => { throw new Error('no secret'); } },
    engines: { get: (id: EngineId) => engines.get(id)!, all: () => [...engines.values()], disposeIdle: async () => {} },
    modes: { get: (key: string) => { if (!MODES[key]) throw new Error(`unknown mode ${key}`); return MODES[key]; }, list: () => Object.values(MODES) },
  });
  const catalog = new Catalog({ services: () => h.services, priors: PRIORS, debounceMs: 0 });
  h.services.catalog = catalog;
  const router = new RouterImpl({ services: () => h.services });
  h.services.router = router;
  await catalog.refresh({ force: true });

  let seq = 0;
  const finish = (run: Omit<Run, 'id' | 'agentId' | 'conversationId' | 'trigger' | 'status'> & { status?: Run['status'] }) => {
    const id = `run_${++seq}`;
    runs.start({ id, agentId: AGENT, conversationId: chat.id, taskId: run.taskId, trigger: run.taskId ? 'task' : 'message' });
    runs.finish(id, { status: 'done', endedAt: h.clock.now(), ...run });
    h.clock.advance(60_000);
    return id;
  };
  /** An earlier turn the rules chose (what the return rule may return to). */
  const seed = (model: string, effort: Effort, category: string, patch: Partial<Run> = {}) =>
    finish({ engine: model.startsWith('claude') ? 'claude' : 'codex', model, effort, route: { reason: 'seed', by: 'rules', category }, ...patch });
  /** One turn: plan, route and record it the way turn-finish does (runs.route = {reason, by, category}). */
  const turn = async (taskId?: string, note?: string): Promise<RouteDecision> => {
    const plan = await planTurn(h.services, {
      runId: `plan_${seq + 1}`, agentId: AGENT, conversationId: chat.id, taskId, reason: taskId ? 'task' : 'message', notes: note ? [{ text: note, at: Date.now() }] : [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    });
    assert.ok(plan, 'a turn is planned');
    const route = await router.route(routeRequest(plan));
    finish({ taskId, engine: route.engine, model: route.modelId, effort: route.effort, accountId: route.accountId, route: { reason: route.reason, by: route.by, category: route.category } });
    return route;
  };
  const modelSet = modelTools.find((tool) => tool.name === 'model.set')!;
  const ask = async (args: Record<string, unknown>, taskId?: string): Promise<ToolOutput> => modelSet.run(args, {
    agent: h.org.get(AGENT)!, runId: 'run_tool', conversationId: chat.id, taskId, mode: 'coding', services: h.services,
    signal: new AbortController().signal, status() {},
  } as ToolContext);
  const setMode = (key: string) => h.org.add({ ...h.org.get(AGENT)!, mode: key });
  return { ...h, chat, router, catalog, runs, seed, turn, ask, setMode };
}

const pair = (route: RouteDecision) => `${route.modelId}/${route.effort}`;
const ok = (output: ToolOutput) => { assert.ok(!output.isError, JSON.stringify(output.content)); return output.structured as { appliesTo: string }; };

test('Sol/low → max for one step → back to low; a requested model returns too', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const usual = await h.turn();
  assert.equal(pair(usual), `${SOL}/low`);
  assert.equal(usual.by, 'previous');

  assert.equal(ok(await h.ask({ effort: 'max', reason: 'the tricky migration' })).appliesTo, 'next turn');
  const hard = await h.turn();
  assert.equal(pair(hard), `${SOL}/max`, 'the requested effort for this step');
  assert.equal(hard.by, 'request');
  assert.match(hard.reason, /effort requested by the agent/);

  const after = await h.turn();
  assert.equal(pair(after), `${SOL}/low`, 'back to the effort before the request');
  assert.equal(after.by, 'previous');
  assert.equal(pair(await h.turn()), `${SOL}/low`);

  // A named model (with and without an effort) is one step too.
  ok(await h.ask({ model: OPUS, effort: 'max' }));
  const opus = await h.turn();
  assert.equal(pair(opus), `${OPUS}/max`);
  assert.equal(opus.by, 'request');
  assert.match(opus.reason, /requested by the agent/);
  assert.equal(pair(await h.turn()), `${SOL}/low`);
  ok(await h.ask({ model: OPUS }));
  const named = await h.turn();
  assert.equal(pair(named), `${OPUS}/low`, 'same category: the effort before is carried to the named model');
  assert.equal(named.by, 'request');
  assert.equal(pair(await h.turn()), `${SOL}/low`);
});

test('task scope: every turn on the task until it is done; other turns and a next step on top', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Port the parser', assigneeId: AGENT, createdBy: 'human' });
  const noTask = await h.ask({ model: OPUS, for: 'task' });
  assert.equal(noTask.isError, true);
  assert.match(String((noTask.content[0] as { text: string }).text), /no task/);

  assert.match(ok(await h.ask({ model: OPUS, effort: 'high', for: 'task' }, task.id)).appliesTo, new RegExp(`every turn on task ${task.id}`));
  for (let i = 0; i < 2; i++) {
    const onTask = await h.turn(task.id);
    assert.equal(pair(onTask), `${OPUS}/high`, `task turn ${i + 1}`);
    assert.equal(onTask.by, 'request');
  }
  assert.equal(pair(await h.turn()), `${SOL}/low`, 'a chat turn without the task returns to the choice before');

  // A next-step request on top: its fields win for one turn, then the task request again.
  ok(await h.ask({ effort: 'max' }));
  assert.equal(pair(await h.turn(task.id)), `${OPUS}/max`);
  assert.equal(pair(await h.turn(task.id)), `${OPUS}/high`);

  // Done: the request ends with the task (its row is dropped) and routing returns.
  h.tasks.setStatus(task.id, 'done', 'human', 'Done');
  // A bare task wake for finished work plans no turn (B-047, turn-prepare.ts SET_ASIDE); a wake with news does.
  const back = await h.turn(task.id, 'The human commented: thanks');
  assert.equal(pair(back), `${SOL}/low`);
  assert.equal(back.by, 'previous');
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kv WHERE ns = 'next_route_task'")!.n, 0);
  const late = await h.ask({ model: OPUS, for: 'task' }, task.id);
  assert.equal(late.isError, true);
  assert.match(String((late.content[0] as { text: string }).text), /finished/);
});

test('category switch: the effort is not carried; the model stays only within 0.3 of the best', async () => {
  // Coding → cheap chat: Sol is not weak there (−0.2 ≥ −0.3, the old rule kept it) but far below Luna.
  const h = await rt2Setup();
  h.seed(SOL, 'high', 'coding');
  h.setMode('cheap-chat');
  const switched = await h.turn();
  assert.equal(pair(switched), `${LUNA}/low`, 'the best fit at the category default effort');
  assert.equal(switched.by, 'rules');
  assert.match(switched.reason, /new work \(coding → cheap chat\) · GPT-6.1 Sol is not close to the best fit/);
  const stays = await h.turn();
  assert.equal(pair(stays), `${LUNA}/low`);
  assert.equal(stays.by, 'previous');

  // Coding → research: Sol scores within 0.3 of Opus, so it continues – at research's default effort, not xhigh.
  const r = await rt2Setup();
  r.seed(SOL, 'xhigh', 'coding');
  r.setMode('research');
  const kept = await r.turn();
  assert.equal(pair(kept), `${SOL}/medium`);
  assert.equal(kept.by, 'previous');
  assert.equal(pair(await r.turn()), `${SOL}/medium`, 'same category now: its effort is carried');

  // A previous choice without a category (older runs) keeps the old rule: model and effort continue.
  const legacy = await r.router.route({ agent: r.org.get(AGENT)!, mode: mode('cheap-chat'), previous: { modelId: SOL, effort: 'high' } });
  assert.equal(pair(legacy), `${SOL}/high`);
});




test('B-078: a temperature rides with the next step (like an effort) and leaves the model to the rules; the answer says where it reaches', async () => {
  const h = await rt2Setup();
  h.seed(SOL, 'low', 'coding');
  const plan = (n: number) => planTurn(h.services, {
    runId: `plan_t${n}`, agentId: AGENT, conversationId: h.chat.id, reason: 'message', notes: [],
    signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
  });
  const answer = ok(await h.ask({ temperature: 1.2 })) as unknown as { temperature: number; temperatureNote?: string };
  assert.equal(answer.temperature, 1.2);
  const first = await plan(1);
  assert.equal(temperatureOf(first!.previous), 1.2, 'the next turn carries it to the engine');
  assert.equal(pair(await h.router.route(routeRequest(first!))), `${SOL}/low`, 'the model and effort stay the rules\'');
  assert.equal(temperatureOf((await plan(2))!.previous), undefined, 'one step only');
  assert.equal((await h.ask({ temperature: 3 })).isError, true);
  assert.equal((await h.ask({})).isError, true);
  // Codex keeps its own temperature: the answer says so (the run's model is unknown here, so it names the target model)
  const named = ok(await h.ask({ model: SOL, temperature: 0.2 })) as unknown as { temperatureNote?: string };
  assert.match(named.temperatureNote ?? '', /keeps its own temperature – temperature \(0–2\) reaches local and OpenAI-compatible models/);
});

test('B-078: pendingRoute keeps a task\'s temperature and a next step\'s on top; returnChoice puts it on the previous choice', () => {
  const at = Date.now();
  const runs = [{ id: 'run_1', agentId: AGENT, conversationId: 'ch', trigger: 'message', status: 'done', model: SOL, effort: 'low', route: { reason: 'r', by: 'rules', category: 'coding' } }] as unknown as Run[];
  assert.equal(temperatureOf(returnChoice(runs, 'ch', { temperature: 0.4, at })), 0.4);
  assert.equal(temperatureOf(returnChoice(runs, 'ch', { modelId: OPUS, temperature: 0, at })), 0);
  assert.equal(temperatureOf(returnChoice(runs, 'ch', { effort: 'high', at })), undefined);
});
