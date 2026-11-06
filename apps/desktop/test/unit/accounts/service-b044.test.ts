// B-044 account service additions with the account harness: accounts.useReset reaches the Codex
// engine and reads the limits again afterwards (through the RPC handler too); accounts.test lists an
// endpoint's models with the typed key in process memory for that one call only – nothing stored,
// logged or kept; and migration 72 leaves no OpenCode account, listing, session, 'opencode:' setting
// or model choice pinning an OpenCode model; an account switched back on is checked again at once.
// Owns: nothing in production. Never starts a real CLI or touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import { harness, row } from './harness.ts';

const KEY = 'sk-typed-test-0123456789';

function rpc(service: unknown) {
  const table = new HandlerTable();
  registerProviders(table);
  const scope: ClientScope = { kind: 'owner' };
  const ctx = { scope, services: { accounts: service } as unknown as RuntimeServices, extras: {} as RpcExtras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) } as HandlerContext;
  return async (method: string, params?: unknown): Promise<any> => table.get(method)!.handler(params as never, ctx);
}

test('useReset: the Codex engine redeems with one key per attempt; the limits are read again afterwards', async () => {
  const sent: Array<[string, string, string | undefined]> = [];
  const h = harness({ consumeReset: async (account: Account, key: string, creditId?: string) => { sent.push([account.id, key, creditId]); return 'reset'; } });
  h.repo.save(row('acc_codex', { provider: 'codex', auth: 'cli', limits: { windows: [], readAt: 1, resets: { available: 1, credits: [{ id: 'rc_1' }] } } }));
  const call = rpc(h.service);
  assert.deepEqual(await call('accounts.useReset', { id: 'acc_codex', creditId: 'rc_1' }), { outcome: 'reset' });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][0], sent[0][2]], ['acc_codex', 'rc_1']);
  assert.match(sent[0][1], /^[0-9a-f-]{36}$/, 'a UUID per attempt');
  assert.deepEqual(h.checks, ['acc_codex'], 'the account check read the limits again');
  h.repo.save(row('acc_claude', { provider: 'claude', auth: 'cli' }));
  await assert.rejects(call('accounts.useReset', { id: 'acc_claude' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('accounts.test: the engine gets the typed key for this call only; nothing is stored or kept', async () => {
  const seen: Array<[string, string | undefined, string | undefined]> = [];
  const h = harness({ listModels: async (account, key) => { seen.push([account.provider, account.baseUrl, key]); return [{ model: 'kimi-k3' }, { model: 'kimi-k3-mini' }]; } });
  const call = rpc(h.service);
  const answer = await call('accounts.test', { provider: 'compatible', baseUrl: 'https://api.moonshot.ai/v1', apiKey: KEY });
  assert.deepEqual(answer, { models: ['kimi-k3', 'kimi-k3-mini'] });
  assert.deepEqual(seen, [['compatible', 'https://api.moonshot.ai/v1', KEY]]);
  assert.equal(h.service.list().length, 0, 'no account is added');
  assert.equal(h.vault.size, 0, 'the key never reaches the vault');
  await call('accounts.test', { provider: 'anthropic', baseUrl: 'https://llm.example.test/v1' });
  assert.deepEqual(seen[1], ['anthropic', 'https://llm.example.test/v1', undefined], 'no key typed: none handed over (and none left from before)');
  await assert.rejects(call('accounts.test', { provider: 'compatible', baseUrl: 'http://example.test/v1' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request', 'plain http only on loopback');
});

test('an account on a catalog handle reads its key there; removing it leaves the entry, a typed key goes with its account', async () => {
  const h = harness();
  h.vault.set('deepinfra-key', KEY);
  const linked = await h.service.add({ provider: 'compatible', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'secret://deepinfra-key' });
  assert.equal(linked.secretId, 'secret://deepinfra-key');
  assert.equal(await h.service.apiKey(linked.id), KEY);
  assert.equal(h.vault.size, 1, 'nothing copied');
  await h.service.remove(linked.id);
  assert.equal(h.vault.get('deepinfra-key'), KEY, 'the person\'s catalog entry stays');
  const typed = await h.service.add({ provider: 'compatible', label: 'Other', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-typed' });
  assert.equal(h.vault.size, 2);
  await h.service.remove(typed.id);
  assert.equal(h.vault.size, 1, 'the account\'s own key goes with it');
  await assert.rejects(h.service.add({ provider: 'compatible', label: 'None', baseUrl: 'https://llm.example.test/v1', apiKey: 'secret://nothing' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('an account switched back on is checked again at once (visual pass, round 3: it stayed "unknown")', async () => {
  const h = harness();
  h.repo.save(row('acc_api', { provider: 'openai', auth: 'api_key', secretId: undefined }));
  h.answers.set('acc_api', { state: 'ok', plan: 'api' });
  assert.equal(h.service.update('acc_api', { enabled: false }).state, 'disabled');
  await h.settle();
  assert.deepEqual(h.checks, [], 'switching off checks nothing');
  assert.equal(h.service.update('acc_api', { enabled: true }).state, 'unknown', 'until the check answers (Settings: "Checking…")');
  await h.settle();
  assert.deepEqual(h.checks, ['acc_api']);
  assert.equal(h.service.get('acc_api')?.state, 'ok');
  h.service.update('acc_api', { label: 'Renamed' });
  await h.settle();
  assert.deepEqual(h.checks, ['acc_api'], 'other changes start no check');
});

test('accounts.test: a refusing server answers with a user-safe message', async () => {
  const h = harness({ listModels: async () => { throw new Error(`HTTP 401 for ${KEY}`); } });
  await assert.rejects(h.service.test({ provider: 'openai', apiKey: KEY }), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && !error.message.includes(KEY));
});

test('migration 72: OpenCode accounts, their listings, catalog rows, sessions and opencode: routing settings go; the rest stays', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 71 });
  const account = (id: string, provider: string) => db.run(`INSERT INTO accounts (id, provider, label, auth, state, created_at) VALUES (?, ?, ?, 'cli', 'ok', 1)`, [id, provider, id]);
  account('acc_oc', 'opencode');
  account('acc_codex', 'codex');
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('catalog', 'listing:acc_oc', '{}', 1), ('catalog', 'listing:acc_codex', '{}', 1)`);
  db.run(`INSERT INTO engine_sessions (agent_id, conversation_id, engine, account_id, session_ref, updated_at) VALUES ('ag_1', 'c_1', 'opencode', 'acc_oc', 's1', 1), ('ag_1', 'c_1', 'codex', 'acc_codex', 't1', 1)`);
  db.run(`INSERT INTO models (id, provider, model, name, engine, updated_at) VALUES ('opencode:big', 'opencode', 'big', 'Big', 'opencode', 1), ('codex:gpt-6', 'codex', 'gpt-6', 'GPT-6', 'codex', 1)`);
  db.run(`INSERT INTO model_outcomes (model_id, category, updated_at) VALUES ('opencode:big', 'chat', 1), ('codex:gpt-6', 'chat', 1)`);
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('routing', ?, 1)`, [JSON.stringify({ costMode: 'best', helper: 'opencode:small', functions: { chat: 'opencode:big', image: 'openai:gpt-image-2' }, decisionModel: 'opencode:big', workPlan: 'opencode' })]);
  migrate(db, { until: 72 }); // 87 drops model_outcomes
  assert.deepEqual(db.all<{ id: string }>('SELECT id FROM accounts').map((r) => r.id), ['acc_codex']);
  assert.deepEqual(db.all<{ key: string }>(`SELECT key FROM kv WHERE ns = 'catalog'`).map((r) => r.key), ['listing:acc_codex']);
  assert.deepEqual(db.all<{ engine: string }>('SELECT engine FROM engine_sessions').map((r) => r.engine), ['codex']);
  assert.deepEqual(db.all<{ id: string }>('SELECT id FROM models').map((r) => r.id), ['codex:gpt-6']);
  assert.deepEqual(db.all<{ model_id: string }>('SELECT model_id FROM model_outcomes').map((r) => r.model_id), ['codex:gpt-6']);
  const routing = JSON.parse(db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'routing'`)!.value);
  assert.deepEqual(routing, { costMode: 'best', functions: { image: 'openai:gpt-image-2' } });
});

test('migration 72: model choices pinning an OpenCode model route automatically again; other choices stay', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 71 });
  const agent = (id: string, policy: unknown) => db.run(`INSERT INTO agents (id, name, avatar, model_policy, created_by, created_at, updated_at) VALUES (?, ?, '', ?, 'human', 1, 1)`, [id, id, JSON.stringify(policy)]);
  agent('ag_oc', { pin: 'opencode:big', effort: 'high' });
  agent('ag_codex', { pin: 'codex:gpt-6' });
  db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('routing', 'default_policy', ?, 1)`, [JSON.stringify({ pin: 'opencode:big', floorTier: 'small' })]);
  const chat = (id: string, settings: unknown) => db.run(`INSERT INTO conversations (id, title, settings, created_by, created_at, updated_at) VALUES (?, ?, ?, 'human', 1, 1)`, [id, id, JSON.stringify(settings)]);
  chat('c_oc', { models: { ag_oc: 'opencode:big', ag_codex: 'codex:gpt-6' }, modelHints: { ag_oc: 'opencode:small' }, efforts: { ag_oc: 'high' } });
  chat('c_plain', { models: { ag_codex: 'codex:gpt-6' } });
  migrate(db);
  const policy = (id: string) => JSON.parse(db.get<{ model_policy: string }>('SELECT model_policy FROM agents WHERE id = ?', [id])!.model_policy);
  assert.deepEqual(policy('ag_oc'), { effort: 'high' });
  assert.deepEqual(policy('ag_codex'), { pin: 'codex:gpt-6' });
  assert.deepEqual(JSON.parse(db.get<{ value: string }>(`SELECT value FROM kv WHERE ns = 'routing' AND key = 'default_policy'`)!.value), { floorTier: 'small' });
  const settings = (id: string) => JSON.parse(db.get<{ settings: string }>('SELECT settings FROM conversations WHERE id = ?', [id])!.settings);
  assert.deepEqual(settings('c_oc'), { models: { ag_codex: 'codex:gpt-6' }, modelHints: {}, efforts: { ag_oc: 'high' } });
  assert.deepEqual(settings('c_plain'), { models: { ag_codex: 'codex:gpt-6' } });
});

test('migration 72: a routing row that only named OpenCode goes; other rows stay untouched', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 71 });
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('routing', ?, 1), ('voice', ?, 1)`, [JSON.stringify({ helper: 'opencode:small' }), JSON.stringify({ realtime: 'off' })]);
  migrate(db);
  assert.equal(db.get(`SELECT value FROM settings WHERE key = 'routing'`), undefined);
  assert.equal(db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'voice'`)?.value, JSON.stringify({ realtime: 'off' }));
});
