// B-049 F2: a Claude Code agent turn runs lean – our system prompt replaces Claude Code's (`--system-prompt-file`,
// the volatile part of a new session after the dynamic boundary line), built-in tools cut to the execution core
// (`--tools`), no skills/slash commands, no hooks (`--settings`), no CLAUDE.md/auto memory/git workflow text (env),
// the hub's tools upfront (alwaysLoad) – while helper turns keep today's arguments. A CLI that refuses a lean flag
// (exits at once without a line) gets the same turn once more today's way and keeps that for the process.
// Owns: nothing in production. Never starts a real binary (scripted CLI from claude-fixture.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_TOOLS, HUB_CALL_MS, LEAN_ENV, LEAN_SETTINGS, LeanMemory, PROMPT_BOUNDARY, coreTools, promptArgs, promptText } from '../../../src/runtime/engines/claude/lean.ts';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup } from './claude-fixture.ts';

const HUB = { url: 'http://127.0.0.1:4555/mcp', token: 'hub-token-for-test' };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), cwd: '/fake-home/Workforce', ...patch });
/** Flags only a lean turn passes. */
const LEAN_ONLY = ['--system-prompt-file', '--disable-slash-commands', '--settings'];

function assertLean(args: string[], label: string): void {
  assert.ok(flag(args, '--system-prompt-file'), `${label}: our prompt replaces Claude Code's`);
  assert.equal(args.includes('--append-system-prompt-file'), false, `${label}: nothing appended to Claude Code's prompt`);
  assert.equal(args.filter((arg) => arg === '--tools').length, 1, `${label}: one tool list`);
  assert.deepEqual(flag(args, '--tools')!.split(','), coreTools(), `${label}: only the execution core`);
  assert.ok(args.includes('--disable-slash-commands'), `${label}: no skills or slash commands`);
  assert.deepEqual(JSON.parse(flag(args, '--settings')!), { disableAllHooks: true }, `${label}: only a narrowing setting`);
}

function assertToday(args: string[], label: string): void {
  assert.ok(flag(args, '--append-system-prompt-file'), `${label}: today's appended prompt`);
  for (const name of LEAN_ONLY) assert.equal(args.includes(name), false, `${label}: no ${name}`);
}

