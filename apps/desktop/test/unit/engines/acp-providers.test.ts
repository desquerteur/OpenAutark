// PR8 acceptance: Gemini CLI and Copilot CLI as plan accounts on the ACP engine – the launch table
// (ACP flag from the CLI's own --help, the sign-in method), adoption of a CLI signed in on this PC
// (every CLI process in the empty engine folder, provider keys stripped, Gemini CLI left only its
// Google sign-in), the sign-ins (Gemini CLI through ACP authenticate, Copilot CLI's /login in a
// terminal window that starts in a new folder of its own), the Settings "On this PC" row, and
// routing: without a launch confirmed to ignore workspace settings the account gets no turns; with
// one, routing picks it and the turn runs through a scripted ACP agent (fakes.ts).
// Owns: nothing in production. Never starts a real CLI or terminal, signs in anywhere or uses the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ACP_PROVIDERS, AcpLaunches, GOOGLE_SIGN_IN_ONLY, acpArgs, signInMethod } from '../../../src/runtime/engines/acp/providers.ts';
import { AcpEngine } from '../../../src/runtime/engines/acp/engine.ts';
import { createEngineRegistry, type EngineRegistry } from '../../../src/runtime/engines/registry.ts';
import { AccountServiceImpl } from '../../../src/runtime/accounts/service.ts';
import { engineCwd } from '../../../src/runtime/system/paths.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { SpawnFn } from '../../../src/runtime/system/supervisor.ts';
import type { Account, EngineId, ProviderId } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { NO_MODEL_MESSAGE } from '../../../src/runtime/routing/router.ts';
import { cliRowView, needsSignIn, PROVIDER_NAMES, providerGroup, SIGN_OUT, signInHint } from '../../../src/ui/settings/providers.ts';
import { account as routedAccount, agent, mode, setup as routing } from '../models/harness.ts';
import { acpAgent, fakeFinder, fakeSpawn, testSupervisor, tick, turnInput } from './fakes.ts';

const DATA = path.resolve('fake-data');
const PATHS = { accounts: path.join(DATA, 'accounts'), data: DATA, temp: path.join(DATA, 'tmp') };
const NEUTRAL = engineCwd(PATHS);
const WORKSPACE = path.resolve('fake-home', 'Workforce');
const KEY = 'gm-key-test-0123456789';
const HELP: Record<string, string> = {
  '/bin/gemini': 'Usage: gemini [options]\n  --experimental-acp  Starts the agent in ACP mode [boolean]\n',
  '/bin/copilot': 'Usage: copilot [options]\n  --acp  Start as an Agent Client Protocol server\n',
};
const GEMINI_METHODS = [{ id: 'gemini-api-key', name: 'Use Gemini API key' }, { id: 'oauth-personal', name: 'Log in with Google' }, { id: 'vertex-ai', name: 'Vertex AI' }];
const MODELS = { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash',
  options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] }] };

/** What an agent answers session/new with before its sign-in: ACP's auth error (else another error). */
type SignedOut = [code: number, message: string];
const AUTH_REQUIRED: SignedOut = [-32000, 'Authentication required'];

/** One scripted ACP agent per CLI: session/new needs a sign-in until `signedIn`; authenticate signs in. */
function agentFor(signedIn: () => boolean, signIn: () => void, init: Record<string, unknown> = {}, signedOut = AUTH_REQUIRED) {
  return acpAgent({
    init, session: MODELS,
    handle: (msg, reply) => {
      if (msg.method === 'session/new' && !signedIn()) { reply.error(...signedOut); return true; }
      if (msg.method === 'authenticate') { signIn(); reply.result({}); return true; }
      return false;
    },
  });
}

