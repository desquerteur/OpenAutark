// B-051 L6: the accounts.try RPC handler – the owner (B-078: and the owner's phone with 'settings' on a secure transport), nothing but an account id, one real turn on exactly
// that account through ctx.services (engines, catalog, accounts, paths, clock), the answer as AccountTry.
// (Its registration and scope are also listed in rpc/s2-handlers.test.ts and rpc/scope-matrix.test.ts.)
// Owns: nothing in production. Never runs a real engine (scripted services; one temp folder, removed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { HandlerTable, allowedScope, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const OWNER: ClientScope = { kind: 'owner' };
const FULL_SECURE: ClientScope = { kind: 'device', deviceId: 'dev_full00000001', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
const FULL_PLAIN: ClientScope = { kind: 'device', deviceId: 'dev_lan000000001', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'] };
const CHAT: ClientScope ={ kind: 'device', deviceId: 'dev_browser00001', capabilities: ['chat'] };

test('accounts.try: owner and a secure settings phone, only an id; one turn on exactly that account through the engines, the answer as AccountTry', async () => {
  const table = new HandlerTable();
  registerProviders(table);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'wf-b051-try-'));
  const runs: Array<[string, string, number]> = [];
  const account = { id: 'acc_codex0000001', provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1 };
  const services = {
    accounts: { get: (id: string) => (id === account.id ? account : undefined), markLimited: () => {}, markUnavailable: () => false, updateLimits: () => {} },
    catalog: { list: () => [{ id: 'codex:gpt-mini', provider: 'codex', model: 'gpt-mini', name: 'mini', engine: 'codex', efforts: ['low'], caps: {}, tier: 'small', relCost: 0.1, strengths: {}, available: true, accounts: [account.id] }] },
    engines: { get: () => ({ run: async (input: { account: { id: string }; model: string; tools: unknown[] }) => { runs.push([input.account.id, input.model, input.tools.length]); return { text: 'OK', stop: 'done' }; } }) },
    paths: { temp },
    clock: { now: () => 1_000 },
    notifications: { notify: () => {} },
  } as unknown as RuntimeServices;
  async function call(params: unknown, scope: ClientScope = OWNER): Promise<any> {
    const entry = table.get('accounts.try')!;
    if (!allowedScope(entry.scope, scope)) throw new WorkforceError('forbidden', 'Not allowed');
    const ctx: HandlerContext = { scope, services, extras: {} as RpcExtras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) };
    return entry.handler(params as never, ctx);
  }
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code);
  try {
    assert.deepEqual(await call({ id: account.id }), { ok: true, ms: 0, model: 'codex:gpt-mini' });
    assert.deepEqual(runs, [[account.id, 'gpt-mini', 0]], 'that account, no tools');
    assert.deepEqual(await call({ id: 'acc_missing00001' }), { ok: false, reason: 'error', message: 'This account does not exist.' });
    for (const params of [{}, { id: account.id, model: 'codex:gpt-6' }, { id: '../x' }, undefined]) await rejects(call(params), 'bad_request');
    // B-078 ("alles vom Handy"): the owner's phone with 'settings' on a secure transport reaches accounts.*; a plain LAN browser does not.
    for (const scope of [FULL_PLAIN, CHAT]) await rejects(call({ id: account.id }, scope), 'forbidden');
    assert.deepEqual(table.get('accounts.try')!.scope, { capability: 'settings', secure: true });
    assert.equal(allowedScope(table.get('accounts.try')!.scope, FULL_SECURE), true);
    assert.equal(runs.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
