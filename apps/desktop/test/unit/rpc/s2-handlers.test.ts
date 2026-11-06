// R3-S2 handler modules (providers, security, devices, app) against fake services/extras.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable, allowedScope, secureScope } from '../../../src/runtime/rpc/table.ts';
import type { HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import { register as registerSecurity } from '../../../src/runtime/rpc/handlers/security.ts';
import { register as registerDevices } from '../../../src/runtime/rpc/handlers/devices.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { memoryDb } from '../devices/fakes.ts';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../store/helpers.ts';

const OWNER: ClientScope = { kind: 'owner' };
const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone0000001', capabilities: ['todo'] };
const BROWSER: ClientScope = { kind: 'device', deviceId: 'dev_browser00001', capabilities: ['chat'] };
/** DEV2 tiers: a full-access phone with the opt-in 'permissions' capability, on a secure transport or plain LAN http. */
const FULL_SECURE: ClientScope = { kind: 'device', deviceId: 'dev_full00000001', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
const FULL_LAN: ClientScope = { ...FULL_SECURE, secure: false };

type Calls = Array<[string, ...unknown[]]>;

function setup() {
  const calls: Calls = [];
  const record = (name: string, result?: unknown) => (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  const recordAsync = (name: string, result?: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  const db = memoryDb();
  const data = tempDir('wf-s2-');
  const agent = { id: 'ag_01jab3k9z7mx2c4q', name: 'Manager', mode: 'manager' };
  const services = {
    db,
    paths: { data: data.dir },
    accounts: {
      list: record('accounts.list', []),
      detect: recordAsync('accounts.detect', { clis: [] }),
      add: recordAsync('accounts.add', { id: 'acc_1' }),
      update: record('accounts.update', { id: 'acc_1' }),
      login: recordAsync('accounts.login', { started: true }),
      logout: recordAsync('accounts.logout'),
      remove: recordAsync('accounts.remove'),
      install: recordAsync('accounts.install'),
      useReset: recordAsync('accounts.useReset', 'reset'),
      test: recordAsync('accounts.test', { models: ['gpt-6'] }),
      usage: recordAsync('accounts.usage', []),
    },
    catalog: {
      list: record('catalog.list', [{ id: 'codex:gpt-6.1-sol' }]),
      get: (id: string) => (id === 'claude:claude-opus-5-5' ? { id, efforts: ['low', 'high', 'max'] } : undefined),
      recent: record('catalog.recent', ['codex:gpt-6.1-sol']),
    },
    org: { get: (id: string) => (id === agent.id ? agent : undefined) },
    modes: { get: (key: string) => ({ key }) },
    router: { route: recordAsync('router.route', { modelId: 'codex:gpt-6.1-sol' }) },
    secrets: {
      list: () => [{ id: 'sec_1', label: 'Visa', kind: 'card', hint: '4242', createdAt: 1, value: 'LEAK', cipher: 'LEAK' }],
      save: async (input: Record<string, unknown>) => { calls.push(['secrets.save', input]); return { id: 'sec_2', label: input.label, kind: input.kind, createdAt: 2, value: input.value }; },
      remove: record('secrets.remove'),
    },
    devices: {
      list: () => [
        { id: 'dev_phone0000001', kind: 'phone' },
        { id: 'dev_laptop000001', kind: 'pc' },
      ],
    },
  } as unknown as RuntimeServices;
  const extras = {
    catalogRefresh: recordAsync('extras.catalogRefresh', { models: 42, fetchedAt: 5 }),
    catalogStatus: record('extras.catalogStatus', { models: 42, available: 40, refreshedAt: 5 }),
    policies: { get: record('policies.get', null), set: record('policies.set') },
    mesh: { rename: record('mesh.rename', { id: 'dev_laptop000001' }), revoke: record('mesh.revoke') },
    pwa: {
      state: recordAsync('pwa.state', { enabled: true }),
      enable: recordAsync('pwa.enable', { enabled: true }),
      link: recordAsync('pwa.link', { url: 'u' }),
      exchange: record('pwa.exchange', { token: 't', deviceId: 'dev_new' }),
      revoke: recordAsync('pwa.revoke'),
      pushSubscribe: record('pwa.pushSubscribe'),
      pushConfig: recordAsync('pwa.pushConfig', { pushReady: true, vapidPublicKey: 'BKey', subscribed: false }),
      pushUnsubscribe: record('pwa.pushUnsubscribe', 1),
    },
    computer: { preview: recordAsync('computer.preview', { dataUrl: 'data:', width: 1, height: 1, at: 0 }) },
    feedback: { create: record('feedback.create', { id: 'fb_1' }), list: record('feedback.list', []), send: recordAsync('feedback.send', { id: 'fb_1' }), dismiss: record('feedback.dismiss', { id: 'fb_1', status: 'dismissed' }) },
    onboarding: { reset: record('onboarding.reset'), start: record('onboarding.start', { conversationId: 'cv_1' }) },
    importLegacy: recordAsync('importLegacy', { agents: 1, chats: 2, messages: 3 }),
    voice: { transcribe: recordAsync('voice.transcribe', { text: 'hallo' }) },
  } as unknown as RpcExtras;

  const table = new HandlerTable();
  registerProviders(table);
  registerSecurity(table);
  registerDevices(table);
  registerApp(table);

  /** Dispatches like the RPC server: scope check, then the handler. */
  async function call(method: string, params?: unknown, scope: ClientScope = OWNER): Promise<any> {
    const entry = table.get(method);
    if (!entry) throw new WorkforceError('not_found', `Unknown method ${method}`);
    if (!allowedScope(entry.scope, scope)) throw new WorkforceError('forbidden', 'Not allowed');
    const ctx: HandlerContext = { scope, services, extras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) };
    return entry.handler(params as never, ctx);
  }
  const named = (name: string) => calls.filter((entry) => entry[0] === name);
  return { table, call, calls, named, db, services, data: data.dir };
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code);
}

test('all S2 methods are registered once with the specified scopes', () => {
  const { table } = setup();
  const expected = [
    'accounts.list', 'accounts.detect', 'accounts.add', 'accounts.update', 'accounts.login', 'accounts.logout', 'accounts.remove', 'accounts.install',
    'usage.list', 'models.list', 'models.recent', 'models.getPolicy', 'models.setPolicy', 'routing.preview', 'catalog.refresh', 'efforts.forModel',
    'catalog.status',
    'accounts.useReset', 'accounts.test', // B-044 (owner)
    'accounts.try', // B-051 (owner): one tiny real turn on one account (handler: accounts/try-rpc.test.ts)
    'models.uses', // owner: what each use resolves to now (models/uses.test.ts)
    'spend.list',
    'secrets.list', 'secrets.save', 'secrets.delete', 'secrets.capture',
    'secrets.groups', 'secrets.saveGroup', 'secrets.deleteGroup', // X05
    'secrets.folder', 'secrets.openFolder', // B-044 (SECRETS): the metadata files' state; open <data>/secrets (owner)
    'secrets.import', // 29.10.2026: a password export into the catalog
    'secrets.export', // B-075 (owner 04.11.2026): the chosen entries into one CSV file
    'secrets.fillChoices', 'secrets.fillLogin', // B-078 (D20): Fill login in this PC's own browser (owner)
    'devices.list', 'devices.rename', 'devices.revoke',
    'pwa.state', 'pwa.enable', 'pwa.link', 'pwa.revoke', 'pwa.pushSubscribe', 'pwa.pushConfig', 'pwa.pushUnsubscribe', 'pwa.exchange', 'computer.preview',
    'computer.activity', 'computer.stop', 'computer.resume',
    'feedback.create', 'feedback.list', 'feedback.send', 'feedback.dismiss', 'feedback.status',
    'theme.get', 'import.legacy', 'voice.transcribe',
    'onboarding.reset', 'onboarding.start', // B-044 first run
    'voice.localModels', 'voice.pullLocal', 'voice.speak', // B-047 D14 local speech
  ];
  assert.deepEqual(table.methods(), [...expected].sort());
  const CHAT = { capability: 'chat' };
  const MANAGE = { capability: 'manage' };
  const PERMISSIONS = { capability: 'permissions', secure: true };
  const ACCOUNTS = { capability: 'settings', secure: true }; // B-078: plans and keys from the owner's phone app
  const special: Record<string, unknown> = {
    ...Object.fromEntries(['accounts.list', 'accounts.detect', 'accounts.add', 'accounts.update', 'accounts.login', 'accounts.logout', 'accounts.remove',
      'accounts.install', 'accounts.useReset', 'accounts.test', 'accounts.try'].map((method) => [method, ACCOUNTS])),
    'secrets.capture': { capability: 'chat', secure: true },
    'pwa.pushSubscribe': 'any', 'pwa.pushConfig': 'any', 'pwa.pushUnsubscribe': 'any', 'pwa.exchange': 'any',
    'theme.get': { person: true, base: 'any' }, // also an employee's device
    // DEV2 tiers
    'usage.list': CHAT, 'models.list': CHAT, 'models.recent': CHAT, 'models.getPolicy': CHAT, 'efforts.forModel': CHAT,
    'models.setPolicy': MANAGE, 'routing.preview': MANAGE,
    'catalog.status': CHAT,
    'spend.list': PERMISSIONS, 'secrets.list': PERMISSIONS, 'secrets.save': PERMISSIONS, 'secrets.folder': PERMISSIONS,
    'secrets.groups': PERMISSIONS, 'secrets.saveGroup': PERMISSIONS, // X05 (deleteGroup stays on the PC)
    'secrets.import': PERMISSIONS, // 29.10.2026: creates only, like a phone's saveGroup
    'computer.activity': { capability: 'todo' }, 'computer.stop': { capability: 'todo' }, 'computer.resume': { capability: 'todo' },
    'feedback.create': CHAT, 'feedback.list': CHAT, 'feedback.send': CHAT, 'feedback.dismiss': CHAT, 'feedback.status': CHAT,
    'voice.transcribe': CHAT,
    'voice.localModels': CHAT, 'voice.speak': CHAT, // B-047 D14 (voice.pullLocal stays with the owner)
  };
  for (const method of expected) assert.deepEqual(table.get(method)!.scope, special[method] ?? 'owner', method);
});

test('devices may only reach their methods; owner-only methods are forbidden for phones', async () => {
  const { call, data } = setup();
  await rejectsCode(call('secrets.list', undefined, PHONE), 'forbidden');
  await rejectsCode(call('accounts.list', undefined, PHONE), 'forbidden');
  await rejectsCode(call('feedback.list', undefined, PHONE), 'forbidden'); // needs 'chat'
  assert.deepEqual(await call('theme.get', undefined, BROWSER), { css: '' }, 'no theme.css yet');
  writeFileSync(path.join(data, 'theme.css'), ':root { --accent: teal; }');
  assert.deepEqual(await call('theme.get', undefined, PHONE), { css: ':root { --accent: teal; }' }, 'every device reads the look');
  const employee: ClientScope = { kind: 'person', personId: 'per_anna000000', deviceId: 'dev_anna00000001', tokenId: 'tok_1' };
  assert.deepEqual(await call('theme.get', undefined, employee), { css: ':root { --accent: teal; }' }, "an employee's device too");
});

test('spend.list reads the ledger newest first with filters', async () => {
  const { call, db } = setup();
  const insert = (id: string, agent: string, amount: number, at: number) => db.run('INSERT INTO spend (id, agent_id, amount, currency, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, agent, amount, 'EUR', 'purchase', at === 3 ? 'order-7' : null, at]);
  insert('spd_a', 'ag_a', 10, 1);
  insert('spd_b', 'ag_b', 5.5, 2);
  insert('spd_c', 'ag_a', 2, 3);
  const all = await call('spend.list');
  assert.deepEqual(all.map((entry: { id: string }) => entry.id), ['spd_c', 'spd_b', 'spd_a']);
  assert.deepEqual(all[0], { id: 'spd_c', agentId: 'ag_a', amount: 2, currency: 'EUR', kind: 'purchase', ref: 'order-7', createdAt: 3 });
  assert.equal(all[1].ref, undefined);
  assert.deepEqual((await call('spend.list', { agentId: 'ag_a', since: 2 })).map((entry: { id: string }) => entry.id), ['spd_c']);
  await rejectsCode(call('spend.list', { since: -1 }), 'bad_request');
});

test('secrets never leave the runtime: list/save return metadata only', async () => {
  const { call, named } = setup();
  const list = await call('secrets.list');
  assert.deepEqual(list, [{ id: 'sec_1', label: 'Visa', kind: 'card', hint: '4242', createdAt: 1 }]);
  const saved = await call('secrets.save', { label: 'YouTube', kind: 'password', value: 'hunter2', route: 'logins', tags: ['for the web at youtube.com'] });
  assert.equal(saved.value, undefined);
  assert.equal(JSON.stringify(saved).includes('hunter2'), false);
  assert.equal((named('secrets.save')[0][1] as { value: string }).value, 'hunter2');
  await rejectsCode(call('secrets.save', { label: 'x', kind: 'diary' }), 'bad_request');
  await rejectsCode(call('secrets.save', { label: 'x', kind: 'note', domains: ['youtube.com'] }), 'bad_request'); // owner 29.10.2026: nobody can restrict a secret to sites
  await rejectsCode(call('secrets.save', { label: 'x', kind: 'note', agents: ['ag_1'] }), 'bad_request'); // every secret is for every agent
  assert.deepEqual(await call('secrets.delete', { id: 'sec_1' }), { ok: true });
});

test('accounts: add hands the API key to the service; update/install validate', async () => {
  const { call, named } = setup();
  await call('accounts.add', { provider: 'openai', label: 'Work', apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' });
  assert.deepEqual(named('accounts.add')[0][1], { provider: 'openai', label: 'Work', apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', rotation: undefined });
  await rejectsCode(call('accounts.add', { provider: 'myspace' }), 'bad_request');
  await rejectsCode(call('accounts.add', { provider: 'compatible', baseUrl: 'file:///etc/passwd' }), 'bad_request');
  await call('accounts.update', { id: 'acc_1', priority: 2, enabled: false });
  assert.deepEqual(named('accounts.update')[0], ['accounts.update', 'acc_1', { priority: 2, enabled: false }]);
  await rejectsCode(call('accounts.install', { provider: 'openai' }), 'bad_request');
  assert.deepEqual(await call('accounts.install', { provider: 'codex' }), { ok: true });
  assert.deepEqual(await call('accounts.logout', { id: 'acc_1' }), { ok: true });
  await call('usage.list', { refresh: true });
  assert.deepEqual(named('accounts.usage')[0], ['accounts.usage', true]);
  await rejectsCode(call('accounts.install', { provider: 'opencode' }), 'bad_request');
  await rejectsCode(call('accounts.add', { provider: 'opencode' }), 'bad_request');
});

test('B-044 accounts.useReset and accounts.test: the owner and the secure phone (B-078), checked params, the service answers', async () => {
  const { call, named } = setup();
  assert.deepEqual(await call('accounts.useReset', { id: 'acc_1', creditId: 'credit_1' }), { outcome: 'reset' });
  assert.deepEqual(named('accounts.useReset')[0], ['accounts.useReset', 'acc_1', 'credit_1']);
  await rejectsCode(call('accounts.useReset', { id: 'acc_1', key: 'k' }), 'bad_request');
  await rejectsCode(call('accounts.useReset', { id: 'acc_1' }, FULL_LAN), 'forbidden');
  assert.deepEqual(await call('accounts.test', { provider: 'compatible', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-test' }), { models: ['gpt-6'] });
  assert.deepEqual(named('accounts.test')[0][1], { provider: 'compatible', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-test' });
  // a local server's Test (Settings › Add a local server): Ollama, LM Studio, llama.cpp and vLLM are HTTP endpoints too
  for (const provider of ['ollama', 'lmstudio', 'llamacpp', 'vllm']) assert.deepEqual(await call('accounts.test', { provider, baseUrl: 'http://127.0.0.1:1234/v1' }), { models: ['gpt-6'] }, provider);
  await rejectsCode(call('accounts.test', { provider: 'codex' }), 'bad_request');
  await rejectsCode(call('accounts.test', { provider: 'compatible', baseUrl: 'file:///etc/passwd' }), 'bad_request');
  await rejectsCode(call('accounts.test', { provider: 'openai' }, FULL_LAN), 'forbidden');
});

test('models, policies, routing preview and efforts', async () => {
  const { call, named, calls } = setup();
  await call('models.list', { refresh: true });
  assert.deepEqual(calls.slice(-2).map((entry) => entry[0]), ['extras.catalogRefresh', 'catalog.list']);
  assert.deepEqual(await call('catalog.refresh'), { ok: true, models: 42, fetchedAt: 5, refreshedAt: 5 });
  assert.deepEqual(await call('catalog.status', undefined, BROWSER), { models: 42, available: 40, refreshedAt: 5 });
  assert.deepEqual(await call('efforts.forModel', { modelId: 'claude:claude-opus-5-5' }), ['low', 'high', 'max']);
  assert.deepEqual(await call('efforts.forModel', { modelId: 'openrouter:anthropic/unknown' }), []);

  await call('models.setPolicy', { agentId: 'ag_01jab3k9z7mx2c4q', policy: { pin: 'claude:claude-opus-5-5', effort: 'high', avoid: ['codex:gpt-6.1-sol'] } });
  assert.deepEqual(named('policies.set')[0], ['policies.set', { agentId: 'ag_01jab3k9z7mx2c4q' }, { pin: 'claude:claude-opus-5-5', effort: 'high', avoid: ['codex:gpt-6.1-sol'] }]);
  await rejectsCode(call('models.setPolicy', { policy: { floorTier: 'frontier', ceilingTier: 'small' } }), 'bad_request');
  await rejectsCode(call('models.setPolicy', { policy: { effort: 'turbo' } }), 'bad_request');
  assert.equal(await call('models.getPolicy'), null);

  await call('routing.preview', { agentId: 'ag_01jab3k9z7mx2c4q', text: 'cut the intro video' });
  const first = named('router.route')[0][1] as { mode: { key: string }; text: string };
  assert.equal(first.mode.key, 'manager'); // agent's default mode
  await call('routing.preview', { agentId: 'ag_01jab3k9z7mx2c4q', mode: 'video' });
  assert.equal((named('router.route')[1][1] as { mode: { key: string } }).mode.key, 'video');
  await rejectsCode(call('routing.preview', { agentId: 'ag_missing00000' }), 'not_found');
});

test('devices: revoke routes phones to PWA revocation, PCs to the mesh; rename goes to the mesh', async () => {
  const { call, named } = setup();
  await call('devices.revoke', { id: 'dev_phone0000001' });
  await call('devices.revoke', { id: 'dev_laptop000001' });
  assert.deepEqual(named('pwa.revoke')[0], ['pwa.revoke', 'dev_phone0000001']);
  assert.deepEqual(named('mesh.revoke')[0], ['mesh.revoke', 'dev_laptop000001']);
  await rejectsCode(call('devices.revoke', { id: 'dev_unknown00001' }), 'not_found');
  await call('devices.rename', { id: 'dev_laptop000001', name: 'Studio' });
  assert.deepEqual(named('mesh.rename')[0], ['mesh.rename', 'dev_laptop000001', 'Studio']);
});

test('pwa: exchange infers the client kind, pushSubscribe binds the caller scope, enable validates', async () => {
  const { call, named } = setup();
  assert.deepEqual(await call('pwa.exchange', { secret: 'one-time-secret', name: 'iPhone · Safari' }, PHONE), { token: 't', deviceId: 'dev_new' });
  await call('pwa.exchange', { secret: 'one-time-secret', name: 'Windows · Edge' }, PHONE);
  assert.deepEqual(named('pwa.exchange').map((entry) => entry[2]), [{ name: 'iPhone · Safari', kind: 'phone' }, { name: 'Windows · Edge', kind: 'browser' }]);
  await rejectsCode(call('pwa.exchange', { name: 'x' }, PHONE), 'bad_request');

  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.deepEqual(await call('pwa.pushSubscribe', { subscription }, PHONE), { ok: true });
  assert.deepEqual(named('pwa.pushSubscribe')[0], ['pwa.pushSubscribe', subscription, PHONE]);
  await rejectsCode(call('pwa.pushSubscribe', { subscription: { endpoint: 'http://insecure' } }, PHONE), 'bad_request');
  // DEV5A: config and unsubscribe are bound to the caller's scope, the endpoint is checked
  assert.equal((await call('pwa.pushConfig', { endpoint: subscription.endpoint }, PHONE)).vapidPublicKey, 'BKey');
  assert.deepEqual(named('pwa.pushConfig')[0], ['pwa.pushConfig', PHONE, subscription.endpoint]);
  assert.deepEqual(await call('pwa.pushUnsubscribe', undefined, PHONE), { ok: true, removed: 1 });
  assert.deepEqual(named('pwa.pushUnsubscribe')[0], ['pwa.pushUnsubscribe', PHONE, undefined]);
  await rejectsCode(call('pwa.pushUnsubscribe', { endpoint: 'http://insecure' }, PHONE), 'bad_request');
  await rejectsCode(call('pwa.pushConfig', { endpoint: subscription.endpoint, deviceId: 'dev_other' }, PHONE), 'bad_request');

  await call('pwa.enable', { enabled: true, bind: 'lan' });
  assert.deepEqual(named('pwa.enable')[0][1], { enabled: true, bind: 'lan' });
  await rejectsCode(call('pwa.enable', { enabled: true, bind: 'internet' }), 'bad_request');
  await rejectsCode(call('pwa.enable', { bind: 'lan' }), 'bad_request');
  await rejectsCode(call('pwa.link', {}, PHONE), 'forbidden');
  await call('computer.preview', { display: 1 });
  assert.deepEqual(named('computer.preview')[0][1], { deviceId: undefined, display: 1 });
});

test('app: feedback authored by the human, onboarding, import, voice', async () => {
  const { call, named } = setup();
  await call('feedback.create', { kind: 'idea', text: 'Dark mode for charts', view: 'chat', conversationId: 'ch_01jab3k9z7mx2c4q' });
  assert.deepEqual(named('feedback.create')[0][1], { kind: 'idea', text: 'Dark mode for charts', screenshotFileId: undefined, annotationFileId: undefined, view: 'chat', conversationId: 'ch_01jab3k9z7mx2c4q', author: 'human' });
  await rejectsCode(call('feedback.create', { kind: 'rant', text: 'x' }), 'bad_request');
  await rejectsCode(call('feedback.create', { kind: 'bug', text: 'x', author: 'ag_evil' }), 'bad_request');
  await rejectsCode(call('feedback.create', { kind: 'bug', text: 'x', screenshotFileId: '../etc' }), 'bad_request');

  assert.deepEqual(await call('onboarding.reset'), { ok: true });
  assert.deepEqual(await call('onboarding.start'), { conversationId: 'cv_1' }); // B-044: the app's start text in the Manager's chat
  await rejectsCode(call('onboarding.start', { chat: 'x' }), 'bad_request');
  assert.deepEqual(await call('import.legacy'), { imported: { agents: 1, chats: 2, messages: 3 } });

  assert.deepEqual(await call('voice.transcribe', { fileId: 'c'.repeat(64), language: 'de-DE' }), { text: 'hallo' });
  await rejectsCode(call('voice.transcribe', { fileId: 'nope' }), 'bad_request');
  await rejectsCode(call('voice.transcribe', { fileId: 'c'.repeat(64), language: 'de; rm -rf' }), 'bad_request');
});

test('DEV2: the permissions tier needs a secure transport; a phone may only create secrets', async () => {
  const { call, named } = setup();
  await rejectsCode(call('secrets.list', undefined, FULL_LAN), 'forbidden');
  await rejectsCode(call('secrets.list', undefined, PHONE), 'forbidden');
  assert.equal((await call('secrets.list', undefined, FULL_SECURE))[0].value, undefined);
  const created = await call('secrets.save', { label: 'Shop', kind: 'password', value: 'pw-1' }, FULL_SECURE);
  assert.equal(created.value, undefined);
  await rejectsCode(call('secrets.save', { id: 'sec_1', label: 'Visa', kind: 'card', value: 'overwrite' }, FULL_SECURE), 'forbidden');
  assert.equal(named('secrets.save').length, 1, 'the overwrite never reached the vault');
  await rejectsCode(call('secrets.delete', { id: 'sec_1' }, FULL_SECURE), 'forbidden');
  assert.deepEqual(await call('spend.list', undefined, FULL_SECURE), []);
  await rejectsCode(call('spend.list', undefined, FULL_LAN), 'forbidden');
});

test('DEV2: chat devices read usage and models without refreshing; manage refreshes and sets policies', async () => {
  const { call, named } = setup();
  await call('usage.list', { refresh: true }, BROWSER);
  await call('models.list', { refresh: true }, BROWSER);
  assert.deepEqual(named('accounts.usage')[0], ['accounts.usage', false]);
  assert.equal(named('extras.catalogRefresh').length, 0);
  assert.deepEqual(await call('models.recent', undefined, BROWSER), ['codex:gpt-6.1-sol']);
  assert.equal(await call('models.getPolicy', { agentId: 'ag_01jab3k9z7mx2c4q' }, BROWSER), null);
  assert.deepEqual(await call('efforts.forModel', { modelId: 'claude:claude-opus-5-5' }, BROWSER), ['low', 'high', 'max']);
  await rejectsCode(call('models.setPolicy', { policy: { effort: 'high' } }, BROWSER), 'forbidden');
  await rejectsCode(call('routing.preview', { agentId: 'ag_01jab3k9z7mx2c4q' }, BROWSER), 'forbidden');
  await call('usage.list', { refresh: true }, FULL_LAN);
  assert.deepEqual(named('accounts.usage')[1], ['accounts.usage', true]);
  await call('models.setPolicy', { agentId: 'ag_01jab3k9z7mx2c4q', policy: { effort: 'high' } }, FULL_LAN);
  assert.equal(named('policies.set').length, 1);
  for (const method of ['catalog.refresh', 'pwa.state', 'devices.list']) await rejectsCode(call(method, undefined, FULL_SECURE), 'forbidden');
  for (const method of ['accounts.list', 'accounts.install']) await rejectsCode(call(method, method === 'accounts.install' ? { provider: 'codex' } : undefined, FULL_LAN), 'forbidden');
});

test('pwa.link: a name and an app route to open after pairing (owner only, validated)', async () => {
  const { call, named } = setup();
  await call('pwa.link', { name: 'Phone' });
  await call('pwa.link', { route: '#/home' });
  assert.deepEqual(named('pwa.link').map((entry) => entry[1]), [{ name: 'Phone' }, { name: undefined, route: '#/home' }]);
  await rejectsCode(call('pwa.link', { route: 'javascript:alert(1)' }), 'bad_request');
  await rejectsCode(call('pwa.link', { access: 'todo' }), 'bad_request');
  await rejectsCode(call('pwa.link', { name: 'x' }, FULL_SECURE), 'forbidden');
});

test('DEV2: feedback and dictation from a chat device; onboarding and the import stay on the PC', async () => {
  const { call, named } = setup();
  await call('feedback.create', { kind: 'bug', text: 'Menu cut off' }, BROWSER);
  assert.equal((named('feedback.create')[0][1] as { author: string }).author, 'human');
  assert.deepEqual(await call('feedback.list', undefined, BROWSER), []);
  // A device gets the issue URL back; nothing opens or is revealed on the PC (SM5).
  await call('feedback.send', { id: 'fb_1' }, FULL_SECURE);
  assert.deepEqual(named('feedback.send')[0].slice(1), ['fb_1', { reveal: false, visibility: 'public' }]);
  assert.deepEqual(await call('voice.transcribe', { fileId: 'c'.repeat(64) }, BROWSER), { text: 'hallo' });
  await rejectsCode(call('voice.transcribe', { fileId: 'c'.repeat(64) }, PHONE), 'forbidden'); // todo only
  for (const method of ['onboarding.reset', 'onboarding.start', 'voice.pullLocal', 'import.legacy']) {
    await rejectsCode(call(method, undefined, FULL_SECURE), 'forbidden');
  }
});
