// Claude Code model listing edge cases against the scripted CLI (claude-fixture.ts) – no real
// binary, no network: the 1M variant's bracket-free catalog id passes the RPC model-id checks
// (models.setPolicy pin/prefer/avoid, efforts.forModel) and runs as `--model <id>[1m]`; a probe
// that does not answer keeps the last good list, is retried after a minute and, with
// no list yet, throws so the catalog keeps its previous listing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandlerTable, allowedScope, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import { cliModel } from '../../../src/runtime/engines/claude/models.ts';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup, type ClaudeScript } from './claude-fixture.ts';

const INIT = {
  models: [
    { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Most capable for complex work' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Best for everyday tasks' },
    { value: 'sonnet[1m]', displayName: 'Sonnet (1M context)', description: 'Sonnet 5.5 for long sessions' },
    { value: 'claude-opus-4-1-20250805', displayName: 'Opus 4.1', description: 'Legacy model', supportsEffort: false },
  ],
  account: { email: 'person@example.test', subscriptionType: 'max' },
};
const LISTED = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5-1m', 'claude-opus-4-1-20250805'];
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** The providers handlers over a recording policy store and a catalog with the listed ids. */
function rpc(catalogIds: string[]) {
  const set: unknown[] = [];
  const table = new HandlerTable();
  registerProviders(table);
  const services = { catalog: { get: (id: string) => (catalogIds.includes(id) ? { efforts: ['low', 'high'] } : undefined) } } as unknown as RuntimeServices;
  const extras = { policies: { set: (scope: unknown, policy: unknown) => { set.push([scope, policy]); } } } as unknown as RpcExtras;
  const call = async (method: string, params: unknown): Promise<any> => {
    const entry = table.get(method)!;
    const scope = { kind: 'owner' } as const;
    assert.ok(allowedScope(entry.scope, scope));
    const ctx: HandlerContext = { scope, services, extras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) };
    return entry.handler(params as never, ctx);
  };
  return { call, set };
}

test('claude models: the 1M variant has a bracket-free catalog id the RPC accepts and runs as --model <id>[1m]', async () => {
  const h = claudeSetup({ init: INIT, turn: (_call, session) => [{ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session,
    modelUsage: { 'claude-sonnet-5-5[1m]': { contextWindow: 1_000_000 }, 'claude-haiku-5-5': { contextWindow: 200_000 } } }] });
  const models = await h.engine.listModels(claudeAccount());
  assert.deepEqual(models.map((m) => m.model), LISTED);
  assert.equal(models[2].name, 'Claude Sonnet 5.5 (1M context)');

  const ids = models.map((m) => `claude:${m.model}`);
  const { call, set } = rpc(ids);
  for (const id of ids) {
    await call('models.setPolicy', { agentId: 'ag_01jab3k9z7mx2c4q', policy: { pin: id, prefer: [id], avoid: [id] } });
    assert.deepEqual(await call('efforts.forModel', { modelId: id }), ['low', 'high'], id);
  }
  assert.deepEqual(set.at(2), [{ agentId: 'ag_01jab3k9z7mx2c4q' }, { pin: 'claude:claude-sonnet-5-5-1m', prefer: ['claude:claude-sonnet-5-5-1m'], avoid: ['claude:claude-sonnet-5-5-1m'] }]);

  const turn = await h.engine.run(turnInput({ model: 'claude-sonnet-5-5-1m', account: claudeAccount() }).input);
  assert.equal(turn.stop, 'done');
  assert.equal(flag(h.cli.of('turn')[0].args, '--model'), 'claude-sonnet-5-5[1m]', 'Claude Code gets its own 1M suffix');
  assert.equal(turn.contextWindow, 1_000_000, 'the window modelUsage reported under the [1m] name');
  assert.equal(cliModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(cliModel('claude-opus-5-5-20261001-1m'), 'claude-opus-5-5-20261001[1m]');
  assert.equal(cliModel('claude-sonnet-5-5[1m]'), 'claude-sonnet-5-5[1m]', 'an id in Claude Code form passes through');
});

test('claude models: a probe that does not answer keeps the last good list and is retried after a minute', async () => {
  const script: ClaudeScript = { init: INIT };
  const h = claudeSetup(script);
  const acc = claudeAccount();
  assert.deepEqual((await h.engine.listModels(acc)).map((m) => m.model), LISTED);

  script.init = 'crash';
  h.clock.now += 5 * 60_000;
  assert.deepEqual((await h.engine.listModels(acc)).map((m) => m.model), LISTED, 'CLI-only models (1M, legacy) stay; no static Fable');
  const check = await h.engine.checkAccount(acc);
  assert.equal(check.state, 'ok');
  assert.equal(h.cli.of('probe').length, 2);
  h.clock.now += 30_000;
  await h.engine.listModels(acc);
  assert.equal(h.cli.of('probe').length, 2, 'a failed probe is cached briefly');
  h.clock.now += 30_000;
  script.init = INIT;
  await h.engine.listModels(acc);
  assert.equal(h.cli.of('probe').length, 3, 'retried after one minute');
  h.clock.now += 59_999;
  await h.engine.listModels(acc);
  assert.equal(h.cli.of('probe').length, 3, 'an answered probe is cached for one minute');
  h.clock.now += 1;
  await h.engine.listModels(acc);
  assert.equal(h.cli.of('probe').length, 4, 'successful readings expire after one minute too');
});

test('claude models: no answer and no list yet throws (the catalog keeps its listing); signing out drops the last list', async () => {
  const script: ClaudeScript = { init: 'crash' };
  const h = claudeSetup(script);
  const acc = claudeAccount();
  await assert.rejects(h.engine.listModels(acc), /did not answer the model list/);

  script.init = INIT;
  h.clock.now += 60_000;
  assert.deepEqual((await h.engine.listModels(acc)).map((m) => m.model), LISTED);
  script.status = { code: 1, json: { loggedIn: false } };
  assert.equal((await h.engine.checkAccount(acc)).state, 'needs_login');
  script.status = undefined;
  script.init = 'crash';
  await assert.rejects(h.engine.listModels(acc), /did not answer/, 'a new login is not served the previous login\'s list');
});
