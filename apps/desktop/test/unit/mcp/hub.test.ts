import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mcp } from '../../../src/runtime/mcp/hub.ts';
import { McpToolNames, mcpWireName } from '../../../src/runtime/mcp/names.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput, ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const AGENT = { id: 'ag_tom', name: 'Tom', mode: 'general' } as Agent;
const SPECS: ToolSpec[] = [
  { name: 'human.ask', description: 'Ask the human.', inputSchema: { type: 'object', properties: { question: { type: 'string' } } } },
  { name: 'tasks.create', description: 'Create a task.', inputSchema: { properties: { title: { type: 'string' } } } },
];

type Call = { name: string; args: unknown; ctx: Omit<ToolContext, 'services'>; callId: string };

function setup(run: (call: Call) => Promise<ToolOutput> = async () => ({ content: [{ type: 'text', text: 'ok' }] }), specs: ToolSpec[] = SPECS) {
  const calls: Call[] = [];
  const specsFor: Array<{ agent: Agent; mode: ModeInfo; engine?: { ownTools: boolean; via: 'mcp' | 'native' } }> = [];
  const services = {
    log: new MemoryLogger(),
    host: { app: { version: '9.9.9' } },
    modes: { get: (key: string) => ({ key, name: key, description: '', skills: [], tools: ['*'], category: 'general', instructions: '' }) },
    tools: {
      specsFor: (agent: Agent, mode: ModeInfo, engine?: { ownTools: boolean; via: 'mcp' | 'native' }) => { specsFor.push({ agent, mode, engine }); return specs; },
      call: (name: string, args: unknown, ctx: Omit<ToolContext, 'services'>, callId: string) => { const call = { name, args, ctx, callId }; calls.push(call); return run(call); },
    },
  } as unknown as RuntimeServices;
  const hub = new Mcp({ services: () => services, baseUrl: () => 'http://127.0.0.1:4000/' });
  const lease = hub.lease({ agent: AGENT, runId: 'run_1', conversationId: 'ch_1', taskId: 'task_1', mode: 'video' });
  const rpc = (body: unknown, headers: Record<string, string | undefined> = {}, token: string | undefined = lease.token) => hub.handle(token, body, headers);
  return { hub, lease, calls, specsFor, rpc };
}

test('lease: random 32-byte base64url token, per-lease url; url() is the shared endpoint', () => {
  const { hub, lease } = setup();
  assert.match(lease.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(lease.url, `http://127.0.0.1:4000/mcp/${lease.token}`);
  assert.equal(hub.url(), 'http://127.0.0.1:4000/mcp');
  const other = hub.lease({ agent: AGENT, runId: 'run_2', mode: 'general' });
  assert.notEqual(other.token, lease.token);
  assert.equal(hub.active(), 2);
});

test('initialize echoes supported protocol versions, falls back to 2025-06-18, returns a session id', async () => {
  const { rpc } = setup();
  for (const version of ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']) {
    const reply = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'claude-code', version: '3' } } });
    assert.equal(reply.status, 200);
    const result = (reply.body as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string; version: string } } }).result;
    assert.equal(result.protocolVersion, version);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(result.serverInfo, { name: 'workforce', version: '9.9.9' });
    assert.match(reply.headers!['Mcp-Session-Id'], /^[A-Za-z0-9_-]{16,}$/);
  }
  const old = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal((old.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
  const ping = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(ping.body, { jsonrpc: '2.0', id: 3, result: {} });
});

test('tools/list: the agent\'s tools for its mode via MCP, under MCP-safe wire names', async () => {
  const { rpc, specsFor } = setup();
  const reply = await rpc({ jsonrpc: '2.0', id: 'a', method: 'tools/list', params: {} });
  const tools = (reply.body as { result: { tools: Array<{ name: string; title: string; inputSchema: Record<string, unknown> }> } }).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['human__ask', 'tasks__create']);
  assert.equal(tools[1].title, 'tasks.create');
  assert.equal(tools[1].inputSchema.type, 'object', 'top-level schemas are objects');
  for (const tool of tools) assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(specsFor[0].agent.id, 'ag_tom');
  assert.equal(specsFor[0].mode.key, 'video');
  assert.deepEqual(specsFor[0].engine, { ownTools: true, via: 'mcp' });
});

test('tools/call maps the wire name back and calls the registry with the lease context', async () => {
  const { rpc, calls } = setup(async (call) => (call.name === 'tasks.create'
    ? { content: [{ type: 'text', text: '{"id":"task_9"}' }, { type: 'image', mime: 'image/png', dataBase64: 'iVBO' }], structured: { id: 'task_9' } }
    : { content: [{ type: 'text', text: '{"behavior":"allow","updatedInput":{}}' }] }));
  const reply = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'tasks__create', arguments: { title: 'Cut the intro' } } });
  assert.deepEqual(reply.body, {
    jsonrpc: '2.0', id: 7,
    result: { content: [{ type: 'text', text: '{"id":"task_9"}' }, { type: 'image', data: 'iVBO', mimeType: 'image/png' }], isError: false, structuredContent: { id: 'task_9' } },
  });
  const call = calls[0];
  assert.equal(call.name, 'tasks.create');
  assert.deepEqual(call.args, { title: 'Cut the intro' });
  assert.equal(call.callId, 'mcp-1');
  assert.equal(call.ctx.agent.id, 'ag_tom');
  assert.equal(call.ctx.runId, 'run_1');
  assert.equal(call.ctx.conversationId, 'ch_1');
  assert.equal(call.ctx.taskId, 'task_1');
  assert.equal(call.ctx.mode, 'video');
  assert.equal(call.ctx.signal.aborted, false);
  assert.equal(typeof call.ctx.status, 'function');
  // The fully qualified form (mcp__workforce__<wire>).
  await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'mcp__workforce__human__ask' } });
  assert.deepEqual(calls.slice(1).map((item) => [item.name, item.callId]), [['human.ask', 'mcp-2']]);
  assert.deepEqual(calls[1].args, {});
});

