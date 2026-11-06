// B-059 #79 (tools/builtin/agents-org.ts hireLabel): the hire approval card names the agent's first name when the call
// gives one; without one it says the hire gets a first name (picked only when the hire runs, org/hire.ts) instead of
// naming the template as if it were the agent ("Hire agent Researcher" → the agent then appears as "Mara").
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

function describeHire(args: Record<string, unknown>): string {
  const org = new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') });
  const manager = org.ensureSeed()!;
  const services = { org, modes: { list: () => [] } } as unknown as RuntimeServices;
  const ctx = { agent: manager, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext;
  return agentOrgTools.find((tool) => tool.name === 'agents.create')!.describe!(args as never, ctx).summary;
}

test('B-059 #79: a named hire shows its first name', () => {
  assert.match(describeHire({ template: 'researcher', name: 'Mara' }), /^Hire agent Mara \(/);
});

test('B-059 #79: a hire without a name says it gets a first name instead of naming the template as the agent', () => {
  const summary = describeHire({ template: 'researcher' });
  assert.match(summary, /^Hire a new Researcher \(.*gets a first name/);
  assert.doesNotMatch(summary, /Hire agent Researcher/);
  assert.match(describeHire({ role: 'Helper' }), /^Hire a new agent \(Helper, gets a first name\)/);
  assert.match(describeHire({ agents: [{ template: 'researcher', name: 'Mara' }, { template: 'writer' }] }), /^Hire 2 agents: Mara \(.*\), a new Writer \(.*gets a first name\)/);
});
