// B-049 F3: ACP plan CLIs launch as lean as their docs allow – each lean flag only when the CLI's own --help lists
// it (Gemini CLI: only our hub among MCP servers; Copilot CLI: no custom instructions, no built-in MCP server, no
// ask_user, no built-ins outside the core; Kimi Code: nothing, `kimi acp` documents no option), and Gemini CLI's
// built-in system prompt replaced by ACP_SYSTEM_PROMPT (GEMINI_SYSTEM_MD) once the app gives a prompt folder.
// The account service hands its prompt folder on, and the composition root wires <data>/engine-prompts (B-049 finish).
// Owns: nothing in production. Never starts a real CLI; only the wiring test writes, into an OS temp folder it removes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ACP_PROVIDERS, ACP_SYSTEM_PROMPT, AcpLaunches, COPILOT_EXCLUDED_TOOLS, GOOGLE_SIGN_IN_ONLY, acpArgs } from '../../../src/runtime/engines/acp/providers.ts';
import { HUB } from '../../../src/runtime/engines/acp/updates.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor } from './fakes.ts';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { AccountServiceImpl } from '../../../src/runtime/accounts/service.ts';
import { enginePromptDir } from '../../../src/runtime/system/paths.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';

const GEMINI = ACP_PROVIDERS['gemini-cli'];
const COPILOT = ACP_PROVIDERS.copilot;
const KIMI = ACP_PROVIDERS['kimi-cli'];
const GEMINI_HELP = 'Options:\n  --experimental-acp  Starts the agent in ACP mode [boolean]\n  --allowed-mcp-server-names  Allowed MCP server names [array]\n';
const COPILOT_HELP = 'Options:\n  --acp  Start as Agent Client Protocol server\n  --no-custom-instructions  Disable loading of custom instructions\n'
  + '  --disable-builtin-mcps  Disable all built-in MCP servers\n  --no-ask-user  Disable the ask_user tool\n  --excluded-tools=TOOL ...  These tools will not be available\n';
const PROMPTS = path.resolve('fake-data', 'engine-prompts');

test('acp lean: Gemini CLI keeps only our hub among MCP servers when its --help lists the flag; an older one starts as before', () => {
  assert.equal(HUB, 'workforce');
  assert.deepEqual(acpArgs(GEMINI, GEMINI_HELP), ['--experimental-acp', '--allowed-mcp-server-names', 'workforce']);
  assert.deepEqual(acpArgs(GEMINI, 'Options:\n  --experimental-acp  ACP mode\n'), ['--experimental-acp'], 'not listed: not passed');
  assert.deepEqual(acpArgs(GEMINI, ''), ['--experimental-acp'], 'no help output: the known form only');
  assert.deepEqual(acpArgs(GEMINI, 'Options:\n  --allowed-mcp-server-names-x  other\n'), ['--experimental-acp'], 'a longer flag never matches');
});

test('acp lean: Copilot CLI drops its custom instructions, built-in MCP server, ask_user and the built-ins outside the core – each only when listed', () => {
  assert.deepEqual(acpArgs(COPILOT, COPILOT_HELP), ['--acp', '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user',
    '--excluded-tools=web_fetch,task,list_agents,read_agent,write_agent,skill']);
  assert.deepEqual(acpArgs(COPILOT, 'Options:\n  --acp  ACP\n  --no-custom-instructions  Disable custom instructions\n'), ['--acp', '--no-custom-instructions']);
  assert.deepEqual(acpArgs(COPILOT, 'Options:\n  --acp  ACP\n'), ['--acp']);
  for (const core of ['bash', 'powershell', 'view', 'create', 'edit', 'apply_patch', 'glob', 'grep', 'rg']) {
    assert.equal(COPILOT_EXCLUDED_TOOLS.includes(core), false, `${core} stays (execution core)`);
  }
  assert.equal(COPILOT.systemPromptEnv, undefined, 'Copilot CLI documents no way to replace its system prompt');
});

test('acp lean: Kimi Code gets nothing beyond `acp` – the main command\'s --agent-file/--skills-dir never reach the subcommand', () => {
  const help = 'Options:\n  --agent-file <path>  Load a custom agent\n  --skills-dir <dir>  Load Skills from\nCommands:\n  acp  Run ACP mode\n';
  assert.deepEqual(acpArgs(KIMI, help), ['acp']);
  assert.equal(KIMI.lean, undefined);
  assert.equal(KIMI.systemPromptEnv, undefined);
});

test('acp lean: the replacement prompt points at the blocks the engine sends in a session\'s first prompt', () => {
  assert.match(ACP_SYSTEM_PROMPT, /<workforce-instructions>/);
  assert.match(ACP_SYSTEM_PROMPT, /<workforce-context>/);
  assert.ok(ACP_SYSTEM_PROMPT.length < 600, 'a few lines, not a second system prompt');
  assert.equal(GEMINI.systemPromptEnv, 'GEMINI_SYSTEM_MD');
});

