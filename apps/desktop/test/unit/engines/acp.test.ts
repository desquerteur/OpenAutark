// Generic ACP engine against a scripted agent (fakes.ts acpAgent) – no real agent, no download,
// network only on 127.0.0.1 (the MCP proxy): initialize and session/new with the HTTP MCP hub,
// text/reasoning/tool/plan updates, permission requests (allowed, optionIds,
// strict hub detection), cancel, stopReason mapping, auth errors and the proxy itself.
// Sessions, models, images and processes: acp-sessions.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpProxy } from '../../../src/runtime/engines/acp/mcp-proxy.ts';
import { hubToolOf, permissionOutcome } from '../../../src/runtime/engines/acp/updates.ts';
import { account, turnInput, type FakeAcpTurn } from './fakes.ts';
import { OPTIONS, setup, until } from './acp-fixture.ts';

test('acp: initialize, session/new with the HTTP MCP hub behind the proxy, instructions block, streamed text/reasoning/plan', async () => {
  const { agent, engine, forwarded, requests } = setup({
    onPrompt: (t) => {
      t.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
      t.update({ sessionUpdate: 'plan', entries: [{ content: 'Look', priority: 'high', status: 'completed' }, { content: 'Answer', priority: 'high', status: 'in_progress' }] });
      t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } });
      t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } });
      t.update({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
      t.end('end_turn', { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    },
  });
  const { input, events } = turnInput({ mcp: { url: 'http://127.0.0.1:1/mcp/leasetoken_leasetoken_1', token: 'leasetoken_leasetoken_1' } });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Hello');
  assert.deepEqual(result.session, { ref: 'sess_1', generation: 1 });
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(result.contextTokens, 1200);
  assert.equal(result.contextWindow, 200000);
  const call = agent.calls[0];
  assert.deepEqual(call.args, ['--acp']);
  assert.equal(call.options.env?.FAKE_HOME, '/homes/a');
  const init = requests('initialize')[0];
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.params.protocolVersion, 1);
  assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const created = requests('session/new')[0];
  assert.equal(created.params.cwd, '/work');
  assert.equal(created.params.mcpServers.length, 1);
  const hub = created.params.mcpServers[0];
  assert.equal(hub.type, 'http');
  assert.equal(hub.name, 'workforce');
  assert.match(hub.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{32,}$/);
  const prompt = requests('session/prompt')[0].params.prompt;
  assert.equal(prompt[0].type, 'text');
  assert.match(prompt[0].text, /^<workforce-instructions>\nSTABLE\n<\/workforce-instructions>\n\n<workforce-context>\nVOLATILE\n<\/workforce-context>$/);
  assert.deepEqual(prompt[1], { type: 'text', text: 'hello' });
  assert.deepEqual(events.filter((e: any) => e.type === 'text').map((e: any) => e.delta), ['Hel', 'lo']);
  assert.deepEqual(events.filter((e: any) => e.type === 'reasoning').map((e: any) => e.delta), ['Thinking']);
  assert.deepEqual(events.find((e: any) => e.type === 'plan').steps, [{ text: 'Look', status: 'done' }, { text: 'Answer', status: 'active' }]);
  // Between turns the proxy answers 401; the lease is not reachable any more.
  const between = await fetch(hub.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(between.status, 401);
  assert.equal(forwarded.length, 0);
  await engine.dispose();
});

