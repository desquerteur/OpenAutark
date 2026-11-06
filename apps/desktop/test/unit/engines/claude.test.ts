// Claude Code adapter against a scripted CLI (claude-fixture.ts) – no real binary, no network,
// no file outside memory, every account home a fake path:
// command line (session id vs resume, prompt file, MCP config file, permission prompt tool,
// volatile context on resume), the stream parser (deltas, reasoning, subagents, tools,
// rate_limit_event, not signed in, structured output), interrupt/steer, the status probe
// (needs_login, one-minute throttle, account env) and model discovery (aliases, fallback,
// context windows from modelUsage).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CLAUDE_MODELS } from '../../../src/runtime/engines/claude/engine.ts';
import { HUB_CALL_MS } from '../../../src/runtime/engines/claude/lean.ts';
import { claudeModels, parseInitialize } from '../../../src/runtime/engines/claude/models.ts';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup, until, TEMP } from './claude-fixture.ts';

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const userLines = (child: { lines: unknown[] }) => child.lines.filter((line: any) => line?.type === 'user') as any[];
const ok = (session: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session, ...extra });
const delta = (text: string, parent?: string) => ({ type: 'stream_event', ...(parent ? { parent_tool_use_id: parent } : {}), event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-opus-5-5', account: claudeAccount(), ...patch });

const INIT = {
  commands: [], output_style: 'default',
  models: [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Most capable for complex work' },
    { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Most capable for complex work' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Best for everyday tasks' },
    { value: 'sonnet[1m]', displayName: 'Sonnet (1M context)', description: 'Sonnet 5.5 for long sessions' },
    { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'opusplan', displayName: 'Opus Plan Mode', description: 'Opus 5.5 in plan mode, else Sonnet 5.5' },
    { value: 'claude-opus-4-1-20250805', displayName: 'Opus 4.1', description: 'Legacy model', supportsEffort: false },
  ],
  account: { email: 'person@example.test', organization: 'Example', subscriptionType: 'max' },
};

test('claude: a new session gets --session-id and both prompt parts; a resumed one --resume and the volatile part as a block; prompt files are deleted', async () => {
  const h = claudeSetup();
  const fresh = await h.engine.run(input().input);
  assert.equal(fresh.stop, 'done');
  assert.equal(fresh.text, 'Done.');
  const first = h.cli.of('turn')[0];
  assert.equal(flag(first.args, '--session-id'), fresh.session!.ref);
  assert.equal(first.args.includes('--resume'), false);
  assert.equal(flag(first.args, '--model'), 'claude-opus-5-5');
  assert.equal(flag(first.args, '--effort'), 'medium');
  const promptFile = flag(first.args, '--system-prompt-file')!; // B-049 F2: our prompt replaces Claude Code's
  assert.ok(promptFile.startsWith(path.join(TEMP, 'claude-run_1-')), 'the prompt file lives in the temp dir');
  assert.equal(h.written.get(promptFile), 'STABLE\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\nVOLATILE');
  assert.deepEqual(userLines(first.child)[0].message.content, [{ type: 'text', text: 'hello' }]);
  assert.ok(h.removed.includes(promptFile), 'the prompt file is deleted after the turn');

  const resumed = await h.engine.run(input({ session: fresh.session, system: { stable: 'STABLE', volatile: 'VOLATILE2' } }).input);
  assert.equal(resumed.stop, 'done');
  assert.deepEqual(resumed.session, fresh.session);
  const second = h.cli.of('turn')[1];
  assert.equal(flag(second.args, '--resume'), fresh.session!.ref);
  assert.equal(second.args.includes('--session-id'), false);
  const resumedPrompt = flag(second.args, '--system-prompt-file')!;
  assert.equal(h.written.get(resumedPrompt), 'STABLE', 'Claude Code replays the first system prompt: only the stable part');
  assert.deepEqual(userLines(second.child)[0].message.content, [
    { type: 'text', text: '<workforce-context>\nVOLATILE2\n</workforce-context>' }, { type: 'text', text: 'hello' },
  ]);
  assert.ok(h.removed.includes(resumedPrompt));
  await h.engine.dispose();
});

test('claude: the MCP hub travels in a config file (never argv), with the hub permission prompt tool; without a hub no MCP at all', async () => {
  const h = claudeSetup();
  const secret = 'hub-token-for-test';
  const withHub = await h.engine.run(input({ mcp: { url: 'http://127.0.0.1:4555/mcp', token: secret } }).input);
  assert.equal(withHub.stop, 'done');
  const args = h.cli.of('turn')[0].args;
  const mcpFile = flag(args, '--mcp-config')!;
  assert.ok(mcpFile.endsWith('.mcp.json'));
  assert.deepEqual(JSON.parse(h.written.get(mcpFile)!), { mcpServers: { workforce: { type: 'http', url: 'http://127.0.0.1:4555/mcp', headers: { Authorization: `Bearer ${secret}` }, timeout: HUB_CALL_MS, alwaysLoad: true } } }); // B-049: hub tools upfront
  assert.ok(!args.some((arg) => arg.includes(secret)), 'the hub token never appears in argv');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag(args, '--permission-mode'), 'bypassPermissions');
  assert.ok(h.removed.includes(mcpFile), 'the MCP config file is deleted after the turn');

  await h.engine.run(input({ runId: 'run_2' }).input);
  const bare = h.cli.of('turn')[1].args;
  assert.equal(flag(bare, '--mcp-config'), '{"mcpServers":{}}');
  assert.equal(bare.includes('bypassPermissions'), false);
  assert.equal([...h.written.keys()].filter((file) => file.endsWith('.mcp.json')).length, 1, 'no config file without a hub');
});

test('claude: prompt and MCP files are deleted also when the process dies without a result', async () => {
  const h = claudeSetup({ turn: () => [] });
  const result = await h.engine.run(input({ mcp: { url: 'http://127.0.0.1:4555/mcp', token: 't' } }).input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.code, 'unavailable');
  assert.equal(result.error?.message, 'Claude Code stopped unexpectedly.');
  const args = h.cli.of('turn')[0].args;
  assert.ok(h.removed.includes(flag(args, '--system-prompt-file')!));
  assert.ok(h.removed.includes(flag(args, '--mcp-config')!));
});

test('claude stream: visible work updates, final answer, subagent isolation, tools and usage', async () => {
  const h = claudeSetup({
    turn: (_call, session) => [
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking the tests' } } },
      delta('Let me '), delta('check.'),
      { type: 'assistant', message: { id: 'msg_1', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'tu_2', name: 'mcp__workforce__tasks__create', input: { title: 'Ship' } },
      ] } },
      delta('SUBAGENT TEXT', 'tu_9'),
      { type: 'assistant', parent_tool_use_id: 'tu_9', message: { id: 'msg_s', content: [{ type: 'text', text: 'Subagent notes' }] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'All tests passed' },
        { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: [{ type: 'text', text: 'Refused by policy' }] },
      ] } },
      delta('All green.'),
      { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'All green.' }] } },
      { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'All green.' }] } },
      ok(session, { result: 'All green.', usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0.12 }),
    ],
  });
  const t = input();
  const result = await h.engine.run(t.input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'All green.', 'the final answer excludes intermediate work updates and subagent text');
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 40, costUsd: 0.12, cacheReadTokens: 900 }, 'inputTokens stays the total; the cache read beside it');
  assert.equal(result.contextTokens, 1000);
  const of = (type: string) => t.events.filter((event: any) => event.type === type);
  assert.deepEqual(of('commentary'), [{ type: 'commentary', text: 'Let me check.' }]);
  assert.deepEqual(of('text').map((event: any) => event.delta), ['Let me ', 'check.', 'All green.']);
  assert.deepEqual(of('reasoning'), [{ type: 'reasoning', delta: 'Checking the tests' }]);
  assert.deepEqual(of('tool_start'), [
    { type: 'tool_start', callId: 'tu_1', name: 'Bash', args: { command: 'npm test' }, own: true },
    { type: 'tool_start', callId: 'tu_2', name: 'tasks.create', args: { title: 'Ship' }, own: false },
  ]);
  assert.deepEqual(of('status'), [{ type: 'status', note: 'running npm test' }], 'a status line for the engine\'s own tools only');
  assert.deepEqual(of('tool_end'), [ // B-048: the full tool_result content rides along as output
    { type: 'tool_end', callId: 'tu_1', ok: true, summary: 'All tests passed', output: 'All tests passed' },
    { type: 'tool_end', callId: 'tu_2', ok: false, summary: 'Refused by policy', output: 'Refused by policy' },
  ]);
  assert.deepEqual(of('usage'), [{ type: 'usage', inputTokens: 1000, outputTokens: 40, cacheReadTokens: 900, contextTokens: 1000, costUsd: 0.12 }]);
});