function launches(options: { promptDir?: string; failWrites?: number } = {}) {
  const written: Array<[string, string]> = [];
  let fail = options.failWrites ?? 0;
  const help: Record<string, string> = { '/bin/gemini': GEMINI_HELP, '/bin/copilot': COPILOT_HELP };
  const cli = fakeSpawn((call) => {
    if (!call.args.includes('--help')) return;
    setImmediate(() => { call.child.stdout.write(help[call.command] ?? ''); setImmediate(() => call.child.exit(0)); });
  });
  const acp = new AcpLaunches({
    finder: fakeFinder({ gemini: '/bin/gemini', copilot: '/bin/copilot' }), supervisor: testSupervisor(cli.spawn), cwd: '/fake-data/engine-cwd', env: { PATH: '/bin' },
    promptDir: options.promptDir,
    writeFile: async (file, text) => { if (fail > 0) { fail--; throw new Error('disk full'); } written.push([file, text]); },
  });
  return { acp, written, cli };
}

test('acp lean: with a prompt folder Gemini CLI starts with GEMINI_SYSTEM_MD = our prompt file, written once; its sign-in variables stay', async () => {
  const h = launches({ promptDir: PROMPTS });
  const first = await h.acp.resolve({ provider: 'gemini-cli' });
  const again = await h.acp.resolve({ provider: 'gemini-cli' });
  const file = path.join(PROMPTS, 'gemini-cli-system.md');
  assert.equal(first?.env?.GEMINI_SYSTEM_MD, file);
  assert.equal(again?.env?.GEMINI_SYSTEM_MD, file);
  assert.deepEqual(h.written, [[file, `${ACP_SYSTEM_PROMPT}\n`]], 'one write per provider and process');
  for (const name of Object.keys(GOOGLE_SIGN_IN_ONLY)) assert.equal(first?.env?.[name], '', `${name} still set empty`);
  assert.deepEqual(first?.args, ['--experimental-acp', '--allowed-mcp-server-names', 'workforce']);
  const copilot = await h.acp.resolve({ provider: 'copilot' });
  assert.equal(copilot?.env, undefined, 'Copilot CLI: no prompt variable, no environment change');
  assert.equal(h.cli.calls.filter((call) => call.args.includes('--help')).length, 2, '--help once per CLI');
});

test('acp lean: without a prompt folder or after a failed write no CLI gets a prompt variable (never one naming a missing file)', async () => {
  const none = launches();
  const plain = await none.acp.resolve({ provider: 'gemini-cli' });
  assert.equal(plain?.env?.GEMINI_SYSTEM_MD, undefined);
  assert.deepEqual(none.written, []);

  const failing = launches({ promptDir: PROMPTS, failWrites: 1 });
  const first = await failing.acp.resolve({ provider: 'gemini-cli' });
  assert.equal(first?.env?.GEMINI_SYSTEM_MD, undefined, 'the write failed: Gemini CLI keeps its own prompt');
  const second = await failing.acp.resolve({ provider: 'gemini-cli' });
  assert.equal(second?.env?.GEMINI_SYSTEM_MD, path.join(PROMPTS, 'gemini-cli-system.md'), 'written on the next launch');
});

test('acp lean: the account service passes its prompt folder on – the composition root gives <data>/engine-prompts, so the real app replaces Gemini CLI\'s prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-engine-prompts-'));
  try {
    const help = fakeSpawn((call) => { if (call.args.includes('--help')) setImmediate(() => { call.child.stdout.write(GEMINI_HELP); setImmediate(() => call.child.exit(0)); }); });
    const make = (enginePrompts?: string) => {
      const db = new Db(':memory:');
      migrate(db);
      return new AccountServiceImpl({
        db, bus: new Bus((error) => { throw error; }), clock: new ManualClock(), paths: { accounts: path.join(dir, 'accounts') }, env: {},
        finder: fakeFinder({ gemini: '/bin/gemini' }), supervisor: testSupervisor(help.spawn), version: '1.0.0', engines: () => { throw new Error('no engines here'); },
        secrets: { save: async () => ({ id: 'none' }), read: async () => undefined, remove: () => {} }, mkdir: async () => {}, ...(enginePrompts ? { enginePrompts } : {}),
      });
    };
    const wired = await make(dir).acpLaunch(account({ id: 'acc_g', provider: 'gemini-cli' }));
    const file = path.join(dir, 'gemini-cli-system.md');
    assert.equal(wired?.env?.GEMINI_SYSTEM_MD, file);
    assert.equal(await readFile(file, 'utf8'), `${ACP_SYSTEM_PROMPT}\n`);
    const plain = await make().acpLaunch(account({ id: 'acc_g', provider: 'gemini-cli' }));
    assert.equal(plain?.env?.GEMINI_SYSTEM_MD, undefined, 'without the folder nothing is replaced');
    assert.equal(enginePromptDir({ data: path.resolve('data') }), path.join(path.resolve('data'), 'engine-prompts'));
    const services = readFileSync(new URL('../../../src/runtime/compose/services.ts', import.meta.url), 'utf8');
    assert.match(services.match(/new AccountServiceImpl\(\{([\s\S]*?)\n {2}\}\);/)?.[1] ?? '', /\benginePrompts: enginePromptDir\(paths\)/, 'wired at the composition root');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
