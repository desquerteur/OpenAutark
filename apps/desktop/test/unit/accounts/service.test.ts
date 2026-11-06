// AccountService (PR5) with the account harness: CLI accounts get their own home and the official
// sign-in there, sign-out and remove touch only that account (homes deleted only as exactly
// <accounts>/<provider>/<id>), a sign-in that cannot start never piles up accounts, typed keys go
// to the vault, and a key from the environment is used by its variable's name only – read
// in-process, never stored, logged or sent (also through the RPC handlers); paid like a typed key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { DismissedLogins } from '../../../src/runtime/accounts/dismissed.ts';
import { signedOut } from '../../../src/runtime/accounts/cli-homes.ts';
import { chargeOf } from '../../../src/runtime/models/pricing.ts';
import { costFactor, isPaid } from '../../../src/runtime/routing/score.ts';
import { HandlerTable, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { AddAccountInput } from '../../../src/runtime/accounts/service.ts';
import type { ExecutableFinder } from '../../../src/runtime/accounts/executables.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ACCOUNTS, ENV_KEY, harness, row } from './harness.ts';

const refusal = (pattern: RegExp) => (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && pattern.test(error.message);

test('a Codex account gets its own home and the official sign-in there; sign-out and remove touch only that account', async () => {
  const h = harness({ env: { OPENAI_API_KEY: ENV_KEY, PATH: '/usr/bin' } });
  const added = await h.service.add({ provider: 'codex', label: '  Work  ' });
  const home = path.join(ACCOUNTS, 'codex', added.id);
  assert.deepEqual([added.auth, added.state, added.label, added.home], ['cli', 'needs_login', 'Work', home]);
  assert.deepEqual(h.made, [home]);
  const [signIn] = h.signIns;
  assert.deepEqual(signIn.args, ['login']);
  assert.equal(signIn.options.env?.CODEX_HOME, home);
  assert.equal(signIn.options.env?.OPENAI_API_KEY, undefined, 'provider keys never reach the CLI');
  signIn.child.exit(0); // the browser sign-in finished: its check runs
  await h.settle();
  assert.deepEqual([h.service.get(added.id)?.state, h.service.get(added.id)?.plan], ['ok', 'pro']);

  await h.service.logout(added.id);
  const signOut = h.calls.find((call) => call.args.join(' ') === 'logout');
  assert.equal(signOut?.options.env?.CODEX_HOME, home);
  const out = h.service.get(added.id)!;
  assert.deepEqual([out.state, out.plan, out.limits], ['needs_login', undefined, undefined]);
  assert.equal(signedOut.has(h.db, added.id), true, 'signed out here: a login from a linked PC stays out (devices/sync/logins.ts)');

  await h.service.remove(added.id);
  assert.deepEqual(h.removed, [home]);
  assert.equal(h.service.get(added.id), undefined);
  assert.deepEqual(new DismissedLogins(h.db, () => 0).list(), [], 'an own-home account is never "dismissed" – detection does not find it');
});

test('remove deletes exactly <accounts>/<provider>/<its id> – never the default home, a provider folder or another account\'s home', async () => {
  const h = harness();
  const codex = path.join(ACCOUNTS, 'codex');
  h.repo.save(row('acc_default', { provider: 'codex', auth: 'cli' }));
  h.repo.save(row('acc_folder', { provider: 'codex', auth: 'cli', home: codex }));
  h.repo.save(row('acc_other', { provider: 'codex', auth: 'cli', home: path.join(codex, 'acc_victim') }));
  h.repo.save(row('acc_nested', { provider: 'codex', auth: 'cli', home: path.join(codex, 'acc_nested', 'deeper') }));
  h.repo.save(row('acc_cross', { provider: 'claude', auth: 'cli', home: path.join(codex, 'acc_cross') }));
  h.repo.save(row('acc_outside', { provider: 'codex', auth: 'cli', home: path.resolve('elsewhere', 'codex', 'acc_outside') }));
  h.repo.save(row('acc_own', { provider: 'codex', auth: 'cli', home: path.join(codex, 'acc_own') }));
  for (const account of h.service.list()) await h.service.remove(account.id);
  assert.deepEqual(h.removed, [path.join(codex, 'acc_own')]);
  assert.equal(h.service.list().length, 0);
});

test('a sign-in that cannot start keeps one account: adding again retries it instead of creating another home', async () => {
  // B-051 L3: a missing CLI is installed before the account exists; here the install check (a forced
  // lookup) still saw it, but it was gone when the sign-in started – the sign-in cannot start.
  const state = { missing: true };
  const finder = {
    find: async (id: string, options: { force?: boolean } = {}) => (id === 'claude' && state.missing && !options.force ? null : id === 'claude' || id === 'codex' ? { command: `/bin/${id}`, prefixArgs: [], path: `/bin/${id}` } : null),
    clear: () => {},
  } as unknown as ExecutableFinder;
  const h = harness({ finder });
  await assert.rejects(h.service.add({ provider: 'claude' }), /Claude Code is not installed/);
  await assert.rejects(h.service.add({ provider: 'claude' }), /Claude Code is not installed/);
  assert.equal(h.service.list().length, 1);
  assert.equal(h.made.length, 1);
  assert.equal(h.service.list()[0].state, 'needs_login', 'kept: Sign in can be retried from its row');

  state.missing = false; // there again
  const added = await h.service.add({ provider: 'claude', label: 'Personal' });
  assert.equal(h.service.list().length, 1);
  assert.deepEqual([added.label, h.made.length], ['Personal', 1]);
  assert.deepEqual(h.signIns.map((call) => call.args.join(' ')), ['auth login --claudeai']);
  assert.equal(h.signIns[0].options.env?.CLAUDE_CONFIG_DIR, added.home);
  // Its sign-in runs: the next add is a second account.
  const second = await h.service.add({ provider: 'claude' });
  assert.notEqual(second.id, added.id);
  assert.deepEqual([h.service.list().length, second.label], [2, 'Claude Code 2']);
});

test('a typed API key goes to the vault: the account keeps the secret id only; remove deletes the secret', async () => {
  const h = harness();
  const added = await h.service.add({ provider: 'openai', apiKey: '  sk-typed-abcdef123456  ' });
  assert.equal(added.auth, 'api_key');
  assert.equal(h.vault.get(added.secretId!), 'sk-typed-abcdef123456');
  assert.ok(!JSON.stringify(h.service.list()).includes('sk-typed'));
  assert.equal(await h.service.apiKey(added.id), 'sk-typed-abcdef123456');
  await h.settle();
  assert.equal(h.service.get(added.id)?.state, 'ok');
  await assert.rejects(h.service.add({ provider: 'anthropic' }), refusal(/Enter an API key/));
  await h.service.remove(added.id);
  assert.equal(h.vault.size, 0);
});

test('a key from the environment: the account names the variable; the key is read in-process only, never stored or sent', async () => {
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: ENV_KEY };
  const h = harness({ env });
  const added = await h.service.add({ provider: 'openai', envVar: 'OPENAI_API_KEY' });
  assert.deepEqual([added.auth, added.envVar, added.detected, added.secretId, added.baseUrl], ['env', 'OPENAI_API_KEY', true, undefined, undefined]);
  assert.equal(h.vault.size, 0, 'nothing reaches the vault');
  assert.equal(await h.service.apiKey(added.id), ENV_KEY);
  await h.settle();
  assert.equal(h.service.get(added.id)?.state, 'ok', 'the provider check read the key in-process');
  const stored = JSON.stringify(h.db.all('SELECT * FROM accounts'));
  assert.ok(stored.includes('OPENAI_API_KEY') && !stored.includes(ENV_KEY), 'the table holds the name, never the value');
  assert.ok(!JSON.stringify(h.upserts).includes(ENV_KEY), 'account events carry no key');
  assert.deepEqual([isPaid(added), costFactor(added, h.clock.now()), chargeOf(added)], [true, 1, 'paid'], 'billed per use like a typed key');
  assert.equal((await h.service.add({ provider: 'openai', envVar: 'OPENAI_API_KEY' })).id, added.id, 'one account per variable');

  // The variable is gone (the next start): no key, and the check says needs_login without asking the provider.
  delete env.OPENAI_API_KEY;
  const asked = h.checks.length;
  assert.equal(await h.service.apiKey(added.id), undefined);
  assert.equal((await h.service.check(added.id)).state, 'needs_login');
  assert.equal(h.checks.length, asked);
  h.repo.save({ ...h.service.get(added.id)!, state: 'ok' });
  await h.service.detect(true);
  assert.equal(h.service.get(added.id)?.state, 'needs_login', 'detection notices the missing variable');
  // Set again: detection checks it once more.
  env.OPENAI_API_KEY = ENV_KEY;
  await h.service.detect(true);
  await h.settle();
  assert.equal(h.service.get(added.id)?.state, 'ok');
});

test('only a key variable of the one table keys its own provider, at the provider\'s default endpoint', async () => {
  const h = harness({ env: { OPENAI_API_KEY: ENV_KEY, OLLAMA_API_KEY: 'ollama-key', PATH: '/usr/bin', GEMINI_API_KEY: '   ' } });
  const refused: Array<[AddAccountInput, RegExp]> = [
    [{ provider: 'anthropic', envVar: 'OPENAI_API_KEY' }, /no key for this provider/],
    [{ provider: 'openai', envVar: 'PATH' }, /no key for this provider/],
    [{ provider: 'codex', envVar: 'OPENAI_API_KEY' }, /no key for this provider/],
    [{ provider: 'ollama', envVar: 'OLLAMA_API_KEY' }, /needs no key/],
    [{ provider: 'google', envVar: 'GEMINI_API_KEY' }, /GEMINI_API_KEY is not set/],
    [{ provider: 'xai', envVar: 'XAI_API_KEY' }, /XAI_API_KEY is not set/],
    [{ provider: 'openai', envVar: 'OPENAI_API_KEY', baseUrl: 'https://proxy.example.test/v1' }, /either/],
    [{ provider: 'openai', envVar: 'OPENAI_API_KEY', apiKey: 'sk-other' }, /either/],
  ];
  for (const [input, pattern] of refused) await assert.rejects(h.service.add(input), refusal(pattern), JSON.stringify(input));
  assert.equal(h.service.list().length, 0);
  // Rows another path could write (a crafted restore): another variable, another provider's variable or a foreign server get no key.
  h.repo.save(row('acc_path', { auth: 'env', envVar: 'PATH' }));
  h.repo.save(row('acc_cross', { provider: 'anthropic', auth: 'env', envVar: 'OPENAI_API_KEY' }));
  h.repo.save(row('acc_proxy', { auth: 'env', envVar: 'OPENAI_API_KEY', baseUrl: 'https://proxy.example.test/v1' }));
  h.repo.save(row('acc_proto', { auth: 'env', envVar: 'constructor' }));
  h.repo.save(row('acc_ollama', { provider: 'ollama', auth: 'env', envVar: 'OLLAMA_API_KEY' }));
  for (const id of ['acc_path', 'acc_cross', 'acc_proxy', 'acc_proto', 'acc_ollama']) assert.equal(await h.service.apiKey(id), undefined, id);
  h.repo.save(row('acc_ok', { auth: 'env', envVar: 'OPENAI_API_KEY' }));
  assert.equal(await h.service.apiKey('acc_ok'), ENV_KEY);
});

test('RPC: accounts.add {envVar} answers with the name only; list and detect never echo the key; other names are refused', async () => {
  const h = harness({ env: { OPENAI_API_KEY: ENV_KEY } });
  const table = new HandlerTable();
  registerProviders(table);
  const scope: ClientScope = { kind: 'owner' };
  const ctx = { scope, services: { accounts: h.service } as unknown as RuntimeServices, extras: {} as RpcExtras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) } as HandlerContext;
  const call = async (method: string, params?: unknown): Promise<any> => table.get(method)!.handler(params as never, ctx);

  const added = await call('accounts.add', { provider: 'openai', envVar: 'OPENAI_API_KEY' });
  const report = await call('accounts.detect', { force: true });
  const wire = JSON.stringify([added, await call('accounts.list'), report]);
  assert.ok(!wire.includes(ENV_KEY), 'no RPC answer carries the key');
  assert.ok(wire.includes('"envVar":"OPENAI_API_KEY"'));
  assert.deepEqual(report.envKeys, ['OPENAI_API_KEY']);
  await assert.rejects(call('accounts.add', { provider: 'openai', envVar: 'PATH' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  await assert.rejects(call('accounts.add', { provider: 'openai', envVar: 'OPENAI_API_KEY', value: ENV_KEY }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');

});