test('acp: the proxy forwards the agent\'s MCP calls to the running turn\'s lease only', async () => {
  let hubUrl = '';
  const { engine, forwarded, requests } = setup({
    onPrompt: (t) => {
      void fetch(hubUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Mcp-Protocol-Version': '2025-06-18' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
        .then(async (response) => {
          t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${response.status} ${response.headers.get('mcp-session-id')} ${await response.text()}` } });
          t.end();
        });
    },
    handle: (msg, reply) => {
      if (msg.method !== 'session/new') return false;
      hubUrl = msg.params.mcpServers[0].url;
      reply.result({ sessionId: 'sess_p' });
      return true;
    },
  });
  const lease = { url: 'http://127.0.0.1:9/mcp/leasetoken_leasetoken_2', token: 'leasetoken_leasetoken_2' };
  const result = await engine.run(turnInput({ mcp: lease }).input);
  assert.equal(result.stop, 'done');
  assert.match(result.text, /^200 m1 \{"jsonrpc":"2\.0"/);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, lease.url);
  assert.equal(forwarded[0].init.headers.Authorization, `Bearer ${lease.token}`);
  assert.equal(forwarded[0].init.headers['mcp-protocol-version'], '2025-06-18');
  // The next turn on the same session binds its own (new) lease; the session keeps its URL.
  const next = { url: 'http://127.0.0.1:9/mcp/leasetoken_leasetoken_3', token: 'leasetoken_leasetoken_3' };
  const second = await engine.run(turnInput({ mcp: next, session: { ref: 'sess_p', generation: 1 } }).input);
  assert.equal(second.stop, 'done');
  assert.equal(forwarded[1].url, next.url);
  assert.equal(requests('session/new').length, 1);
  assert.equal(requests('session/load').length, 0);
  await engine.dispose();
});

test('acp: tool calls become tool events; own tools vs workforce hub tools', async () => {
  const { engine } = setup({
    onPrompt: (t) => {
      t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me check.' } });
      t.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
      t.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' });
      t.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '12 passed' } }] });
      t.update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'mcp__workforce__tasks__create', kind: 'other', status: 'in_progress', rawInput: { title: 'X' } });
      t.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed' });
      t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All green.' } });
      t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } });
      t.end();
    },
  });
  const { input, events } = turnInput();
  const result = await engine.run(input);
  assert.equal(result.text, 'Let me check.\n\nAll green.');
  assert.deepEqual(result.files, [{ name: 'agent-image-1.png', mime: 'image/png', dataBase64: 'AAAA' }]);
  const tools = events.filter((e: any) => e.type === 'tool_start' || e.type === 'tool_end');
  assert.deepEqual(tools, [
    { type: 'tool_start', callId: 't1', name: 'shell', args: { command: 'npm test' }, own: true, title: 'npm test' },
    { type: 'tool_end', callId: 't1', ok: true, summary: '12 passed' },
    { type: 'tool_start', callId: 't2', name: 'tasks.create', args: { title: 'X' }, own: false },
    { type: 'tool_end', callId: 't2', ok: false, summary: 'failed' },
  ]);
  await engine.dispose();
});

test('acp: permission requests are allowed (allow_once, else the server option); fs requests are not ours', async () => {
  const { agent, engine } = setup({
    onPrompt: (t) => {
      t.request(901, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c1', title: 'npm install', kind: 'execute', rawInput: { command: 'npm install', cwd: '/work' } }, options: OPTIONS });
      t.request(902, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c2', title: 'Edit a.ts', kind: 'edit', locations: [{ path: '/work/a.ts' }] }, options: OPTIONS });
      t.request(903, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c3', title: 'mcp__workforce__tasks__create', kind: 'other' }, options: OPTIONS });
      // Gemini CLI style: the title is the arguments; the option names our server.
      t.request(904, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'tasks__create-1760000000', title: '{"title":"X"}', kind: 'other' }, options: [{ optionId: 'proceed_always_server', name: 'Always Allow workforce', kind: 'allow_always' }, { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }] });
      // A command that merely mentions a hub name is never pre-allowed.
      t.request(905, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c5', title: 'mcp__workforce__tasks__create', kind: 'execute', rawInput: { command: 'rm -rf /' } }, options: OPTIONS });
      t.request(906, 'fs/read_text_file', { sessionId: t.sessionId, path: '/etc/passwd' });
    },
  });
  agent.state.onReply = () => {
    if (agent.state.replies.size < 6) return;
    const pending = [...agent.state.prompts.values()][0];
    agent.calls[0].child.send({ jsonrpc: '2.0', id: pending.id, result: { stopReason: 'end_turn' } });
  };
  const result = await engine.run(turnInput().input);
  assert.equal(result.stop, 'done');
  const outcome = (id: number) => agent.state.replies.get(id).result.outcome;
  for (const id of [901, 902, 903, 905]) assert.deepEqual(outcome(id), { outcome: 'selected', optionId: 'yes' }, String(id));
  assert.deepEqual(outcome(904), { outcome: 'selected', optionId: 'proceed_once' });
  assert.equal(agent.state.replies.get(906).error.code, -32601);
  await engine.dispose();
});

test('acp: abort sends session/cancel and gives interrupted (a permission request was already allowed)', async () => {
  const controller = new AbortController();
  const { agent, engine, requests } = setup({
    onPrompt: (t) => {
      t.request(910, 'session/request_permission', { sessionId: t.sessionId, toolCall: { toolCallId: 'c1', title: 'make', kind: 'execute' }, options: OPTIONS });
      setImmediate(() => controller.abort());
    },
  });
  const { input } = turnInput({ signal: controller.signal });
  const result = await engine.run(input);
  assert.equal(result.stop, 'interrupted');
  assert.equal(result.error?.code, 'cancelled');
  assert.deepEqual(requests('session/cancel')[0].params, { sessionId: 'sess_1' });
  await until(() => agent.state.replies.has(910));
  assert.deepEqual(agent.state.replies.get(910).result.outcome, { outcome: 'selected', optionId: 'yes' });
  await engine.dispose();
});

test('acp: a cancel the agent never confirms still ends the turn as interrupted', async () => {
  const controller = new AbortController();
  const { engine } = setup({ ignoreCancel: true, onPrompt: () => setImmediate(() => controller.abort()) }, { cancelGraceMs: 5 });
  const result = await engine.run(turnInput({ signal: controller.signal }).input);
  assert.equal(result.stop, 'interrupted');
  await engine.dispose();
});

test('acp: stopReason mapping and prompt errors (limit, sign-in, crash)', async () => {
  const cases: Array<[(t: FakeAcpTurn) => void, string, string | undefined, RegExp?]> = [
    [(t) => t.end('max_tokens'), 'error', 'internal', /length limit/],
    [(t) => t.end('refusal'), 'error', 'internal', /refused/],
    [(t) => t.end('max_turn_requests'), 'error', 'internal', /step limit/],
    [(t) => t.end('cancelled'), 'interrupted', 'cancelled'],
    [(t) => t.fail(-32603, 'Quota exceeded for this plan'), 'limit', 'rate_limited'],
    [(t) => t.fail(-32000, 'Authentication required'), 'error', 'unavailable', /^Fake Agent is not signed in for this account\.$/],
    [(t) => t.child.exit(1), 'error', 'unavailable', /stopped unexpectedly/],
  ];
  for (const [onPrompt, stop, code, message] of cases) {
    const { engine } = setup({ onPrompt });
    const result = await engine.run(turnInput().input);
    assert.equal(result.stop, stop, String(onPrompt));
    assert.equal(result.error?.code, code);
    if (message) assert.match(result.error!.message, message);
    await engine.dispose();
  }
});

test('acp: an auth error on session/new gives unavailable; checkAccount says needs_login', async () => {
  const { engine } = setup({ handle: (msg, reply) => (msg.method === 'session/new' ? (reply.error(-32000, 'Authentication required'), true) : false) });
  const result = await engine.run(turnInput().input);
  assert.equal(result.stop, 'error');
  assert.equal(result.error?.code, 'unavailable');
  assert.match(result.error!.message, /not signed in/);
  assert.deepEqual(await engine.checkAccount(account()), { state: 'needs_login', message: 'Sign in to Fake Agent.' });
  assert.deepEqual((await engine.listModels(account())).map((m) => m.model), ['default']);
  assert.deepEqual(await engine.authMethods(account()), [{ id: 'oauth', name: 'Sign in', description: undefined }]);
  assert.equal(await engine.authenticate(account()), true);
  assert.equal(await engine.authenticate(account(), 'unknown-method'), false);
  await engine.dispose();
});

test('acp: McpProxy against a real loopback hub – forwards bound keys, refuses browsers, unknown keys and GET', async () => {
  const seen: any[] = [];
  const hub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":7,"result":{}}'); });
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const port = (hub.address() as AddressInfo).port;
  const proxy = new McpProxy();
  try {
    const { key, url } = await proxy.endpoint();
    const post = (target: string, headers: Record<string, string> = {}) => fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"jsonrpc":"2.0","id":7,"method":"ping"}' });
    assert.equal((await post(url)).status, 401);
    proxy.bind(key, { url: `http://127.0.0.1:${port}/mcp/hubtoken_hubtoken_1`, token: 'hubtoken_hubtoken_1' });
    const ok = await post(url);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '{"jsonrpc":"2.0","id":7,"result":{}}');
    assert.deepEqual(seen[0], { url: '/mcp/hubtoken_hubtoken_1', auth: 'Bearer hubtoken_hubtoken_1', body: '{"jsonrpc":"2.0","id":7,"method":"ping"}' });
    assert.equal((await post(url, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await post(url.replace(key, 'x'.repeat(43)))).status, 401);
    proxy.bind(key, undefined);
    assert.equal((await post(url)).status, 401);
    assert.equal(seen.length, 1);
  } finally {
    proxy.close();
    hub.close();
  }
});