test('claude lean: the core tool list is Bash, Read, Edit, Write, Glob, Grep, WebSearch – plus PowerShell on Windows only', () => {
  assert.deepEqual([...CORE_TOOLS], ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  assert.deepEqual(coreTools('linux'), ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  assert.deepEqual(coreTools('darwin'), ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch']);
  assert.deepEqual(coreTools('win32'), ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'PowerShell']);
  assert.ok(coreTools('win32').includes('WebSearch'), "E1: Claude Code's own web search stays");
  for (const gone of ['WebFetch', 'Agent', 'Task', 'TodoWrite', 'TaskCreate', 'NotebookEdit', 'Skill', 'ToolSearch', 'Monitor', 'CronCreate', 'LSP']) {
    assert.equal(coreTools('win32').includes(gone), false, `${gone} is not offered`);
  }
  assert.deepEqual(promptArgs('/p.md', true, 'linux'), ['--system-prompt-file', '/p.md', '--tools', 'Bash,Read,Edit,Write,Glob,Grep,WebSearch', '--disable-slash-commands', '--settings', LEAN_SETTINGS]);
  assert.deepEqual(promptArgs('/p.md', false, 'linux'), ['--append-system-prompt-file', '/p.md']);
});

test('claude lean: the prompt text puts the boundary line between stable and volatile only when lean and both are there', () => {
  assert.equal(promptText('STABLE', 'VOLATILE', true), `STABLE\n\n${PROMPT_BOUNDARY}\n\nVOLATILE`);
  assert.equal(promptText('STABLE', undefined, true), 'STABLE', 'a resumed session: the stable part only');
  assert.equal(promptText('STABLE', '', true), 'STABLE');
  assert.equal(promptText('STABLE', 'VOLATILE', false), 'STABLE\n\nVOLATILE', 'today\'s form: never the marker (an appended prompt is not split)');
  assert.equal(promptText('', 'VOLATILE', true), 'VOLATILE');
  assert.match(promptText('S', 'V', true), new RegExp(`^S\\n\\n${PROMPT_BOUNDARY}$\\n\\nV`, 'm'), 'the marker stands on a line of its own');
});

test('claude lean: a new hub turn – our prompt with the boundary, core tools, no commands, no hooks, hub upfront, no CLAUDE.md/memory/git text', async () => {
  const h = claudeSetup();
  const result = await h.engine.run(input({ mcp: HUB }).input);
  assert.equal(result.stop, 'done');
  const [call] = h.cli.of('turn');
  assertLean(call.args, 'hub turn');
  assert.equal(h.written.get(flag(call.args, '--system-prompt-file')!), `STABLE\n\n${PROMPT_BOUNDARY}\n\nVOLATILE`);
  const config = JSON.parse(h.written.get(flag(call.args, '--mcp-config')!)!);
  assert.equal(config.mcpServers.workforce.alwaysLoad, true, 'startup waits for the hub, its tools are in the first request');
  assert.equal(flag(call.args, '--permission-mode'), 'bypassPermissions', 'Claude Code never asks');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.deepEqual(flag(call.args, '--setting-sources'), 'user');
  for (const [name, value] of Object.entries(LEAN_ENV)) assert.equal(call.options.env?.[name], value, `${name}=${value}`);
  assert.deepEqual(Object.keys(LEAN_ENV).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS']);
  assert.equal(call.options.env?.CLAUDE_CODE_DISABLE_CRON, '1', 'the CLI cron stays off');
});

test('claude lean: a resumed hub turn stays lean with the stable part only; the volatile part travels in the message', async () => {
  const h = claudeSetup();
  const fresh = await h.engine.run(input({ mcp: HUB }).input);
  const resumed = await h.engine.run(input({ runId: 'run_2', mcp: HUB, session: fresh.session }).input);
  assert.equal(resumed.stop, 'done');
  const second = h.cli.of('turn')[1];
  assertLean(second.args, 'resumed turn');
  assert.equal(flag(second.args, '--resume'), fresh.session!.ref);
  assert.equal(h.written.get(flag(second.args, '--system-prompt-file')!), 'STABLE');
  const user = second.child.lines.find((line: any) => line?.type === 'user') as any;
  assert.equal(user.message.content[0].text, '<workforce-context>\nVOLATILE\n</workforce-context>');
});

test('claude lean: an agent turn without the hub is lean too (nothing that would prompt runs: --permission-prompts none)', async () => {
  const h = claudeSetup();
  await h.engine.run(input().input);
  const [call] = h.cli.of('turn');
  assertLean(call.args, 'turn without hub');
  assert.equal(flag(call.args, '--permission-prompts'), 'none');
  assert.equal(call.args.includes('--no-session-persistence'), false);
});

test('claude lean: helper turns run on our system prompt only, with no built-in tool, without CLAUDE.md and memory', async () => {
  const h = claudeSetup();
  await h.engine.run(input({ tools: [] }).input);
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  await h.engine.run(input({ runId: 'run_2', tools: [], outputSchema: schema }).input);
  const [reader, decision] = h.cli.of('turn');
  for (const [call, label] of [[reader, 'helper turn'], [decision, 'schema turn']] as const) {
    assert.equal(call.args.includes('--append-system-prompt-file'), false, `${label}: nothing appended to Claude Code's prompt`);
    assert.equal(call.args.filter((arg) => arg === '--tools').length, 1, `${label}: one tool list`);
    assert.equal(flag(call.args, '--tools'), '', `${label}: no built-in tool at all`);
    assert.ok(call.args.includes('--disable-slash-commands'), `${label}: no skills or commands`);
    assert.ok(call.args.includes('--no-session-persistence'), `${label}: no transcript`);
    for (const [name, value] of Object.entries(LEAN_ENV)) assert.equal(call.options.env?.[name], value);
  }
  assert.ok(h.written.get(flag(reader.args, '--system-prompt-file')!)!.startsWith('STABLE'));
});

test('claude lean: a helper turn without a system prompt keeps today\'s arguments', async () => {
  const h = claudeSetup();
  await h.engine.run(input({ tools: [], system: { stable: '', volatile: '' } }).input);
  const [call] = h.cli.of('turn');
  assertToday(call.args, 'helper turn');
  assert.equal(flag(call.args, '--tools'), '', 'no built-in tool at all');
});

test('claude lean: an agent turn with an output schema keeps today\'s arguments (the schema answer tool is never withheld)', async () => {
  const h = claudeSetup({ turn: (_call, session) => [{ type: 'result', subtype: 'success', is_error: false, result: '{}', structured_output: { ok: true }, session_id: session }] });
  await h.engine.run(input({ mcp: HUB, outputSchema: { type: 'object' } }).input);
  const [call] = h.cli.of('turn');
  assertToday(call.args, 'agent schema turn');
  assert.equal(call.args.includes('--tools'), false);
});

test('claude lean: a CLI that refuses a lean flag gets the same turn today\'s way at once, and the process keeps today\'s way', async () => {
  const h = claudeSetup({ refuse: (args) => args.includes('--system-prompt-file') });
  const first = await h.engine.run(input({ mcp: HUB }).input);
  assert.equal(first.stop, 'done', 'the turn still answers');
  assert.equal(first.text, 'Done.');
  const [refused, retried] = h.cli.of('turn');
  assertLean(refused.args, 'refused start');
  assertToday(retried.args, 'retry');
  assert.equal(retried.args.includes('--tools'), false, 'today\'s tool set');
  assert.equal(flag(retried.args, '--session-id'), flag(refused.args, '--session-id'), 'the same new session');
  assert.equal(h.written.get(flag(retried.args, '--append-system-prompt-file')!), 'STABLE\n\nVOLATILE', 'rewritten without the marker');
  const config = JSON.parse(h.written.get(flag(retried.args, '--mcp-config')!)!);
  assert.equal('alwaysLoad' in config.mcpServers.workforce, false, 'today\'s hub entry');
  assert.equal(config.mcpServers.workforce.timeout, HUB_CALL_MS, 'a long hub call is not cut at the CLI\'s 60 s');
  assert.equal(retried.child.lines.filter((line: any) => line?.type === 'user').length, 1, 'the message went to the retry once');
  assert.ok(h.removed.includes(flag(retried.args, '--append-system-prompt-file')!) && h.removed.includes(flag(retried.args, '--mcp-config')!), 'temp files deleted');

  const second = await h.engine.run(input({ runId: 'run_2', mcp: HUB, session: first.session }).input);
  assert.equal(second.stop, 'done');
  assert.equal(h.cli.of('turn').length, 3, 'no second lean try in this process');
  assertToday(h.cli.of('turn')[2].args, 'next turn');
});

test('claude lean: a start without a line after a lean turn already answered is a failure, never a retry', async () => {
  let refuse = false;
  const h = claudeSetup({ refuse: () => refuse });
  assert.equal((await h.engine.run(input({ mcp: HUB }).input)).stop, 'done');
  refuse = true;
  const failed = await h.engine.run(input({ runId: 'run_2', mcp: HUB }).input);
  assert.equal(failed.stop, 'error');
  assert.equal(failed.error?.message, 'Claude Code stopped unexpectedly.');
  assert.equal(h.cli.of('turn').length, 2, 'one start, no retry');
  refuse = false;
  await h.engine.run(input({ runId: 'run_3', mcp: HUB }).input);
  assertLean(h.cli.of('turn')[2].args, 'still lean');
});

test('claude lean: when today\'s way ends without a line too it was no refusal – the turn fails and the next one is lean again', async () => {
  let refuse = true;
  const h = claudeSetup({ refuse: () => refuse });
  const failed = await h.engine.run(input({ mcp: HUB }).input);
  assert.equal(failed.stop, 'error');
  assert.equal(h.cli.of('turn').length, 2, 'lean, then once today\'s way');
  refuse = false;
  await h.engine.run(input({ runId: 'run_2', mcp: HUB }).input);
  assertLean(h.cli.of('turn')[2].args, 'lean again');
});

test('claude lean: a cancelled turn is never retried', async () => {
  const controller = new AbortController();
  // Cancelled while its first (lean) CLI runs: a turn stopped before that starts none at all (claude-bare-turn.test.ts).
  const h = claudeSetup({ refuse: () => { controller.abort(); return true; } });
  const result = await h.engine.run(input({ mcp: HUB, signal: controller.signal }).input);
  assert.equal(result.stop, 'interrupted');
  assert.equal(h.cli.of('turn').length, 1);
});

test('claude lean: LeanMemory – unknown until a lean turn answers; a refusal sticks only when today\'s way answers', () => {
  const memory = new LeanMemory();
  assert.equal(memory.allowed(), true);
  assert.equal(memory.afterLean(true), true, 'first quiet lean start: retry');
  memory.afterRetry(false);
  assert.equal(memory.allowed(), false, 'refused for the process');
  const crash = new LeanMemory();
  assert.equal(crash.afterLean(true), true);
  crash.afterRetry(true);
  assert.equal(crash.allowed(), true, 'quiet both ways: not the flags');
  const ok = new LeanMemory();
  assert.equal(ok.afterLean(false), false);
  assert.equal(ok.afterLean(true), false, 'after an answer a quiet start is a crash, not a refusal');
  assert.equal(ok.allowed(), true);
});
