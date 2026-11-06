// Model catalog: refresh from several providers, priors merge, coalescing/throttle, account
// events, recent() and specialist models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { account, agent, mode, setup, standardSetup, T0 } from './harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { buildModel } from '../../../src/runtime/models/catalog-merge.ts';

test('refresh builds one row per provider model from two providers and merges priors', async () => {
  const h = await standardSetup();
  const ids = h.catalog.list().map((model) => model.id).sort();
  assert.deepEqual(ids, ['claude:claude-haiku-5-5', 'claude:claude-opus-5-5', 'codex:gpt-6-luna', 'codex:gpt-6.1-sol']);

  const opus = h.catalog.get('claude:claude-opus-5-5')!;
  assert.equal(opus.engine, 'claude');
  assert.equal(opus.provider, 'claude');
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.deepEqual(opus.accounts, ['acc_claude']);
  assert.equal(opus.available, true);
  assert.equal(opus.tier, 'frontier');
  assert.equal(opus.relCost, 0.6);
  assert.equal(opus.strengths['video-animation'], 0.9);
  assert.equal(opus.caps.computerUse, true); // from priors
  assert.equal(opus.caps.contextTokens, 1_000_000); // from the engine
  assert.equal(opus.defaultEffort, 'high'); // our prior beats the engine default
  assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);

  const luna = h.catalog.get('codex:gpt-6-luna')!;
  assert.equal(luna.name, 'GPT-6 Luna'); // engine name was only the raw id → prior name
  assert.equal(luna.caps.vision, false); // engine says no image input
  assert.equal(luna.tier, 'small');

  // Persisted: a new catalog instance reads the same rows without any network.
  const rows = h.db.all<{ id: string }>('SELECT id FROM models ORDER BY id');
  assert.equal(rows.length, 4);
  assert.equal(h.of('models.updated').length, 1);
  assert.equal(h.of('models.updated')[0].length, 4);
});

test('a failing account is logged, never thrown, and keeps its previous listing', async () => {
  const h = await standardSetup();
  h.engine('claude').lists.set('claude', new Error('claude down'));
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['medium'] }]);
  await h.catalog.refresh({ force: true }); // must not reject
  assert.ok(h.warnings.some((w) => w.message === 'model list failed' && w.data?.accountId === 'acc_claude'));
  const ids = h.catalog.list().map((model) => model.id).sort();
  assert.deepEqual(ids, ['claude:claude-haiku-5-5', 'claude:claude-opus-5-5', 'codex:gpt-6.1-sol']);
});

test('unforced refreshes run at most every 10 minutes; concurrent refreshes coalesce', async () => {
  const h = await standardSetup();
  const codex = h.engine('codex');
  assert.equal(codex.calls.length, 1);
  await h.catalog.refresh();
  assert.equal(codex.calls.length, 1, 'throttled');
  h.clock.advance(11 * 60_000);
  await Promise.all([h.catalog.refresh(), h.catalog.refresh(), h.catalog.refresh({ force: true })]);
  assert.equal(codex.calls.length, 2, 'three concurrent calls → one listing');
  await h.catalog.refresh({ force: true });
  assert.equal(codex.calls.length, 3, 'force bypasses the throttle');
});

test('account events: a new account is listed alone, limits churn is ignored, removal drops its models', async () => {
  const h = await standardSetup();
  h.catalog.start();
  const codex = h.engine('codex');
  const claude = h.engine('claude');
  h.engine('compatible').lists.set('ollama', [{ model: 'qwen3.8:27b', name: 'qwen3.8:27b', efforts: ['none'] }]);

  h.accounts.upsert(account('acc_ollama', 'ollama', { baseUrl: 'http://127.0.0.1:11434' }));
  await h.catalog.flush();
  assert.deepEqual(h.engine('compatible').calls, ['acc_ollama']);
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.length, 1);
  const local = h.catalog.get('ollama:qwen3.8:27b')!;
  assert.equal(local.tier, 'local');
  assert.equal(local.relCost, 0);

  // Usage/limits updates do not re-list anything.
  h.accounts.upsert({ ...h.accounts.get('acc_codex')!, limits: { windows: [{ name: 'weekly', windowMinutes: 10080, usedPercent: 40 }], readAt: T0 } });
  await h.catalog.flush();
  assert.equal(codex.calls.length, 1);

  // Logged out → models stay listed but unavailable; logged in again → re-listed.
  h.accounts.upsert({ ...h.accounts.get('acc_claude')!, state: 'needs_login' });
  await h.catalog.flush();
  assert.equal(h.catalog.get('claude:claude-opus-5-5')!.available, false);
  assert.equal(claude.calls.length, 1);
  h.accounts.upsert({ ...h.accounts.get('acc_claude')!, state: 'ok' });
  await h.catalog.flush();
  assert.equal(claude.calls.length, 2);
  assert.equal(h.catalog.get('claude:claude-opus-5-5')!.available, true);

  h.accounts.remove('acc_ollama');
  await h.catalog.flush();
  assert.equal(h.catalog.get('ollama:qwen3.8:27b'), undefined);
  h.catalog.stop();
});

test('demo/test mode: a registered fake engine serves the custom-server accounts end to end', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_custom', 'compatible', { auth: 'none' }), false);
  h.engine('fake').lists.set('compatible', [{ model: 'fake-1', name: 'Fake model', efforts: ['none', 'low', 'medium', 'high'] }]);
  await h.catalog.refresh({ force: true });
  assert.equal(h.catalog.get('compatible:fake-1')!.engine, 'fake');
  const route = await h.router.route({ agent: agent('ag_1'), mode: mode('chat') });
  assert.deepEqual([route.modelId, route.engine, route.accountId], ['compatible:fake-1', 'fake', 'acc_custom']);
});