/** Installed Gemini CLI and Copilot CLI: --help and --version answer, ACP launches run the scripted agents, anything else (the sign-in window) stays open. */
function clis(signedIn: { gemini: boolean; copilot: boolean }, copilotSignedOut?: SignedOut) {
  const gemini = agentFor(() => signedIn.gemini, () => { signedIn.gemini = true; }, { authMethods: GEMINI_METHODS });
  const copilot = agentFor(() => signedIn.copilot, () => {}, {}, copilotSignedOut);
  const other = fakeSpawn((call) => {
    const out = call.args.includes('--help') ? HELP[call.command] : call.args.includes('--version') ? '0.9.0\n' : undefined;
    if (out !== undefined) setImmediate(() => { call.child.stdout.write(out); setImmediate(() => call.child.exit(0)); });
  });
  const spawn: SpawnFn = (command, args, options) => (args.includes('--experimental-acp') || args.includes('--acp')
    ? (command === '/bin/gemini' ? gemini : copilot).spawn(command, args, options) : other.spawn(command, args, options));
  return { spawn, gemini, copilot, other, all: () => [...gemini.calls, ...copilot.calls, ...other.calls] };
}

function service(signedIn: { gemini: boolean; copilot: boolean }, copilotSignedOut?: SignedOut) {
  const db = new Db(':memory:');
  migrate(db);
  const scripted = clis(signedIn, copilotSignedOut);
  const supervisor = testSupervisor(scripted.spawn);
  const finder = fakeFinder({ gemini: '/bin/gemini', copilot: '/bin/copilot' });
  const env = { PATH: '/usr/bin', GEMINI_API_KEY: KEY, GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'my-project', SystemRoot: 'C:\\Windows' };
  const folders: string[] = []; // folders the service made (nothing touches the disk)
  let registry: EngineRegistry | undefined;
  const accounts = new AccountServiceImpl({
    db, bus: new Bus((error) => { throw error; }), clock: new ManualClock(), paths: PATHS, env, finder, supervisor, version: '1.0.0',
    engines: () => registry!, terminal: { platform: 'win32' }, rmdir: async () => { throw new Error('no home may be deleted'); },
    mkdir: async (dir) => { folders.push(dir); },
    secrets: { save: async () => ({ id: 'none' }), read: async () => undefined, remove: () => {} },
    detectDeps: { fetch: async () => { throw new Error('offline'); }, probeTimeoutMs: 1 },
  });
  // As the composition root wires it (compose/services.ts, test/unit/compose/services-wiring.test.ts): the engine starts what the account service resolves.
  registry = createEngineRegistry({ supervisor, finder, paths: PATHS, version: '1.0.0', apiKey: async () => undefined, acp: accounts.acpLaunch });
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); await accounts.monitor.idle(); };
  return { accounts, registry, supervisor, scripted, settle, folders };
}

test('acp providers: the ACP flag comes from the CLI\'s --help; the sign-in is the Google method, never a key or Vertex AI', () => {
  const gemini = ACP_PROVIDERS['gemini-cli'];
  assert.deepEqual(acpArgs(gemini, HELP['/bin/gemini']), ['--experimental-acp'], '--acp never matches inside --experimental-acp');
  assert.deepEqual(acpArgs(gemini, 'Options:\n  --acp  Start in ACP mode\n  --experimental-acp  (deprecated)\n'), ['--acp'], 'the newer flag first');
  assert.deepEqual(acpArgs(gemini, ''), ['--experimental-acp'], 'no help output: the known form');
  assert.deepEqual(acpArgs(ACP_PROVIDERS.copilot, HELP['/bin/copilot']), ['--acp']);
  assert.equal(signInMethod(gemini, GEMINI_METHODS)?.id, 'oauth-personal');
  assert.equal(signInMethod(gemini, [GEMINI_METHODS[0], GEMINI_METHODS[2]]), undefined);
  assert.equal(signInMethod(ACP_PROVIDERS.copilot, GEMINI_METHODS), undefined, 'Copilot CLI signs in in its own window');
});