test('claude stream: without partial deltas the assistant text is emitted once per block', async () => {
  const h = claudeSetup({ turn: (_call, session) => [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'First.' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Second.' }] } },
    ok(session, { result: 'Second.' }),
  ] });
  const t = input();
  const result = await h.engine.run(t.input);
  assert.equal(result.text, 'First.\n\nSecond.');
  assert.deepEqual(t.events.filter((event: any) => event.type === 'text').map((event: any) => event.delta), ['First.', 'Second.']);
});

test('claude stream: rate_limit_event reports limits; a rejected one (or a rate_limit assistant error) ends the turn as a limit', async () => {
  const h = claudeSetup({ turn: (_call, session) => [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1_800_500_000 } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_003_600 } },
    { ...ok(session), is_error: true, result: 'You have hit your limit' },
  ] });
  const t = input();
  const limited = await h.engine.run(t.input);
  assert.equal(limited.stop, 'limit');
  assert.equal(limited.error?.code, 'rate_limited');
  assert.equal(limited.error?.retryAfterMs, 3_600_000, 'until the rejected window resets');
  const limits = t.events.filter((event: any) => event.type === 'limits').map((event: any) => event.limits.windows[0]);
  assert.deepEqual(limits.map((w: any) => [w.name, w.usedPercent]), [['weekly', 80], ['5h', 100]]);

  const h2 = claudeSetup({ turn: (_call, session) => [
    { type: 'assistant', error: 'rate_limit', message: { id: 'm', content: [{ type: 'text', text: 'API Error: rate limited' }] } },
    { ...ok(session), is_error: true, result: 'API Error' },
  ] });
  assert.equal((await h2.engine.run(input().input)).stop, 'limit');
});

