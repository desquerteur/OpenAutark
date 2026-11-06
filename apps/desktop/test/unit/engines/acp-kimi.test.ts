// B-044 Kimi Code as the third ACP plan (engines/acp/providers.ts, kimi.com/code/docs: `kimi acp`,
// `kimi login`, KIMI_CODE_HOME): the table row, the launch with the account's own home, the
// detection probe in the default home (adopted like any CLI login), an added account's own home and
// `kimi login` in a terminal window and the account check in that home.
// Owns: nothing in production. Never starts a real CLI or terminal, signs in anywhere or uses the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ACP_PROVIDERS, AcpLaunches, acpArgs, acpHomeEnv } from '../../../src/runtime/engines/acp/providers.ts';
import { createEngineRegistry, type EngineRegistry } from '../../../src/runtime/engines/registry.ts';
import { AccountServiceImpl } from '../../../src/runtime/accounts/service.ts';
import { engineCwd } from '../../../src/runtime/system/paths.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { SpawnFn } from '../../../src/runtime/system/supervisor.ts';
import { isAcpPlan } from '../../../src/shared/model/providers.ts';
import { cliRowView, needsSignIn, PC_CLIS, PROVIDER_NAMES, providerGroup, SIGN_IN, SIGN_OUT } from '../../../src/ui/settings/providers.ts';
import { account, acpAgent, fakeFinder, fakeSpawn, testSupervisor, tick } from './fakes.ts';

const DATA = path.resolve('fake-data');
const PATHS = { accounts: path.join(DATA, 'accounts'), data: DATA, temp: path.join(DATA, 'tmp') };
const NEUTRAL = engineCwd(PATHS);
const KIMI = ACP_PROVIDERS['kimi-cli'];

test('kimi: the table row – `kimi acp` (a subcommand), `kimi login` in a terminal, KIMI_CODE_HOME per account', () => {
  assert.deepEqual([KIMI.cli, KIMI.name, KIMI.flags, KIMI.fallback, KIMI.signIn, KIMI.home], ['kimi', 'Kimi Code', ['acp'], 'acp', 'terminal', 'KIMI_CODE_HOME']);
  assert.deepEqual(acpArgs(KIMI, 'Commands:\n  login  Log in\n  acp    Run ACP mode over JSON-RPC on stdin/stdout\n'), ['acp']);
  assert.deepEqual(acpArgs(KIMI, ''), ['acp'], 'no help output: the documented subcommand');
  assert.deepEqual(acpHomeEnv({ provider: 'kimi-cli', home: '/data/accounts/kimi-cli/acc_1' }), { KIMI_CODE_HOME: '/data/accounts/kimi-cli/acc_1' });
  assert.deepEqual(acpHomeEnv({ provider: 'kimi-cli' }), {}, 'a login found in the default home (~/.kimi-code)');
  assert.deepEqual(acpHomeEnv({ provider: 'gemini-cli', home: '/somewhere' }), {}, 'Gemini CLI has no home variable');
});

test('kimi: the launch with the account home; Settings lists the plan', async () => {
  assert.equal(isAcpPlan('kimi-cli'), true);
  const help = fakeSpawn((call) => setImmediate(() => { call.child.stdout.write('  acp  Run ACP mode\n'); setImmediate(() => call.child.exit(0)); }));
  const launches = new AcpLaunches({ finder: fakeFinder({ kimi: '/bin/kimi' }), supervisor: testSupervisor(help.spawn), cwd: NEUTRAL, env: {} });
  const launch = await launches.resolve({ provider: 'kimi-cli', home: '/data/accounts/kimi-cli/acc_1' });
  assert.deepEqual([launch?.name, launch?.args, launch?.env], ['Kimi Code', ['acp'], { KIMI_CODE_HOME: '/data/accounts/kimi-cli/acc_1' }]);
  assert.deepEqual([PROVIDER_NAMES['kimi-cli'], providerGroup('kimi-cli'), SIGN_IN['kimi-cli'], SIGN_OUT.has('kimi-cli')], ['Kimi Code', 'plans', 'terminal', false]);
  assert.ok(PC_CLIS.includes('kimi-cli'), 'On this PC lists it');
  assert.deepEqual(cliRowView({ provider: 'kimi-cli' }, []), { name: 'Kimi Code', hint: 'Not installed', action: undefined, account: undefined });
  assert.equal(cliRowView({ provider: 'kimi-cli', path: '/bin/kimi', loggedIn: false }, []).action, 'sign-in');
  assert.equal(needsSignIn(account({ provider: 'kimi-cli', state: 'needs_login' })), true);
});