test('acp providers: a Gemini CLI signed in on this PC is adopted; every CLI starts in the engine folder without provider keys', async () => {
  const h = service({ gemini: true, copilot: false });
  const report = await h.accounts.detect();
  await h.settle();
  assert.deepEqual(report.clis.filter((cli) => cli.provider === 'gemini-cli' || cli.provider === 'copilot'), [
    { provider: 'gemini-cli', path: '/bin/gemini', version: '0.9.0', loggedIn: true },
    { provider: 'copilot', path: '/bin/copilot', version: '0.9.0', loggedIn: false },
  ]);
  const adopted = h.accounts.list();
  assert.deepEqual(adopted.map((a) => [a.provider, a.label, a.auth, a.home, a.detected, a.state]), [['gemini-cli', 'Gemini CLI', 'cli', undefined, true, 'ok']]);
  assert.deepEqual(h.scripted.gemini.calls.map((call) => call.args), [['--experimental-acp']], 'the sign-in probe');
  assert.deepEqual(h.scripted.copilot.calls.map((call) => call.args), [['--acp']]);
  assert.equal(h.supervisor.leases().length, 0, 'probe processes end with the scan');

  // The engine's account check starts what the service resolves – --help is not read again.
  const checked = await h.accounts.check(adopted[0].id);
  assert.equal(checked.state, 'ok');
  assert.equal(h.scripted.other.calls.filter((call) => call.args.includes('--help')).length, 2, 'once per CLI');
  for (const call of h.scripted.all()) {
    assert.equal(call.options.cwd, NEUTRAL, `${call.command} ${call.args.join(' ')}: never the process cwd or the workspace`);
    assert.ok(!call.options.env?.GEMINI_API_KEY, 'provider keys are stripped');
  }
  // Gemini CLI keeps only its Google sign-in: keys and the Vertex AI selection are set empty, so its own .env files cannot fill them.
  assert.equal(h.scripted.gemini.calls.length, 2, 'the scan\'s probe and the engine\'s check');
  for (const call of h.scripted.gemini.calls) {
    for (const name of Object.keys(GOOGLE_SIGN_IN_ONLY)) assert.equal(call.options.env?.[name], '', `${name} is set empty`);
  }
  const probe = h.scripted.gemini.calls[0].options.env; // the scan runs with the service's environment
  assert.deepEqual([probe?.GOOGLE_CLOUD_PROJECT, h.scripted.copilot.calls[0].options.env?.GOOGLE_GENAI_USE_VERTEXAI], ['my-project', 'true'],
    'a Code Assist licence keeps its project; only Gemini CLI launches change the Vertex AI selection');
  assert.ok(h.accounts.candidates('acp').some((account) => account.provider === 'gemini-cli'), 'routing reaches the adopted plan');
  await h.accounts.dispose();
  await h.registry.dispose();
});