test('two accounts of one provider share a model row', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_c1', 'claude'), false);
  h.accounts.upsert(account('acc_c2', 'claude', { priority: 1, rotation: true }), false);
  h.engine('claude').lists.set('claude', [{ model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['high'] }]);
  await h.catalog.refresh({ force: true });
  assert.deepEqual(h.catalog.get('claude:claude-opus-5-5')!.accounts.sort(), ['acc_c1', 'acc_c2']);
});


test('recent() returns the most used catalog models of finished runs in the last 30 days', async () => {
  const h = await standardSetup();
  let n = 0;
  const run = (agentId: string, model: string, status: string, startedAt: number) => h.db.run(
    'INSERT INTO runs (id, agent_id, trigger, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?)', [`run_${++n}`, agentId, 'message', model, status, startedAt]);
  for (let i = 0; i < 3; i++) run('ag_a', 'claude:claude-opus-5-5', 'done', T0 - i * 1000);
  for (let i = 0; i < 2; i++) run('ag_b', 'codex:gpt-6.1-sol', 'done', T0 - i * 1000);
  run('ag_a', 'codex:gpt-6-luna', 'done', T0);
  run('ag_a', 'codex:gpt-6-luna', 'failed', T0); // not finished
  for (let i = 0; i < 5; i++) run('ag_a', 'claude:claude-haiku-5-5', 'done', T0 - 40 * 24 * 60 * 60_000); // too old
  run('ag_a', 'gone:model', 'done', T0); // no longer in the catalog
  assert.deepEqual(h.catalog.recent(), ['claude:claude-opus-5-5', 'codex:gpt-6.1-sol', 'codex:gpt-6-luna']);
  assert.deepEqual(h.catalog.recent('ag_b'), ['codex:gpt-6.1-sol']);
});

test('decision and embedding models are specialists: −1 ("never") for every other category', () => {
  const nimble = buildModel({ provider: 'ollama', engine: 'compatible', listed: { model: 'nimble:9b', name: 'nimble:9b', efforts: [] }, priors: Priors.parse({ models: [{ match: 'nimble*', strengths: { decision: 0.9 } }] }) });
  assert.equal(nimble.strengths.decision, 0.9);
  assert.equal(nimble.strengths.chat, -1);
  const embed = buildModel({ provider: 'ollama', engine: 'compatible', listed: { model: 'nomic-embed-text-v2', name: 'x', efforts: [] }, priors: Priors.empty() });
  assert.equal(embed.strengths.chat, -1);
  assert.equal(embed.strengths.embeddings, undefined);
  const general = buildModel({ provider: 'openrouter', engine: 'compatible', listed: { model: 'anthropic/claude-opus-5-5', name: 'Opus', efforts: [] }, priors: Priors.empty() });
  assert.deepEqual(general.strengths, {});
  assert.equal(general.tier, 'strong');
});

test('OpenRouter-style ids match priors by their bare id; the shipped priors file loads', () => {
  const shipped = Priors.parse(JSON.parse(readFileSync(new URL('../../../resources/model-priors.json', import.meta.url), 'utf8')));
  const opus = buildModel({ provider: 'openrouter', engine: 'compatible', listed: { model: 'anthropic/claude-opus-5-5', name: 'anthropic/claude-opus-5-5', efforts: [] }, priors: shipped });
  const sol = buildModel({ provider: 'codex', engine: 'codex', listed: { model: 'gpt-6.1-sol', name: 'gpt-6.1-sol', efforts: ['medium'] }, priors: shipped });
  assert.equal(opus.name, 'Claude Opus 5.5');
  assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max']); // engine reported none → priors
  assert.ok(opus.strengths['video-animation'] > 0.5);
  assert.ok(sol.strengths['video-animation'] < -0.3);
  assert.deepEqual(sol.efforts, ['medium']); // the engine's own list wins
});

test('a failing listing is not re-run on every limits update; it is retried after 10 minutes', async () => {
  const h = await standardSetup();
  h.catalog.start();
  const local = h.engine('compatible');
  local.lists.set('ollama', new Error('server down'));
  h.accounts.upsert(account('acc_ollama', 'ollama', { baseUrl: 'http://127.0.0.1:11434' }));
  await h.catalog.flush();
  assert.equal(local.calls.length, 1);
  const churn = () => h.accounts.upsert({ ...h.accounts.get('acc_ollama')!, limits: { windows: [], readAt: h.clock.now() } });
  churn();
  await h.catalog.flush();
  churn();
  await h.catalog.flush();
  assert.equal(local.calls.length, 1, 'limits churn does not re-run a failing listing');
  h.clock.advance(11 * 60_000);
  local.lists.set('ollama', [{ model: 'qwen3.8:27b', name: 'qwen3.8:27b', efforts: [] }]);
  churn();
  await h.catalog.flush();
  assert.equal(local.calls.length, 2);
  assert.ok(h.catalog.get('ollama:qwen3.8:27b'));
  h.catalog.stop();
});


test('account events debounced before a full refresh are covered by it (first start lists each account once)', async () => {
  const h = setup();
  h.catalog.start();
  h.engine('codex').lists.set('codex', [{ model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['medium'] }]);
  h.accounts.upsert(account('acc_codex', 'codex')); // detection adopts a login → debounced listing
  await h.catalog.refresh({ force: true }); // the initial full refresh follows right away
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the debounce timer fire
  await h.catalog.flush();
  assert.deepEqual(h.engine('codex').calls, ['acc_codex']);
  assert.ok(h.catalog.get('codex:gpt-6.1-sol')?.available);
  h.catalog.stop();
});