function service(signedIn: { default: boolean; own: boolean }) {
  const db = new Db(':memory:');
  migrate(db);
  let current: Record<string, string | undefined> | undefined; // the environment of the last `kimi acp` start
  const agent = acpAgent({ handle: (msg, reply) => {
    if (msg.method !== 'session/new') return false;
    const own = Boolean(current?.KIMI_CODE_HOME);
    if (own ? signedIn.own : signedIn.default) return false;
    reply.error(-32000, 'Authentication required'); // kimi acp: authRequired while the token is missing
    return true;
  } });
  const other = fakeSpawn((call) => {
    const out = call.args.includes('--help') ? '  acp  Run ACP mode\n' : call.args.includes('--version') ? 'kimi 1.2.0\n' : undefined;
    if (out !== undefined) setImmediate(() => { call.child.stdout.write(out); setImmediate(() => call.child.exit(0)); });
  });
  const spawn: SpawnFn = (command, args, options) => {
    if (args.at(-1) !== 'acp') return other.spawn(command, args, options);
    current = options.env as Record<string, string | undefined>;
    return agent.spawn(command, args, options);
  };
  const supervisor = testSupervisor(spawn);
  const finder = fakeFinder({ kimi: '/bin/kimi' });
  let registry: EngineRegistry | undefined;
  const folders: string[] = [];
  const accounts = new AccountServiceImpl({
    db, bus: new Bus((error) => { throw error; }), clock: new ManualClock(), paths: PATHS, env: { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' }, finder, supervisor,
    version: '1.0.0', engines: () => registry!, terminal: { platform: 'win32' }, mkdir: async (dir) => { folders.push(dir); },
    secrets: { save: async () => ({ id: 'none' }), read: async () => undefined, remove: () => {} },
    detectDeps: { fetch: async () => { throw new Error('offline'); }, probeTimeoutMs: 1 },
  });
  registry = createEngineRegistry({ supervisor, finder, paths: PATHS, version: '1.0.0', apiKey: async () => undefined, acp: accounts.acpLaunch });
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); await accounts.monitor.idle(); };
  return { accounts, agent, other, settle, folders, registry: () => registry! };
}

test('kimi: a login in the default home is found by the ACP probe and adopted; an added account gets its own home and `kimi login`', async () => {
  const h = service({ default: true, own: false });
  const report = await h.accounts.detect();
  await h.settle();
  assert.deepEqual(report.clis.find((cli) => cli.provider === 'kimi-cli'), { provider: 'kimi-cli', path: '/bin/kimi', version: '1.2.0', loggedIn: true });
  assert.equal(h.agent.calls[0].options.env?.KIMI_CODE_HOME, undefined, 'the probe asks the default home');
  const adopted = h.accounts.list();
  assert.deepEqual(adopted.map((a) => [a.provider, a.label, a.home, a.detected]), [['kimi-cli', 'Kimi Code', undefined, true]]);

  const added = await h.accounts.add({ provider: 'kimi-cli', label: 'Work' });
  const home = path.join(PATHS.accounts, 'kimi-cli', added.id);
  assert.deepEqual([added.home, added.auth, added.state, h.folders], [home, 'cli', 'needs_login', [home]]);
  const window = h.other.calls.find((call) => call.options.env?.WORKFORCE_TERMINAL_EXE === '/bin/kimi');
  assert.ok(window, 'the sign-in runs in a visible terminal window');
  assert.equal(window.options.env?.WORKFORCE_TERMINAL_ARGS, JSON.stringify(['login']));
  assert.equal(window.options.env?.KIMI_CODE_HOME, home);
  assert.equal(window.options.cwd, NEUTRAL);

  const checked = await h.accounts.check(added.id);
  assert.equal(checked.state, 'needs_login', 'its own home has no token yet');
  const own = h.agent.calls.find((call) => call.options.env?.KIMI_CODE_HOME === home);
  assert.ok(own, 'the account check starts `kimi acp` in its own home');
  assert.deepEqual([own.args, own.options.cwd], [['acp'], NEUTRAL]);
  await h.accounts.dispose();
  await h.registry().dispose();
});
