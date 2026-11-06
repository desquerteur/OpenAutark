// RT4 – model knowledge for agents: models.list through the models harness (real catalog, priors,
// accounts and router): video animation lists Opus above Sol and shows Sol's negative fit; a
// ceiling 'strong' agent sees no frontier models; models without a usable account are hidden unless asked for; output stays within
// 30 lines / 2,500 characters; agents.update checks a pin against the catalog (bare ids and names
// resolve, a model several providers list pins its plan copy before an API key, unknown models and
// specialists fail and point to models.list); models.list is a core tool offered in
// the video mode; the rules name the model need (model.set need, routing picks) as another route
// where model.set is offered (B-047 D6: no Models how-to; B-048 E8); decisions and embeddings answer with what runs
// them now and only the models made for them (B-072).
// Owns: these assertions only. Never: real engines, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { T0, account, agent, mode, setup, standardSetup } from '../models/harness.ts';
import { modelTools } from '../../../src/runtime/tools/builtin/models.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { EVERY_MODE, Registry } from '../../../src/runtime/tools/registry.ts';
import { MAX_CHARS, MAX_MODELS, modelList } from '../../../src/runtime/routing/model-list.ts';
import { effortRange, signed, sourceOf, specialistKinds } from '../../../src/runtime/routing/model-facts.ts';
import { parseMode } from '../../../src/runtime/modes/service.ts';
import { fixture, route, RESOURCES, VIDEO_MODE } from '../context/fixture.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Effort, ModelInfo } from '../../../src/shared/model/providers.ts';

const OPUS = 'claude:claude-opus-5-5';
const SOL = 'codex:gpt-6.1-sol';
const MODES: Record<string, ModeInfo> = {
  general: mode('chat', { key: 'general' }),
  video: mode('video-animation', { key: 'video', minTier: 'strong' }),
  manager: mode('manager-planner', { key: 'manager' }),
};
const listTool = modelTools.find((tool) => tool.name === 'models.list')!;
const updateTool = agentTools.find((tool) => tool.name === 'agents.update')!;

const textOf = (out: ToolOutput) => out.content.map((part) => ('text' in part ? part.text : '')).join('\n');
const lineOf = (text: string, id: string) => text.split('\n').find((line) => line.startsWith(`- ${id} `)) ?? '';

function withModes(services: RuntimeServices): RuntimeServices {
  Object.assign(services, { modes: { get: (key: string) => { if (!MODES[key]) throw new Error(`unknown mode ${key}`); return MODES[key]; }, list: () => Object.values(MODES) } });
  return services;
}

function ctxFor(services: RuntimeServices, who: Agent, modeKey: string): ToolContext {
  return { agent: who, runId: 'run_rt4', mode: modeKey, services, signal: new AbortController().signal, status: () => {} };
}

async function list(services: RuntimeServices, who: Agent, modeKey: string, args: Record<string, unknown> = {}): Promise<string> {
  const out = await listTool.run(args, ctxFor(withModes(services), who, modeKey));
  assert.equal(out.isError, undefined);
  return textOf(out);
}