test('acp providers: Gemini CLI signs in through ACP authenticate, Copilot CLI with /login in a terminal window; no sign-out', async () => {
  const signedIn = { gemini: false, copilot: false };
  const h = service(signedIn);
  const gemini = await h.accounts.add({ provider: 'gemini-cli' });
  assert.equal(gemini.state, 'needs_login', 'checked first; its sign-in started');
  await h.settle();
  const auth = h.scripted.gemini.state.requests.filter((r: any) => r.method === 'authenticate');
  assert.deepEqual(auth.map((r: any) => r.params.methodId), ['oauth-personal']);
  assert.equal(h.accounts.get(gemini.id)?.state, 'ok', 'checked again when the sign-in ended');
  assert.equal((await h.accounts.add({ provider: 'gemini-cli' })).id, gemini.id, 'one Gemini CLI account per PC');

  const copilot = await h.accounts.add({ provider: 'copilot' });
  assert.equal(copilot.state, 'needs_login');
  const windows = () => h.scripted.other.calls.filter((call) => /powershell\.exe$/i.test(call.command));
  const [window] = windows();
  assert.ok(window, 'a visible terminal window');
  assert.deepEqual([window.options.env?.WORKFORCE_TERMINAL_EXE, window.options.env?.WORKFORCE_TERMINAL_ARGS], ['/bin/copilot', '[]']);
  // Copilot CLI is itself an agent (commands, files, folder trust): its window gets a new empty folder below temp, never the engine folder.
  assert.equal(path.dirname(window.options.cwd!), path.join(PATHS.temp, 'agent-sign-in'));
  assert.deepEqual(h.folders, [window.options.cwd]);
  window.child.exit(0); // closed without signing in
  await h.settle();
  assert.equal(h.accounts.get(copilot.id)?.state, 'needs_login');
  await h.accounts.login(copilot.id);
  const again = windows()[1];
  assert.ok(again && again.options.cwd !== window.options.cwd && again.options.cwd !== NEUTRAL, 'every sign-in window gets a folder of its own');
  signedIn.copilot = true; // the person typed /login there and closed the window
  again.child.exit(0);
  await h.settle();
  assert.equal(h.accounts.get(copilot.id)?.state, 'ok');

  await assert.rejects(h.accounts.logout(copilot.id), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  await h.accounts.remove(gemini.id); // its default home is never deleted (rmdir throws)
  assert.equal((await h.accounts.detect(true)).clis.find((cli) => cli.provider === 'gemini-cli')?.dismissed, true, 'detection does not add it back');
  await h.accounts.dispose();
  await h.registry.dispose();
});

test('acp providers: a Copilot CLI that answers a missing sign-in with another error still gets its window from Add', async () => {
  const h = service({ gemini: false, copilot: false }, [-32603, 'Internal error']);
  const report = await h.accounts.detect();
  await h.settle();
  const found = report.clis.find((cli) => cli.provider === 'copilot')!;
  assert.equal(found.loggedIn, undefined, 'the scan cannot tell');
  assert.equal(cliRowView(found, h.accounts.list())?.action, 'add', 'Settings offers Add');
  const copilot = await h.accounts.add({ provider: 'copilot' });
  assert.equal(copilot.state, 'error');
  const windows = h.scripted.other.calls.filter((call) => /powershell\.exe$/i.test(call.command));
  assert.equal(windows.length, 1, 'its own window opened: the person types /login there');
  assert.ok(needsSignIn(copilot), 'the account row keeps offering Sign in');
  await h.accounts.dispose();
  await h.registry.dispose();
});

test('acp providers: the "On this PC" row and the plan group in Settings', () => {
  const found = { provider: 'gemini-cli' as const, path: '/bin/gemini', version: '0.9.0', loggedIn: true };
  const own: Account = { id: 'acc_g', provider: 'gemini-cli', label: 'Gemini CLI', auth: 'cli', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1 };
  assert.deepEqual(cliRowView(found, [own]), { name: 'Gemini CLI', hint: 'Signed in · 0.9.0', action: undefined, account: own });
  assert.equal(cliRowView(found, [{ ...own, state: 'needs_login' }])?.action, 'sign-in', 'the account\'s live state wins over the scan');
  assert.equal(cliRowView({ ...found, dismissed: true }, [])?.action, 'add-again');
  assert.deepEqual(cliRowView({ provider: 'copilot', path: '/bin/copilot', loggedIn: false }, []), { name: 'Copilot CLI', hint: 'Not signed in', action: 'sign-in', account: undefined });
  // The scan could not tell the sign-in (a slow first start, an unexpected answer): 'add' checks it and signs in when needed – the only way in.
  assert.deepEqual(cliRowView({ provider: 'copilot', path: '/bin/copilot' }, []), { name: 'Copilot CLI', hint: 'Installed', action: 'add', account: undefined });
  assert.equal(cliRowView({ ...found, loggedIn: undefined, dismissed: true }, [])?.action, 'add', 'also after it was removed');
  assert.equal(cliRowView({ ...found, loggedIn: undefined }, [{ ...own, state: 'error' }])?.action, undefined, 'its account is listed with its own state');
  // A plan with its own homes adds through Add account, never 'add'; its status command did not answer (runtime gaps 23.10.): it says so and offers a new scan.
  assert.deepEqual(cliRowView({ provider: 'codex', path: '/bin/codex' }, []), { name: 'Codex', hint: 'Installed · sign-in unknown', action: 'check', account: undefined });
  assert.equal(cliRowView({ provider: 'claude', path: '/bin/claude', version: '2.1.303', loggedIn: true }, [])?.action, undefined, 'a known login: nothing to check');
  assert.deepEqual(cliRowView({ provider: 'gemini-cli' }, []), { name: 'Gemini CLI', hint: 'Not installed', action: undefined, account: undefined }, 'not installed: its fixed row, no Install (Workforce cannot install it)');
  assert.deepEqual(cliRowView({ provider: 'codex' }, []), { name: 'Codex', hint: 'Not installed', action: 'install', account: undefined });
  assert.deepEqual([providerGroup('gemini-cli'), providerGroup('copilot'), PROVIDER_NAMES.copilot], ['plans', 'plans', 'Copilot CLI']);
  assert.deepEqual([SIGN_OUT.has('gemini-cli'), SIGN_OUT.has('copilot'), SIGN_OUT.has('codex')], [false, false, true]);
  assert.match(signInHint('copilot'), /type \/login/);
  const copilot: Account = { ...own, id: 'acc_c', provider: 'copilot', label: 'Copilot CLI' };
  assert.deepEqual([needsSignIn({ ...copilot, state: 'needs_login' }), needsSignIn({ ...copilot, state: 'error' }), needsSignIn(copilot)], [true, true, false]);
  assert.equal(needsSignIn({ ...own, state: 'error' }), false, 'Gemini CLI says when it needs a sign-in');
  assert.equal(needsSignIn({ ...own, provider: 'openai', auth: 'api_key', state: 'needs_login' }), false, 'a key has no sign-in');
});

test('acp providers: routing reaches a Gemini CLI plan; its turn runs through the ACP agent', async () => {
  const shipped = Priors.load(path.resolve('resources', 'model-priors.json'));
  const h = routing({ priors: shipped });
  const agentProcess = agentFor(() => true, () => {});
  const help = fakeSpawn((call) => setImmediate(() => { call.child.stdout.write(HELP['/bin/gemini']); setImmediate(() => call.child.exit(0)); }));
  const spawn: SpawnFn = (command, args, options) => (args.includes('--help') ? help.spawn : agentProcess.spawn)(command, args, options);
  const supervisor = testSupervisor(spawn);
  const launches = new AcpLaunches({ finder: fakeFinder({ gemini: '/bin/gemini' }), supervisor, cwd: NEUTRAL, env: {} });
  const engine = new AcpEngine({ supervisor, cwd: NEUTRAL, version: '1.0.0', launch: (a) => launches.resolve(a) });
  (h.services as any).engines = { get: (id: EngineId) => { if (id !== 'acp') throw new Error(`engine ${id} missing`); return engine; }, all: () => [engine], disposeIdle: async () => {} };
  const gemini = routedAccount('acc_gemini', 'gemini-cli', { auth: 'cli' });
  h.accounts.upsert(gemini, false);
  await h.catalog.refresh({ force: true });
  const argon = h.catalog.get('gemini-cli:gemini-4-argon');
  assert.deepEqual([argon?.engine, argon?.tier, argon?.accounts, argon?.available], ['acp', 'frontier', ['acc_gemini'], true], 'listed by the agent, Gemini priors applied');
  try {
    const decision = await h.router.route({ agent: agent('ag_1'), mode: mode('research'), text: 'Compare the three vendor reports.' });
    assert.deepEqual([decision.engine, decision.accountId, decision.modelId], ['acp', 'acc_gemini', 'gemini-cli:gemini-4-argon']);
    const { input } = turnInput({ account: gemini, model: h.catalog.get(decision.modelId)!.model, effort: decision.effort, cwd: WORKSPACE });
    const result = await engine.run(input);
    assert.equal(result.stop, 'done');
    assert.match(result.text, /^Echo: hello/);
    const sent = (method: string) => agentProcess.state.requests.filter((r: any) => r.method === method);
    assert.deepEqual(sent('session/new').map((r: any) => r.params.cwd), [NEUTRAL, WORKSPACE], 'the listing probe stays neutral; only the turn opens a session in the workspace');
    assert.deepEqual(sent('session/set_config_option').map((r: any) => r.params.value), ['gemini-4-argon'], 'the routed model is applied');
  } finally {
    await engine.dispose();
  }
});