test('claude stream: a signed-out account fails as "not signed in" (result text or authentication_failed)', async () => {
  for (const turn of [
    (session: string) => [{ ...ok(session), is_error: true, result: 'Not logged in · Please run /login' }],
    (session: string) => [{ type: 'assistant', error: 'authentication_failed', message: { id: 'm', content: [{ type: 'text', text: 'Request failed' }] } }, { ...ok(session), is_error: true, result: 'Request failed' }],
  ]) {
    const h = claudeSetup({ turn: (_call, session) => turn(session) });
    const result = await h.engine.run(input().input);
    assert.equal(result.stop, 'error');
    assert.deepEqual(result.error, { code: 'unavailable', message: 'Claude Code is not signed in for this account.' });
  }
});

test('claude: structured output only with an output schema (--json-schema)', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const h = claudeSetup({ turn: (_call, session) => [ok(session, { result: '{"ok":true}', structured_output: { ok: true } })] });
  const typed = await h.engine.run(input({ outputSchema: schema }).input);
  assert.deepEqual(typed.structured, { ok: true });
  assert.deepEqual(JSON.parse(flag(h.cli.of('turn')[0].args, '--json-schema')!), schema);
  const plain = await h.engine.run(input({ runId: 'run_2' }).input);
  assert.equal(plain.structured, undefined);
  assert.equal(h.cli.of('turn')[1].args.includes('--json-schema'), false);
});

test('claude: steer writes a user line into the running turn; abort sends an interrupt and ends it as interrupted', async () => {
  const h = claudeSetup({ exit: false, turn: () => [delta('Working')] });
  const controller = new AbortController();
  const t = input({ signal: controller.signal });
  const running = h.engine.run(t.input);
  await until(() => t.events.some((event: any) => event.type === 'text'));
  assert.equal(await h.engine.steer('run_1', 'Also update the docs'), true);
  const child = h.cli.of('turn')[0].child;
  await until(() => userLines(child).length === 2);
  assert.deepEqual(userLines(child)[1].message.content, [{ type: 'text', text: 'Also update the docs' }]);
  controller.abort();
  const result = await running;
  assert.equal(result.stop, 'interrupted');
  assert.equal(result.error?.code, 'cancelled');
  assert.ok(child.lines.some((line: any) => line?.type === 'control_request' && line.request?.subtype === 'interrupt'));
  assert.equal(await h.engine.steer('run_1', 'too late'), false);
});

