// Connector tools end to end with a fake host: every listed tool is offered in every mode (anyMode) with its read or
// write category, a call reaches the host with the MCP name, secret://<id> handles in the arguments are filled from
// the vault and masked in the answer, answers are marked untrusted, and failures are user-safe (unknown effect after a
// send without answer, the sign-in line, a turned-off connector).
// Owns: these assertions. Never: a real server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appToolDefs, appToolName } from '../../../src/runtime/apps/tools.ts';
import { NO_ANSWER } from '../../../src/runtime/apps/tools-result.ts';
import { McpTransportError, ReconnectNeeded, type AppToolHost, type Connector, type McpCallResult, type McpToolDef } from '../../../src/runtime/apps/types.ts';
import type { AppStatus } from '../../../src/shared/model/apps.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { agent } from '../chat/harness.ts';

const TOOLS: McpToolDef[] = [
  { name: 'search', title: 'Search', description: 'Search pages.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'create-page', description: 'Create a page.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
];

const connector: Connector = { id: 'notion', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true, fingerprint: 'f' };

function fakeHost(state: { status: AppStatus }, answer: (tool: string, args: Record<string, unknown>) => Promise<McpCallResult>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const host: AppToolHost = {
    state: (id) => (id === 'notion' ? { connector, status: state.status } : undefined),
    call: (_appId, tool, args) => { calls.push({ tool, args }); return answer(tool, args); },
  };
  return { host, calls };
}

const vault = new Map([['notion-key', 'sk-very-secret-1234']]);
const services = { secrets: { use: async (id: string) => { const value = vault.get(id); if (!value) throw new Error('missing'); return value; } } } as unknown as RuntimeServices;
const ctx = (signal = new AbortController().signal): ToolContext => ({ agent: agent('ag_tom', 'Tom'), runId: 'run_1', mode: 'research', services, signal, status() {} });
const byName = (defs: ToolDef[], mcp: string) => defs.find((def) => def.name === appToolName('notion', mcp))!;
const firstText = (output: { content: Array<{ type: string; text?: string }> }) => output.content.find((part) => part.type === 'text')?.text ?? '';

test('offer: one tool per listed MCP tool, in every mode, read or write by the read-only hint', () => {
  const { host } = fakeHost({ status: 'ok' }, async () => ({ content: [] }));
  const defs = appToolDefs(connector, TOOLS, host);
  assert.deepEqual(defs.map((def) => def.name), ['app.notion.search', 'app.notion.create-page']);
  assert.ok(defs.every((def) => def.anyMode));
  assert.equal(byName(defs, 'search').category, 'read');
  assert.equal(byName(defs, 'create-page').category, 'write_system');
  assert.equal(byName(defs, 'create-page').describe!({}, ctx()).external, true);
});

test('run: the answer is untrusted content; a handle is filled for the call and masked in what comes back', async () => {
  const { host, calls } = fakeHost({ status: 'ok' }, async (_tool, args) => ({ content: [{ type: 'text', text: `echo ${String(args.title)}` }] }));
  const output = await byName(appToolDefs(connector, TOOLS, host), 'create-page').run({ title: 'key secret://notion-key' }, ctx());
  assert.deepEqual(calls, [{ tool: 'create-page', args: { title: 'key sk-very-secret-1234' } }]);
  assert.match(firstText(output), /^\[untrusted content from app Notion/);
  assert.doesNotMatch(firstText(output), /sk-very-secret/);
  assert.match(firstText(output), /secret:\/\/notion-key/);
});

test('failures: no answer after sending is an unknown effect; a lost sign-in says how; a turned-off connector refuses', async () => {
  const state = { status: 'ok' as AppStatus };
  const { host } = fakeHost(state, async () => { throw new McpTransportError('timeout', true); });
  const write = byName(appToolDefs(connector, TOOLS, host), 'create-page');
  const lost = await write.run({ title: 'x' }, ctx());
  assert.equal(firstText(lost), NO_ANSWER);
  assert.equal(lost.effect?.status, 'unknown');
  const signIn = await byName(appToolDefs(connector, TOOLS, fakeHost(state, async () => { throw new ReconnectNeeded(); }).host), 'search').run({}, ctx());
  assert.match(firstText(signIn), /apps\.reconnect/);
  state.status = 'off';
  assert.match(firstText(await write.run({ title: 'x' }, ctx())), /turned off/);
});
