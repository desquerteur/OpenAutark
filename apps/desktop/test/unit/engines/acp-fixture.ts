// Shared setup for the ACP engine tests: an AcpEngine on the scripted agent (fakes.ts acpAgent)
// with a fixed launch, in-memory image reads and a recording fetch for the MCP proxy.
// Owns: nothing in production. Never imported by src/.

import assert from 'node:assert/strict';
import { AcpEngine } from '../../../src/runtime/engines/acp/engine.ts';
import { acpAgent, testSupervisor, tick, type FakeAcpOptions } from './fakes.ts';

export const OPTIONS = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

export function setup(options: FakeAcpOptions = {}, extra: Record<string, unknown> = {}) {
  const agent = acpAgent(options);
  const forwarded: any[] = [];
  const engine = new AcpEngine({
    supervisor: testSupervisor(agent.spawn), cwd: '/tmp/acp', version: '0.2.0',
    launch: async () => ({ name: 'Fake Agent', command: '/bin/fake-agent', args: ['--acp'], env: { FAKE_HOME: '/homes/a' }, projectSettings: 'ignored' as const }),
    readFile: async () => new Uint8Array([1, 2, 3]),
    fetch: async (url: string, init: RequestInit) => {
      forwarded.push({ url, init });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'm1' } });
    },
    ...extra,
  });
  const requests = (method: string) => agent.state.requests.filter((r: any) => r.method === method);
  return { agent, engine, forwarded, requests };
}

export const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await tick(); assert.ok(check(), 'condition not reached'); };