test('claude status: a signed-out account is needs_login without starting the probe', async () => {
  const h = claudeSetup({ status: { code: 1, json: { loggedIn: false } }, init: INIT });
  const check = await h.engine.checkAccount(claudeAccount());
  assert.deepEqual(check, { state: 'needs_login', message: 'Sign in to Claude Code.' });
  assert.equal(h.cli.of('probe').length, 0);
  const crashed = claudeSetup({ status: { code: 1, json: '' }, init: INIT });
  assert.equal((await crashed.engine.checkAccount(claudeAccount())).state, 'error', 'a CLI that did not answer says nothing about the login');
  const missing = claudeSetup({}, { installed: false });
  assert.equal((await missing.engine.checkAccount(claudeAccount())).state, 'error');
  assert.deepEqual(await missing.engine.listModels(claudeAccount()), CLAUDE_MODELS, 'not installed: the static list');
});

test('claude status: one probe (initialize + get_usage) per account and one minute, shared by checks and model lists; account env only', async () => {
  const usage = { rate_limits_available: true, subscription_type: 'max', rate_limits: { five_hour: { utilization: 20, resets_at: '2027-01-01T00:00:00Z' }, seven_day: { utilization: 55 } } };
  const h = claudeSetup({ init: INIT, usage });
  const acc = claudeAccount();
  const [check, models] = await Promise.all([h.engine.checkAccount(acc), h.engine.listModels(acc)]);
  assert.equal(h.cli.of('probe').length, 1, 'concurrent check and model list share one probe');
  assert.equal(check.state, 'ok');
  assert.equal(check.email, 'person@example.test');
  assert.equal(check.plan, 'max');
  assert.deepEqual(check.limits?.windows.map((w) => [w.name, w.usedPercent]), [['5h', 20], ['weekly', 55]]);
  assert.ok(models.some((m) => m.model === 'claude-sonnet-5-5'));
  const probe = h.cli.of('probe')[0];
  assert.deepEqual(probe.child.lines.map((line: any) => line.request?.subtype), ['initialize', 'get_usage']);
  assert.equal(probe.options.cwd, TEMP);

  await h.engine.checkAccount(acc);
  await h.engine.listModels(acc);
  assert.equal(h.cli.of('probe').length, 1, 'cached for one minute');
  h.clock.now += 60_000;
  await h.engine.checkAccount(acc);
  assert.equal(h.cli.of('probe').length, 2, 'probed again after one minute');
  await h.engine.listModels(claudeAccount({ id: 'acc_other' }));
  assert.equal(h.cli.of('probe').length, 3, 'every account has its own probe');

  await h.engine.run(input().input);
  for (const call of h.cli.calls) {
    const env = call.options.env!;
    assert.match(String(env.CLAUDE_CONFIG_DIR), /^\/fake-homes\/claude\/acc_/, 'every process runs in the account home, never the default one');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'API keys are stripped');
  }
});

test('claude status: e-mail and plan from initialize when auth status and get_usage have none', async () => {
  const h = claudeSetup({ status: { json: { loggedIn: true, authMethod: 'claude.ai' } }, init: { models: [], account: { email: 'person@example.test', subscriptionType: 'pro' } } });
  const check = await h.engine.checkAccount(claudeAccount());
  assert.equal(check.email, 'person@example.test');
  assert.equal(check.plan, 'pro');
  assert.equal(check.limits, undefined);
});

