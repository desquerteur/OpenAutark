// Claude Code ignores project-level config in the workspace: every turn (new, resumed, with and
// without the MCP hub) and the status probe load only the account's user settings
// (`--setting-sources user`) and only our MCP config (`--strict-mcp-config`); a turn still runs in
// the workspace with the account home as CLAUDE_CONFIG_DIR; auth status and the probe run in temp;
// every process has Claude Code's own cron scheduler off (CLAUDE_CODE_DISABLE_CRON).
// Owns: nothing in production. Never starts a real binary (scripted CLI from claude-fixture.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NO_CLI_CRON, PROBE_ARGS, USER_SETTINGS_ONLY } from '../../../src/runtime/engines/claude/status.ts';
import { LEAN_SETTINGS } from '../../../src/runtime/engines/claude/lean.ts';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup, kindOf, TEMP } from './claude-fixture.ts';

const WORKSPACE = '/fake-home/Workforce';
const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), cwd: WORKSPACE, ...patch });

/** Flags that would load config from outside our own arguments – none may appear in a turn (bypassPermissions is ours). */
const WIDENING = ['--add-dir', '--plugin-dir', '--plugin-url', '--agents', '--agent', '--project-config-root',
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];

function assertUserSettingsOnly(args: string[], label: string): void {
  // B-049 F2: a lean turn passes `--settings` only with our own narrowing JSON (no hooks), never a file or other keys.
  const settings = args.filter((arg, i) => args[i - 1] === '--settings');
  assert.ok(settings.every((value) => value === LEAN_SETTINGS) && !args.some((arg) => arg.startsWith('--settings=')), `${label}: --settings only narrows`);
  const at = args.indexOf('--setting-sources');
  assert.ok(at >= 0, `${label}: --setting-sources is passed`);
  assert.equal(args.filter((arg) => arg === '--setting-sources' || arg.startsWith('--setting-sources=')).length, 1, `${label}: exactly once (a later one would win)`);
  assert.deepEqual(args[at + 1].split(',').map((source) => source.trim()), ['user'], `${label}: user settings only, never project or local`);
  assert.ok(args.includes('--strict-mcp-config'), `${label}: .mcp.json and every other MCP source are ignored`);
}

test('claude project config: a hub turn loads user settings only, our MCP file from temp, the hub permission tool, cwd = workspace', async () => {
  const h = claudeSetup();
  const result = await h.engine.run(input({ mcp: { url: 'http://127.0.0.1:4555/mcp', token: 'hub-token-for-test' } }).input);
  assert.equal(result.stop, 'done');
  const call = h.cli.of('turn')[0];
  assertUserSettingsOnly(call.args, 'hub turn');
  const mcpFile = call.args[call.args.indexOf('--mcp-config') + 1];
  assert.ok(mcpFile.startsWith(path.join(TEMP, 'claude-')), 'the MCP config is our temp file, never a file in the workspace');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'bypassPermissions', 'Claude Code never asks');
  for (const flag of WIDENING) assert.equal(call.args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), false, `no ${flag}`);
  assert.equal(call.options.cwd, WORKSPACE, 'the agent keeps working on files in the workspace');
  assert.equal(call.options.env?.CLAUDE_CONFIG_DIR, '/fake-homes/claude/acc_claude', 'user settings = the account home');
  for (const file of h.written.keys()) assert.ok(file.startsWith(path.join(TEMP, 'claude-')), `the engine writes nothing into the workspace (${file})`);
});

test('claude project config: a turn without the hub and a resumed turn are isolated the same way', async () => {
  const h = claudeSetup();
  const fresh = await h.engine.run(input().input);
  assert.equal(fresh.stop, 'done');
  const resumed = await h.engine.run(input({ runId: 'run_2', session: fresh.session }).input);
  assert.equal(resumed.stop, 'done');
  const [bare, again] = h.cli.of('turn');
  assertUserSettingsOnly(bare.args, 'turn without hub');
  assert.equal(bare.args[bare.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(bare.args[bare.args.indexOf('--permission-prompts') + 1], 'none', 'without a hub nothing that would prompt runs');
  assert.ok(again.args.includes('--resume'));
  assertUserSettingsOnly(again.args, 'resumed turn');
  for (const call of [bare, again]) {
    for (const flag of WIDENING) assert.equal(call.args.includes(flag), false, `no ${flag}`);
    assert.equal(call.options.cwd, WORKSPACE);
  }
});

test('claude project config: the status probe and auth status run in temp; the probe also loads user settings only', async () => {
  const h = claudeSetup({ init: { models: [], account: { email: 'person@example.test' } } });
  assert.deepEqual([...USER_SETTINGS_ONLY], ['--setting-sources', 'user']);
  const check = await h.engine.checkAccount(claudeAccount());
  assert.equal(check.state, 'ok');
  const [status] = h.cli.of('status');
  assert.equal(status.options.cwd, TEMP, 'auth status takes no --setting-sources, so it never runs in the process cwd');
  const [probe] = h.cli.of('probe');
  assertUserSettingsOnly(probe.args, 'probe');
  assert.ok(probe.args.includes('--safe-mode'), 'the probe keeps safe mode (no hooks, plugins, skills)');
  assert.deepEqual(probe.args.slice(probe.args.length - PROBE_ARGS.length), PROBE_ARGS);
  assert.equal(probe.options.cwd, TEMP);
});

test('claude project config: every Claude process runs with the CLI\'s own cron scheduler off (no prompts from .claude/scheduled_tasks.json)', async () => {
  const h = claudeSetup({ init: { models: [], account: { email: 'person@example.test' } } });
  assert.deepEqual({ ...NO_CLI_CRON }, { CLAUDE_CODE_DISABLE_CRON: '1' });
  await h.engine.checkAccount(claudeAccount());
  const hub = await h.engine.run(input({ mcp: { url: 'http://127.0.0.1:4555/mcp', token: 'hub-token-for-test' } }).input);
  await h.engine.run(input({ runId: 'run_2', session: hub.session }).input);
  await h.engine.run(input({ runId: 'run_3', account: claudeAccount({ home: undefined }) }).input);
  assert.deepEqual(h.cli.calls.map((call) => kindOf(call.args)).sort(), ['probe', 'status', 'turn', 'turn', 'turn']);
  for (const call of h.cli.calls) assert.equal(call.options.env?.CLAUDE_CODE_DISABLE_CRON, '1', `${call.args.slice(0, 2).join(' ')}: cron off`);
  const defaultHome = h.cli.of('turn')[2];
  assert.equal(defaultHome.options.env?.CLAUDE_CONFIG_DIR, undefined, 'a default-home login keeps its own config folder');
});
