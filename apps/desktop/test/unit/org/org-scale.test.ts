// Unit (O8): the 30-agent org of the org E2E (test/e2e/runtime-org.test.mjs) built with the real
// OrgService on an in-memory database – 3 spaces, 3 managers under the seed Manager, 26 reports
// (one leads a report of its own). Pins what the E2E reads through the runtime: tree depth and
// counts, the identity's report list (15 by name, then "and N more"), the setup facts' spaces and
// agents lines within the cap, and agents.list as a model gets it (all 30, below the file limit).
// Owns: these assertions only. Never: engines, network or the runtime process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { identityValues } from '../../../src/runtime/context/prompt-stable.ts';
import { SETUP_CAP, collectSetupFacts, renderSetupFacts } from '../../../src/runtime/context/setup-facts.ts';
import { MAX_TEXT_CHARS } from '../../../src/runtime/tools/outputs.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { Agent, OrgNode } from '../../../src/shared/model/org.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const ROLES = ['Researcher', 'Writer', 'Designer', 'Developer', 'Analyst', 'Support'];

/** The E2E's org, hired by the person: Acme 1 + 18, Studio 1 + 4 + 1 (a report of a report), Lab 1 + 3. */
function build() {
  const db = memoryDb();
  const org = new Org({ db, bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') });
  const seed = org.ensureSeed()!;
  const spaces = {
    Acme: org.saveSpace({ name: 'Acme', kind: 'company' }), Studio: org.saveSpace({ name: 'Studio', kind: 'brand' }), Lab: org.saveSpace({ name: 'Lab', kind: 'custom' }),
  };
  const hire = (name: string, role: string, managerId: string, space: keyof typeof spaces, mode?: string) =>
    org.create({ name, role, managerId, spaceId: spaces[space].id, mode, createdBy: HUMAN_ID });
  const lead = { Ada: hire('Ada', 'Acme lead', seed.id, 'Acme', 'manager'), Bea: hire('Bea', 'Studio lead', seed.id, 'Studio', 'manager'), Cy: hire('Cy', 'Lab lead', seed.id, 'Lab', 'manager') };
  const team = (prefix: string, count: number, managerId: string, space: keyof typeof spaces, pad: number) =>
    Array.from({ length: count }, (_, index) => hire(`${prefix} ${String(index + 1).padStart(pad, '0')}`, ROLES[index % ROLES.length], managerId, space));
  const acme = team('Acme agent', 18, lead.Ada.id, 'Acme', 2);
  const studio = team('Studio agent', 4, lead.Bea.id, 'Studio', 1);
  const deep = hire('Studio agent 5', 'Editor', studio[0].id, 'Studio');
  const lab = team('Lab agent', 3, lead.Cy.id, 'Lab', 1);
  const services = { db, org, settings: { get: () => ({ profile: { name: '', company: '', language: 'en', timezone: '' }, onboarding: { completed: false } }) } } as unknown as RuntimeServices;
  return { org, services, seed, lead, acme, studio, deep, lab };
}

const listed = (agents: Agent[]) => [...agents].sort((a, b) => a.name.localeCompare(b.name)).map((agent) => `${agent.name} (${agent.role})`);

test('30 agents: four levels under one root, reports per manager', () => {
  const { org, seed, lead, studio, deep } = build();
  assert.equal(org.list().length, 30);
  const levels: number[] = [];
  const walk = (nodes: OrgNode[], depth: number) => { for (const node of nodes) { levels[depth] = (levels[depth] ?? 0) + 1; walk(node.reports, depth + 1); } };
  const tree = org.tree();
  walk(tree, 0);
  assert.deepEqual(levels, [1, 3, 25, 1]);
  assert.equal(tree[0].agent.id, seed.id);
  const reports = (agent: Agent) => org.list().filter((item) => item.managerId === agent.id).length;
  assert.deepEqual([seed, lead.Ada, lead.Bea, lead.Cy, studio[0], deep].map(reports), [3, 18, 4, 3, 1, 0]);
});

test('identity: 15 reports by name, then "and N more"', () => {
  const { services, seed, lead, acme, studio, lab } = build();
  assert.equal(identityValues(services, lead.Ada).reports, `${listed(acme).slice(0, 15).join(', ')} and 3 more`);
  assert.equal(identityValues(services, lead.Bea).reports, listed(studio).join(', '));
  assert.equal(identityValues(services, lead.Cy).reports, listed(lab).join(', '));
  assert.equal(identityValues(services, seed).reports, 'Ada (Acme lead), Bea (Studio lead), Cy (Lab lead)');
  assert.equal(identityValues(services, lead.Bea).manager_name, 'Manager (Personal manager)');
  assert.equal(identityValues(services, seed).manager_name, '', 'the Manager reports to the person');
});

test('setup facts: spaces and agents per space with their managers, within the cap', () => {
  const { services } = build();
  const text = renderSetupFacts(collectSetupFacts(services));
  assert.ok(text.length <= SETUP_CAP, `${text.length} characters`);
  const lines = text.split('\n');
  assert.equal(lines[0], '## App status (live)');
  assert.ok(lines.includes('- Spaces: Acme (company), Studio (brand), Lab (custom)'), text);
  assert.ok(lines.includes('- Agents: 30 active – Acme 19 (manager Ada) · Studio 6 (managers Bea, Studio agent 1) · Lab 4 (manager Cy) · no space 1 (manager Manager)'), text);
});

test('agents.list gives a model all 30 agents, below the size where outputs move into a file', async () => {
  const { services, lead } = build();
  const tool = agentTools.find((item) => item.name === 'agents.list')!;
  const ctx = { agent: lead.Ada, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => {} } as ToolContext;
  const output = await tool.run({}, ctx);
  const text = output.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  const agents = JSON.parse(text) as Array<{ id: string; me?: boolean; space?: string }>;
  assert.equal(agents.length, 30);
  assert.deepEqual(agents.filter((agent) => agent.me).map((agent) => agent.id), [lead.Ada.id]);
  assert.equal(agents.filter((agent) => agent.space === 'Acme').length, 19);
  assert.ok(text.length < MAX_TEXT_CHARS, `${text.length} characters`);
});