test('claude models: the CLI list with aliases mapped to ids, 1M variants apart, modes and duplicates dropped', async () => {
  const h = claudeSetup({ init: INIT });
  const models = await h.engine.listModels(claudeAccount());
  assert.deepEqual(models.map((m) => m.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5-1m', 'claude-haiku-5-5', 'claude-opus-4-1-20250805']);
  const by = new Map(models.map((m) => [m.model, m]));
  assert.equal(by.get('claude-opus-5-5')!.name, 'Claude Opus 5.5');
  assert.equal(by.get('claude-sonnet-5-5-1m')!.name, 'Claude Sonnet 5.5 (1M context)');
  assert.equal(by.get('claude-sonnet-5-5-1m')!.contextTokens, 1_000_000);
  assert.deepEqual(by.get('claude-haiku-5-5')!.efforts, ['low', 'medium', 'high']);
  assert.equal(by.get('claude-opus-4-1-20250805')!.name, 'Opus 4.1');
  assert.deepEqual(by.get('claude-opus-4-1-20250805')!.efforts, []);
  assert.equal(by.get('claude-opus-4-1-20250805')!.contextTokens, undefined, 'unknown window: the catalog priors decide');

  await h.engine.run(input({ model: 'claude-opus-4-1-20250805' }).input);
  await h.engine.run(input({ runId: 'run_2', model: 'claude-haiku-5-5', effort: 'high' }).input);
  const [legacy, haiku] = h.cli.of('turn').map((call) => call.args);
  assert.equal(legacy.includes('--effort'), false, 'a model listed without effort support runs without --effort');
  assert.equal(flag(haiku, '--effort'), 'high');
});

test('claude models: "default" only when it names exactly one model not listed otherwise; tolerant field names', () => {
  const init = parseInitialize({ models: [
    { value: 'default', display_name: 'Default', description: 'Fable 5.1 for writing' },
    { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5.5' },
    'haiku',
    { value: 'default', description: 'Opus 5.5 for 50 % of your limits, then Sonnet 5.5' },
    { value: 'custom-alias', description: 'Something else' },
  ] });
  assert.deepEqual(claudeModels(init).map((m) => m.model), ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  assert.equal(parseInitialize({ commands: [] }), undefined);
  assert.equal(parseInitialize('nope'), undefined);
});

test('claude models: fall back to CLAUDE_MODELS when initialize answers with an error or nothing maps; a probe that dies first throws', async () => {
  for (const init of ['error', { models: [{ value: 'opusplan', description: 'Plan mode' }] }] as const) {
    const h = claudeSetup({ init });
    assert.deepEqual(await h.engine.listModels(claudeAccount()), CLAUDE_MODELS, `fallback for ${JSON.stringify(init)}`);
  }
  const dead = claudeSetup({ init: 'crash' });
  await assert.rejects(dead.engine.listModels(claudeAccount()), /did not answer/, 'no answer, no list yet: the catalog keeps its previous listing');
  const h = claudeSetup({ init: INIT });
  assert.deepEqual(await h.engine.listModels(claudeAccount({ state: 'needs_login' })), CLAUDE_MODELS);
  assert.equal(h.cli.of('probe').length, 0, 'a signed-out account is not probed for models');
});

test('claude models: the context window modelUsage reported in a turn feeds this account\'s list', async () => {
  const h = claudeSetup({ init: INIT, turn: (_call, session) => [ok(session, { modelUsage: {
    'claude-sonnet-5-5-20261001': { contextWindow: 200_000 }, 'claude-haiku-5-5': { contextWindow: 400_000 }, 'bad id!': { contextWindow: 5 },
  } })] });
  const acc = claudeAccount();
  const before = new Map((await h.engine.listModels(acc)).map((m) => [m.model, m.contextTokens]));
  assert.equal(before.get('claude-sonnet-5-5'), 1_000_000);
  const turn = await h.engine.run(input({ model: 'claude-sonnet-5-5' }).input);
  assert.equal(turn.contextWindow, 200_000, 'the dated variant of the turn model');
  h.clock.now += 60_000;
  const after = new Map((await h.engine.listModels(acc)).map((m) => [m.model, m.contextTokens]));
  assert.equal(after.get('claude-sonnet-5-5'), 200_000);
  assert.equal(after.get('claude-haiku-5-5'), 400_000);
  assert.equal(after.get('claude-sonnet-5-5-1m'), 1_000_000, 'the 1M variant keeps its own window');
  const other = new Map((await h.engine.listModels(claudeAccount({ id: 'acc_other' }))).map((m) => [m.model, m.contextTokens]));
  assert.equal(other.get('claude-sonnet-5-5'), 1_000_000, 'windows stay with the account that reported them');
  const fallback = claudeModels(undefined, new Map([['claude-opus-5-5-20261001', 500_000]]));
  assert.equal(fallback.find((m) => m.model === 'claude-opus-5-5')!.contextTokens, 500_000, 'also on the static list');
});