test('video animation: Opus is listed above Sol, Sol shows its negative fit; facts per line', async () => {
  const h = await standardSetup();
  const text = await list(h.services, agent('ag_ada'), 'general', { category: 'video-animation' });
  const opus = text.indexOf(`- ${OPUS} `);
  const sol = text.indexOf(`- ${SOL} `);
  assert.ok(opus >= 0 && sol > opus, `Opus above Sol:\n${text}`);
  assert.match(lineOf(text, SOL), /fit -0\.70/);
  assert.equal(lineOf(text, OPUS), `- ${OPUS} (Claude Opus 5.5) · frontier · plan · low–max · fit +0.90`); // TEST_PRIORS carry no prices or smarts
  assert.match(text, /^Models I can use for video animation, best first/);
  assert.match(text, /model\.set/);
  assert.ok(!text.includes('AA '), 'no AA data without AA rows');

  // The video mode's own work: its minimum tier (strong) drops the small models, lines add strong/weak kinds.
  const own = await list(h.services, agent('ag_vic', { mode: 'video' }), 'video');
  assert.match(own, /^Models I can use for video animation \(my mode's kind of work/);
  assert.ok(own.indexOf(`- ${OPUS} `) < own.indexOf(`- ${SOL} `));
  assert.ok(!own.includes('claude-haiku-5-5') && !own.includes('gpt-6-luna'), 'below the mode tier');
  assert.match(lineOf(own, SOL), /fit -0\.70 · strong: coding \+0\.80, research \+0\.80, chat \+0\.40$/);
  assert.match(lineOf(own, OPUS), /strong: coding \+0\.70, chat \+0\.40 · weak: cheap chat -0\.60/);
});

test('a ceiling-strong agent sees no frontier models', async () => {
  const h = await standardSetup();
  const capped = agent('ag_cap', { modelPolicy: { ceilingTier: 'strong' } });
  const text = await list(h.services, capped, 'general', { category: 'chat' });
  assert.ok(!text.includes(OPUS) && !text.includes(SOL), `no frontier model:\n${text}`);
  assert.match(text, /spans local to strong models/);
  assert.equal(lineOf(text, 'codex:gpt-6-luna'), '- codex:gpt-6-luna (GPT-6 Luna) · small · plan · none–high · fit +0.40');
  const free = await list(h.services, agent('ag_free'), 'general', { category: 'chat' });
  assert.ok(free.includes(OPUS) && free.includes(SOL));
});

test('models without a usable account are hidden unless includeUnavailable asks for them', async () => {
  const h = await standardSetup();
  h.accounts.upsert(account('acc_claude', 'claude', { state: 'needs_login' }), false);
  await h.catalog.refresh({ force: true });
  assert.equal(h.catalog.get(OPUS)?.available, false);
  const vic = agent('ag_vic', { mode: 'video' });
  const text = await list(h.services, vic, 'video');
  assert.ok(!text.includes(`- ${OPUS} `));
  assert.match(text, /1 more cannot run right now \(includeUnavailable: true lists it with the reason\)/);
  const all = await list(h.services, vic, 'video', { includeUnavailable: true });
  assert.match(lineOf(all, OPUS), /· no usable account$/);
  assert.ok(all.indexOf(`- ${SOL} `) < all.indexOf(`- ${OPUS} `), 'usable models first');
});

test('a big catalog stays within 30 lines and 2,500 characters', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('codex').lists.set('codex', [
    { model: 'gpt-solo', name: 'gpt-solo', efforts: ['low', 'medium', 'high'] },
    ...Array.from({ length: 44 }, (_, i) => ({ model: `gpt-test-${String(i).padStart(2, '0')}-preview-long-name`, name: `Test model number ${i} with a long display name`, efforts: ['low', 'high'] as Effort[] })),
  ]);
  await h.catalog.refresh({ force: true });
  const text = modelList({ services: h.services, agent: agent('ag_ada'), mode: MODES.general });
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(text.length <= MAX_CHARS, `${text.length} chars`);
  assert.ok(lines.length > 5 && lines.length <= MAX_MODELS, `${lines.length} lines`);
  assert.match(text, new RegExp(`… ${45 - lines.length} more not shown \\(category narrows it\\)\\.`));
  assert.equal(lineOf(text, 'codex:gpt-solo'), '- codex:gpt-solo · strong · plan · low–high · fit +0.00', 'a name equal to the id is not repeated; unknown models are neutral');
});

test('decisions and embeddings: what answers them now, then only the models made for them – no chat model by fit', async () => {
  const h = await standardSetup();
  const ada = agent('ag_ada');
  const embeddings = await list(h.services, ada, 'general', { category: 'embeddings' });
  assert.match(embeddings, /^Now: Decisions: GPT-6 Luna on acc_codex \(a chat model; no decision model connected\) · Search by meaning: /);
  assert.match(embeddings, /\nEmbedding models connected: none/);
  const decision = await list(h.services, ada, 'general', { category: 'decision' });
  assert.match(decision, /\nDecision models connected: none/);
  for (const text of [embeddings, decision]) {
    for (const id of [SOL, OPUS, 'codex:gpt-6-luna', 'claude:claude-haiku-5-5']) assert.ok(!text.includes(`- ${id}`), `${id} is a chat model:\n${text}`);
    assert.doesNotMatch(text, /fit [+-]/);
  }

  h.engine('compatible').lists.set('ollama', [{ model: 'nimble:latest', name: 'nimble:latest', efforts: [] }, { model: 'bge-m3', name: 'bge-m3', efforts: [] }]);
  h.accounts.upsert(account('acc_ollama', 'ollama', { baseUrl: 'http://127.0.0.1:11434' }), false);
  await h.catalog.refresh({ force: true });
  const local = await list(h.services, ada, 'general', { category: 'embeddings' });
  assert.match(local, /Search by meaning: bge-m3 on acc_ollama/);
  assert.match(local, /\n- ollama:bge-m3 · local$/m);
  assert.ok(!local.includes('nimble'), 'a decision model is no embedding model');
  const typed = await list(h.services, ada, 'general', { category: 'decision' });
  assert.match(typed, /\n- ollama:nimble:latest[ (].*· local$/m);
  assert.ok(!typed.includes('- ollama:bge-m3'));
  assert.match(typed, /^Now: Decisions: GPT-6 Luna on acc_codex \(a chat model; no decision model chosen\)/, 'one is connected, the chat model still answers');
  h.settings.update({ routing: { decision: 'ollama:nimble:latest' } });
  assert.match(await list(h.services, ada, 'general', { category: 'decision' }), /^Now: Decisions: nimble \(decision\) on acc_ollama \(a decision model\)/);
});

test('agents.update checks the pin against the catalog and stores its catalog id', async () => {
  const h = await standardSetup();
  const boss = agent('ag_boss', { mode: 'manager' });
  const report = agent('ag_rep', { managerId: 'ag_boss' });
  h.agents.set(boss.id, boss);
  h.agents.set(report.id, report);
  Object.assign(h.services.org, { canManage: () => true, spaces: () => [] });
  const update = async (args: Record<string, unknown>, who = boss) => updateTool.run(args, ctxFor(withModes(h.services), who, who.mode));

  const bad = await update({ agentId: report.id, pin: 'claude-opus-9' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Unknown model "claude-opus-9"\. models\.list shows the models I can pin/);
  assert.equal(h.agents.get(report.id)!.modelPolicy.pin, undefined, 'nothing stored');
  assert.equal((await update({ agentId: report.id, pin: 'openai:claude-opus-5-5' })).isError, true, 'a provider-qualified id never moves provider');

  const bare = await update({ agentId: report.id, pin: 'claude-opus-5-5', effort: 'high' });
  assert.equal(bare.isError, undefined, textOf(bare));
  assert.deepEqual(h.agents.get(report.id)!.modelPolicy, { pin: OPUS, effort: 'high' });
  assert.equal((bare.structured as { pin?: string }).pin, OPUS);
  assert.equal((await update({ agentId: report.id, pin: 'GPT-6.1 Sol' })).isError, undefined);
  assert.equal(h.agents.get(report.id)!.modelPolicy.pin, SOL, 'a display name resolves');
  assert.equal((await update({ agentId: report.id, pin: '' })).isError, undefined);
  assert.equal(h.agents.get(report.id)!.modelPolicy.pin, undefined, "'' = automatic routing");
  assert.equal((await update({ pin: OPUS }, report)).isError, undefined, 'an agent may pin its own model');

  // A model without a usable account is pinned with a note; a specialist cannot run an agent.
  h.accounts.upsert(account('acc_claude', 'claude', { state: 'needs_login' }), false);
  await h.catalog.refresh({ force: true });
  const later = await update({ agentId: report.id, pin: OPUS });
  assert.match((later.structured as { note?: string }).note ?? '', /no usable account right now/);
  const tts: ModelInfo = { id: 'openai:gpt-6-luna-tts', provider: 'openai', model: 'gpt-6-luna-tts', name: 'Luna TTS', engine: 'openai', efforts: [], caps: {}, tier: 'small', strengths: { chat: -1, tts: 0 }, available: true, accounts: ['acc_oa'], functions: ['tts'] };
  assert.deepEqual(specialistKinds(tts), ['tts']);
  assert.equal(specialistKinds(h.catalog.get(SOL)!), undefined);
  const real = h.services.catalog;
  h.services.catalog = { ...real, list: () => [...real.list(), tts], get: (id: string) => (id === tts.id ? tts : real.get(id)), refresh: async () => {} } as typeof real;
  const special = await update({ agentId: report.id, pin: tts.id });
  assert.match(textOf(special), /Luna TTS is a specialist model \(tts\) and cannot run an agent\. models\.list/);
});

test('agents.update pins the plan copy of a model several providers list, not the API key', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_anth', 'anthropic'), false);
  h.accounts.upsert(account('acc_oa', 'openai'), false);
  const opus = [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] as Effort[], vision: true }];
  for (const engine of ['claude', 'anthropic', 'openai'] as const) h.engine(engine).lists.set(engine, opus);
  await h.catalog.refresh({ force: true });
  assert.deepEqual(h.catalog.list().filter((model) => model.model === 'claude-opus-5-5').map((model) => model.id), ['anthropic:claude-opus-5-5', OPUS, 'openai:claude-opus-5-5'], 'the API-key copy comes first in catalog order');
  const boss = agent('ag_boss', { mode: 'manager' });
  const report = agent('ag_rep', { managerId: 'ag_boss' });
  h.agents.set(boss.id, boss);
  h.agents.set(report.id, report);
  Object.assign(h.services.org, { canManage: () => true, spaces: () => [] });
  const update = async (args: Record<string, unknown>) => updateTool.run(args, ctxFor(withModes(h.services), boss, boss.mode));
  const pinned = () => h.agents.get(report.id)!.modelPolicy.pin;

  for (const pin of ['claude-opus-5-5', 'Claude Opus 5.5']) {
    const out = await update({ agentId: report.id, pin });
    assert.equal(out.isError, undefined, textOf(out));
    assert.equal(pinned(), OPUS, `${pin} pins the plan copy`);
    assert.equal((out.structured as { note?: string }).note,
      `Several models match "${pin}": pinned ${OPUS} (plan); also anthropic:claude-opus-5-5 (API key), openai:claude-opus-5-5 (API key). Pass one of those ids to pin it instead.`);
  }
  const decision = await h.router.route({ agent: h.agents.get(report.id)!, mode: MODES.general, text: 'hello there' });
  assert.equal(decision.modelId, OPUS);
  assert.equal(decision.accountId, 'acc_claude', 'the pinned report runs on the plan');

  const explicit = await update({ agentId: report.id, pin: 'anthropic:claude-opus-5-5' });
  assert.equal(pinned(), 'anthropic:claude-opus-5-5', 'an exact id pins that copy');
  assert.equal((explicit.structured as { note?: string }).note, undefined);

  // Without a usable plan account the available API-key copy wins over the unavailable plan copy.
  h.accounts.upsert(account('acc_claude', 'claude', { state: 'needs_login' }), false);
  await h.catalog.refresh({ force: true });
  const fallback = await update({ agentId: report.id, pin: 'Claude Opus 5.5' });
  assert.equal(pinned(), 'anthropic:claude-opus-5-5');
  const note = (fallback.structured as { note?: string }).note ?? '';
  assert.match(note, /pinned anthropic:claude-opus-5-5 \(API key\); also openai:claude-opus-5-5 \(API key\), claude:claude-opus-5-5 \(plan\)\./);
  assert.doesNotMatch(note, /no usable account/);
});

