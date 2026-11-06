// B-052 track A: the MCP client against our own MCP hub (runtime/mcp/hub.ts handle() behind a node:http server on
// 127.0.0.1 with a fake RuntimeServices) – two independent implementations of the same protocol must agree: the
// handshake with a session id, tools/list with wire names, tools/call reaching the registry with the lease
// context, the Bearer token from target.headers(), and 401 → McpAuthRequired for an unknown or released lease.
// Owns: that cross-check only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connectMcp } from '../../../src/runtime/apps/client/index.ts';
import { McpAuthRequired } from '../../../src/runtime/apps/types.ts';
import { Mcp } from '../../../src/runtime/mcp/hub.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const SPECS: ToolSpec[] = [
  { name: 'human.ask', description: 'Ask the human.', inputSchema: { type: 'object', properties: { question: { type: 'string' } } } },
  { name: 'tasks.create', description: 'Create a task.', inputSchema: { properties: { title: { type: 'string' } } } },
];

test('our client and our hub agree: handshake, tools, a call with the lease context, 401 after release', async () => {
  const calls: Array<{ name: string; args: unknown; runId: unknown }> = [];
  const services = {
    log: new MemoryLogger(),
    host: { app: { version: '9.9.9' } },
    modes: { get: (key: string) => ({ key, name: key, description: '', skills: [], tools: ['*'], category: 'general', instructions: '' }) },
    tools: {
      specsFor: () => SPECS,
      call: async (name: string, args: unknown, ctx: { runId?: string }) => {
        calls.push({ name, args, runId: ctx.runId });
        return { content: [{ type: 'text', text: '{"id":"task_9"}' }], structured: { id: 'task_9' } };
      },
    },
  } as unknown as RuntimeServices;
  let base = '';
  const hub = new Mcp({ services: () => services, baseUrl: () => base });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      void hub.handle(undefined, text || undefined, req.headers as Record<string, string | undefined>).then((reply) => {
        res.writeHead(reply.status, reply.headers ?? {});
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const lease = hub.lease({ agent: { id: 'ag_1', name: 'Ann', mode: 'general' } as Agent, runId: 'run_7', mode: 'general' });
    const target = { kind: 'http' as const, url: `${base}/mcp`, headers: async () => ({ Authorization: `Bearer ${lease.token}` }) };
    const connection = await connectMcp(target, { clientInfo: { name: 'workforce', version: '0.2.0' } });
    assert.deepEqual(connection.info, { protocolVersion: '2025-11-25', name: 'workforce', version: '9.9.9' });
    const tools = await connection.listTools();
    assert.deepEqual(tools.map((tool) => [tool.name, tool.title]), [['human__ask', 'human.ask'], ['tasks__create', 'tasks.create']]);
    assert.equal(tools[1].inputSchema.type, 'object');
    const result = await connection.callTool('tasks__create', { title: 'Write the report' });
    assert.deepEqual(result, { content: [{ type: 'text', text: '{"id":"task_9"}' }], isError: false, structuredContent: { id: 'task_9' } });
    assert.deepEqual(calls, [{ name: 'tasks.create', args: { title: 'Write the report' }, runId: 'run_7' }]);

    lease.release();
    const after = await connection.listTools().catch((caught: unknown) => caught);
    assert.ok(after instanceof McpAuthRequired);
    assert.equal(after.status, 401);
    await connection.close();
    const stranger = await connectMcp({ kind: 'http', url: `${base}/mcp` }, { clientInfo: { name: 'x', version: '1' } }).catch((caught: unknown) => caught);
    assert.ok(stranger instanceof McpAuthRequired);
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  }
});