test('tool failures are results; unknown tools, methods and bad params are JSON-RPC errors', async () => {
  const { rpc } = setup(async () => { throw new Error('secret internals'); });
  const failed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'human__ask', arguments: {} } });
  const result = (failed.body as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /secret internals/);
  const unknown = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shell__run' } });
  assert.equal((unknown.body as { error: { code: number } }).error.code, -32602);
  const badArgs = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'human__ask', arguments: 'x' } });
  assert.equal((badArgs.body as { error: { code: number } }).error.code, -32602);
  const badParams = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: [1] });
  assert.equal((badParams.body as { error: { code: number } }).error.code, -32602);
  const method = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/subscribe' });
  assert.equal((method.body as { error: { code: number } }).error.code, -32601);
  const invalid = await rpc({ id: 6, method: 'ping' });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { error: { code: number } }).error.code, -32600);
  const parse = await rpc('{not json');
  assert.equal(parse.status, 400);
  assert.equal((parse.body as { error: { code: number } }).error.code, -32700);
});

test('B-044: no resources – the secret area resources are gone, resources/* are unknown methods and run no tool', async () => {
  const f = setup();
  for (const [id, method] of [[1, 'resources/list'], [2, 'resources/templates/list'], [3, 'resources/read']] as const) {
    const reply = await f.rpc({ jsonrpc: '2.0', id, method, params: { uri: 'workforce://secrets/' } });
    assert.equal((reply.body as { error: { code: number } }).error.code, -32601, method);
  }
  assert.equal(f.calls.length, 0);
});

test('notifications and client responses get 202 without a body', async () => {
  const { rpc } = setup();
  const initialized = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual([initialized.status, initialized.body], [202, undefined]);
  const response = await rpc({ jsonrpc: '2.0', id: 'srv-1', result: {} });
  assert.equal(response.status, 202);
  const both = await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/progress', params: {} }]);
  assert.deepEqual([both.status, both.body], [202, undefined]);
});

test('batches: replies in order, notifications omitted; empty batch is rejected', async () => {
  const { rpc } = setup();
  const reply = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    42,
  ]);
  assert.equal(reply.status, 200);
  const body = reply.body as Array<{ id: number | null; result?: unknown; error?: { code: number } }>;
  assert.deepEqual(body.map((item) => item.id), [1, 2, null]);
  assert.equal(body[2].error!.code, -32600);
  const empty = await rpc([]);
  assert.equal(empty.status, 400);
});

test('tokens: unknown → 401, Bearer header works for POST /mcp, released → 401', async () => {
  const { hub, rpc, lease } = setup();
  const bad = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, 'nope');
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.body, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown or expired token.' } });
  const missing = await hub.handle(undefined, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(missing.status, 401);
  const viaHeader = await hub.handle(undefined, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: `Bearer ${lease.token}` });
  assert.equal(viaHeader.status, 200);
  lease.release();
  lease.release(); // idempotent
  const released = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(released.status, 401);
});

test('release aborts in-flight calls; notifications/cancelled aborts one call', async () => {
  const { rpc, lease, calls } = setup((call) => new Promise<ToolOutput>((resolve) => {
    call.ctx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'stopped' }], isError: true }), { once: true });
  }));
  const first = rpc({ jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'human__ask', arguments: {} } });
  const second = rpc({ jsonrpc: '2.0', id: 'c2', method: 'tools/call', params: { name: 'human__ask', arguments: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const cancelled = await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c1', reason: 'user' } });
  assert.equal(cancelled.status, 202);
  assert.equal(calls[0].ctx.signal.aborted, true);
  assert.equal(calls[1].ctx.signal.aborted, false);
  assert.equal(((await first).body as { result: { isError: boolean } }).result.isError, true);
  lease.release();
  assert.equal(calls[1].ctx.signal.aborted, true);
  assert.equal(((await second).body as { result: { content: Array<{ text: string }> } }).result.content[0].text, 'stopped');
});

test('transport checks: unsupported MCP-Protocol-Version → 400, foreign Origin → 403', async () => {
  const { rpc } = setup();
  const version = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2023-01-01' });
  assert.equal(version.status, 400);
  const ok = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18', origin: 'http://127.0.0.1:4000' });
  assert.equal(ok.status, 200);
  const foreign = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
});

test('wire names: dotted → double underscore, aliases resolve', () => {
  assert.equal(mcpWireName('tasks.create'), 'tasks__create');
  const names = new McpToolNames(SPECS);
  assert.equal(names.resolve('human.ask'), 'human.ask');
  assert.equal(names.resolve('mcp__workforce__tasks__create'), 'tasks.create');
  assert.equal(names.resolve('agents__create'), undefined);
});

test('initialize negotiates even when the client sends an unknown MCP-Protocol-Version header', async () => {
  const { rpc } = setup();
  const reply = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2027-01-01' } }, { 'mcp-protocol-version': '2027-01-01' });
  assert.equal(reply.status, 200);
  assert.equal((reply.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
});

test('close() aborts in-flight calls and rejects every token afterwards', async () => {
  const { hub, rpc, calls } = setup((call) => new Promise<ToolOutput>((resolve) => {
    call.ctx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'stopped' }], isError: true }), { once: true });
  }));
  const pending = rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'human__ask', arguments: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  hub.close();
  assert.equal(calls[0].ctx.signal.aborted, true);
  assert.equal(((await pending).body as { result: { isError: boolean } }).result.isError, true);
  assert.equal(hub.active(), 0);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })).status, 401);
});