test('models.list is a core read tool, offered in the video mode; small text helpers', () => {
  assert.ok(EVERY_MODE.has('models.list') && EVERY_MODE.has('model.set'));
  assert.equal(listTool.category, 'read');
  const registry = new Registry({ services: () => ({}) as RuntimeServices });
  const dir = path.join(RESOURCES, 'modes');
  const modes = readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('_'))
    .map((name) => parseMode(name.replace(/\.md$/, ''), readFileSync(path.join(dir, name), 'utf8')));
  const worker = agent('ag_worker', { createdAt: T0 });
  for (const key of ['video']) {
    const found = modes.find((entry) => entry.key === key);
    assert.ok(found, `mode ${key} exists`);
    assert.ok(registry.allowed(listTool, worker, found), `offered in ${key}`);
  }
  assert.equal(effortRange(['low', 'medium', 'high', 'xhigh', 'max']), 'low–max');
  assert.equal(effortRange(['none', 'high']), 'none, high');
  assert.equal(effortRange([]), undefined);
  assert.deepEqual([signed(0.9), signed(-0.7), signed(0), signed(-0.001)], ['+0.90', '-0.70', '+0.00', '+0.00']);
  // Where a model runs: a key from the environment (PR5) and a CLI signed in with an API key are pay-per-use.
  const gpt = { id: 'openai:gpt-6.1', provider: 'openai', model: 'gpt-6.1' } as ModelInfo;
  const where = (patch: Record<string, unknown>) => sourceOf(gpt, { ...account('acc_where', 'openai'), ...patch } as never);
  assert.deepEqual([where({ auth: 'env', envVar: 'OPENAI_API_KEY' }), where({ auth: 'api_key' }), where({ auth: 'cli', plan: 'api' }), where({ auth: 'cli', plan: 'plus' }), where({ auth: 'local' }), where({ auth: 'none' })],
    ['API key', 'API key', 'API key', 'plan', 'local', 'endpoint']);
});

test('B-047 D6 / B-048 E8: the rules name the model need as another route where model.set is offered; no Models how-to section', () => {
  // The compact rules replaced the old "## Models" procedure; models.list / model.set explain themselves in their tool descriptions.
  const f = fixture();
  const { stable } = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() });
  assert.match(stable, /take another – another tool, source, mode, colleague – and fix the broken path/, 'model.set not offered: no model line');
  assert.doesNotMatch(stable, /## Models\n|stronger model/);
  Object.assign(f.services, { tools: { get: () => undefined, specsFor: () => [{ name: 'model.set', description: '', inputSchema: {} }] } });
  const offered = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() }).stable;
  assert.match(offered, /another tool, source, mode, colleague or a stronger model \(model\.set\) – and fix the broken path/);
  assert.doesNotMatch(offered, /## Models\n/);
});
