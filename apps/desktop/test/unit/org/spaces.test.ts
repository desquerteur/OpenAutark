// Spaces (P05: company / personal brand / private life): created on demand when the first agent
// of an area is hired, never for the seed Manager, never revived after archiving; the space
// tools for managers (rename keeps the kind), where agents.create places a hire (second company,
// private spaces only from inside), no space for the app customization Builder, and agents whose
// space was archived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import { spaceTools } from '../../../src/runtime/tools/builtin/spaces.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { clock, memoryDb, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';

function setup(templatesDir = path.join(RESOURCES, 'agents')) {
  const recorder = recordingBus();
  const time = clock();
  const db = memoryDb();
  const settings = new SettingsStore({ db, bus: recorder.bus, clock: time, env: { locale: 'en-US', timezone: 'UTC' } });
  const org = new Org({ db, bus: recorder.bus, clock: time, templatesDir, companyName: () => settings.get().profile.company });
  const services = { org, settings } as unknown as RuntimeServices;
  return { org, settings, services, ...recorder };
}

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;
const tool = (name: string) => [...agentTools, ...agentOrgTools, ...spaceTools].find((entry) => entry.name === name)!;
const MODE = { key: 'general', name: 'General', description: '', skills: [], tools: ['*'], category: 'chat', instructions: '' } as ModeInfo;

function ctxFor(services: RuntimeServices, agent: Agent): ToolContext {
  return { agent, runId: 'run_test', mode: agent.mode, services, signal: new AbortController().signal, status: () => undefined };
}

async function call(services: RuntimeServices, agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  return tool(name).run(args, ctxFor(services, agent));
}

test('the seed Manager has no space and creates none', () => {
  const { org, of } = setup();
  const manager = org.ensureSeed()!;
  assert.equal(manager.spaceId, undefined);
  assert.equal(org.template('manager')?.spaceKind, undefined, 'manager.md has no spaceKind');
  assert.deepEqual(org.spaces(), []);
  assert.equal(of('space.upserted').length, 0);
});

test('hiring the secretary creates exactly one Private space, reused by later private hires', () => {
  const { org, of } = setup();
  org.ensureSeed();
  const secretary = org.create({ template: 'secretary', createdBy: 'human' });
  const spaces = org.spaces();
  assert.equal(spaces.length, 1);
  assert.deepEqual([spaces[0].name, spaces[0].kind], ['Private', 'private']);
  assert.equal(secretary.spaceId, spaces[0].id);
  const second = org.create({ template: 'secretary', createdBy: 'human' });
  assert.equal(second.spaceId, spaces[0].id);
  assert.equal(org.spaces().length, 1);
  assert.deepEqual(of('space.upserted').map((space) => (space as { name: string }).name), ['Private']);
});

test('area names: company from the profile (else "Company"), brand "Personal brand"; explicit spaceId wins', () => {
  const plain = setup();
  const first = plain.org.create({ template: 'operations', createdBy: 'human' });
  assert.equal(plain.org.spaces().find((space) => space.id === first.spaceId)?.name, 'Company');

  const { org, settings } = setup();
  settings.update({ profile: { company: '  Teydra   Lab ' } });
  const ops = org.create({ template: 'operations', createdBy: 'human' });
  const editor = org.create({ template: 'video-editor', createdBy: 'human' });
  const byId = new Map(org.spaces().map((space) => [space.id, space]));
  assert.deepEqual([byId.get(ops.spaceId!)?.name, byId.get(ops.spaceId!)?.kind], ['Teydra Lab', 'company']);
  assert.deepEqual([byId.get(editor.spaceId!)?.name, byId.get(editor.spaceId!)?.kind], ['Personal brand', 'brand']);
  const lab = org.saveSpace({ name: 'Lab', kind: 'custom' });
  assert.equal(org.create({ template: 'secretary', spaceId: lab.id, createdBy: 'human' }).spaceId, lab.id);
  assert.equal(org.spaces().some((space) => space.kind === 'private'), false, 'no Private space when a space is given');
});

test('a refused hire leaves no space behind; custom template areas are never created', () => {
  const { org } = setup();
  assert.throws(() => org.create({ template: 'secretary', mode: 'Bad Mode', createdBy: 'human' }), code('bad_request'));
  assert.throws(() => org.create({ template: 'secretary', spaceId: 'sp_missing', createdBy: 'human' }), code('not_found'));
  assert.deepEqual(org.spaces(), []);

  const dir = tempDir();
  try {
    writeFileSync(path.join(dir.dir, 'lab-tech.md'), '---\nname: Lab tech\nrole: Lab tech\nmode: general\nspaceKind: custom\n---\nRuns the lab.\n');
    const custom = setup(dir.dir);
    assert.equal(custom.org.create({ template: 'lab-tech', createdBy: 'human' }).spaceId, undefined);
    assert.deepEqual(custom.org.spaces(), []);
  } finally {
    dir.cleanup();
  }
});

test('archiving a space keeps its agents; the next hire of that kind gets a new space, the old stays archived', () => {
  const { org } = setup();
  const secretary = org.create({ template: 'secretary', createdBy: 'human' });
  const old = secretary.spaceId!;
  org.archiveSpace(old);
  assert.equal(org.get(secretary.id)?.archivedAt, undefined, 'agents are never archived with their space');
  assert.equal(org.get(secretary.id)?.spaceId, old);
  const next = org.create({ template: 'secretary', createdBy: 'human' });
  assert.notEqual(next.spaceId, old);
  assert.deepEqual(org.spaces().map((space) => [space.name, space.kind]), [['Private', 'private']]);
  assert.ok(org.saveSpace({ id: old, name: 'Old private' }).archivedAt, 'renaming does not revive');
});

test('agents.create: a template area wins over the manager\'s space; without one the hire joins it', async () => {
  const { org, services } = setup();
  const manager = org.ensureSeed()!;
  const company = org.saveSpace({ name: 'Teydra', kind: 'company' });
  const lead = org.update(manager.id, { spaceId: company.id });

  const hired = await call(services, lead, 'agents.create', { template: 'secretary' });
  assert.equal(hired.isError, undefined);
  const secretary = org.get((hired.structured as { agentId: string }).agentId)!;
  const privateSpace = org.spaces().find((space) => space.kind === 'private')!;
  assert.equal(secretary.spaceId, privateSpace.id, 'a secretary hired by a company manager lands in Private');
  assert.equal(secretary.managerId, undefined, 'the secretary reports to the person, not to the hiring manager (O3)');
  assert.equal((hired.structured as { space: string }).space, 'Private');

  const helper = await call(services, lead, 'agents.create', { role: 'Assistant' });
  assert.equal(org.get((helper.structured as { agentId: string }).agentId)?.spaceId, company.id, 'no template area: the manager\'s space');

  const listed = (await call(services, lead, 'agents.list', {})).structured as Array<{ id: string; spaceId?: string; space?: string }>;
  assert.deepEqual(listed.find((entry) => entry.id === secretary.id), { ...listed.find((entry) => entry.id === secretary.id), spaceId: privateSpace.id, space: 'Private' });
  assert.equal(listed.find((entry) => entry.id === manager.id)?.space, 'Teydra');
});

test('spaces.save is open to every agent; spaces.list reads areas with agent counts', async () => {
  const { org, services } = setup();
  const manager = org.ensureSeed()!;
  const secretary = org.create({ template: 'secretary', createdBy: 'human' });
  const registry = new Registry({ services: () => services });
  for (const entry of spaceTools) registry.register(entry);
  const save = registry.get('spaces.save')!;
  const list = registry.get('spaces.list')!;
  assert.equal(registry.allowed(save, manager, MODE), true);
  assert.equal(registry.allowed(save, secretary, MODE), true, 'any agent may save spaces');
  assert.equal(registry.allowed(list, secretary, MODE), true);
  assert.deepEqual(registry.specsFor(secretary, MODE).map((spec) => spec.name), ['spaces.list', 'spaces.save']);

  const created = await call(services, manager, 'spaces.save', { name: 'Podcast', kind: 'custom' });
  const spaceId = (created.structured as { spaceId: string }).spaceId;
  await call(services, manager, 'spaces.save', { id: spaceId, name: 'Podcast studio' });
  assert.equal(org.spaces().find((space) => space.id === spaceId)?.name, 'Podcast studio');
  assert.equal((await call(services, manager, 'spaces.save', { id: 'sp_missing', name: 'X' })).isError, true);

  const areas = (await call(services, secretary, 'spaces.list', {})).structured as Array<{ name: string; kind: string; agents: number; yours?: boolean }>;
  assert.deepEqual(areas.map((area) => [area.name, area.kind, area.agents, area.yours ?? false]), [
    ['Private', 'private', 1, true], ['Podcast studio', 'custom', 0, false],
  ]);
});

test('spaces.save renames only: a kind change is refused, the approval names the space, archived spaces stay as they are', async () => {
  const { org, services } = setup();
  const manager = org.ensureSeed()!;
  const secretary = org.create({ template: 'secretary', createdBy: 'human' });
  const privateId = secretary.spaceId!;
  const describe = (args: Record<string, unknown>) => tool('spaces.save').describe!(args, ctxFor(services, manager)).summary;
  assert.equal(describe({ id: privateId, name: 'Home' }), 'Rename space "Private" to "Home"');
  assert.equal(describe({ name: 'Podcast', kind: 'custom' }), 'Create custom space "Podcast"');

  const turned = await call(services, manager, 'spaces.save', { id: privateId, name: 'Private', kind: 'company' });
  assert.equal(turned.isError, true, 'a "rename" never turns the private space into a company space');
  assert.equal(org.spaces().find((space) => space.id === privateId)?.kind, 'private');
  const ops = org.create({ template: 'operations', createdBy: 'human' });
  assert.notEqual(ops.spaceId, privateId, 'company hires never land in the private space');
  assert.equal((await call(services, manager, 'spaces.save', { id: privateId, name: 'Home', kind: 'private' })).isError, undefined, 'same kind is a plain rename');

  org.archiveSpace(ops.spaceId!);
  assert.equal((await call(services, manager, 'spaces.save', { id: ops.spaceId, name: 'Back' })).isError, true);
});

test('agents.create: a manager keeps same-kind hires in its own space (second company); the new manager\'s space counts', async () => {
  const { org, services } = setup();
  const manager = org.ensureSeed()!;
  const first = org.saveSpace({ name: 'Company A', kind: 'company' });
  const second = org.saveSpace({ name: 'Company B', kind: 'company' });
  const leadB = org.create({ name: 'Lead B', mode: 'manager', spaceId: second.id, createdBy: manager.id });
  const hire = async (as: Agent, args: Record<string, unknown>) => {
    const out = await call(services, as, 'agents.create', args);
    assert.equal(out.isError, undefined, JSON.stringify(out.content));
    return org.get((out.structured as { agentId: string }).agentId)!;
  };
  assert.equal((await hire(leadB, { template: 'operations' })).spaceId, second.id, 'company B keeps its hire');
  assert.equal((await hire(manager, { template: 'operations', managerId: leadB.id })).spaceId, second.id, 'the new manager\'s space, not the hiring agent\'s');
  assert.equal((await hire(manager, { template: 'operations' })).spaceId, first.id, 'the space-less Manager: first company');
  assert.equal((await hire(manager, { role: 'Assistant', managerId: leadB.id })).spaceId, second.id, 'no template: the new manager\'s space');
  assert.equal(org.create({ template: 'operations', managerId: leadB.id, createdBy: 'human' }).spaceId, second.id, 'a human hire into company B stays there');
  assert.equal(org.create({ template: 'operations', createdBy: 'human' }).spaceId, first.id, 'without a manager: the first company');
  const secretary = await hire(leadB, { template: 'secretary' });
  assert.equal(org.spaces().find((space) => space.id === secretary.spaceId)?.kind, 'private', 'another kind: the template area wins');
  const summary = tool('agents.create').describe!({ name: 'Ann', template: 'operations' }, ctxFor(services, leadB)).summary;
  assert.equal(summary, 'Hire agent Ann (Operations manager) into Company B');
});

test('an agent whose space was archived keeps its id; no space is created or revived; a new hire into it is refused', () => {
  const { org } = setup();
  const secretary = org.create({ template: 'secretary', createdBy: 'human' });
  const old = secretary.spaceId!;
  org.archiveSpace(old);
  assert.equal(org.get(secretary.id)?.spaceId, old);
  assert.deepEqual(org.spaces(), [], 'no space is created or revived');
  assert.throws(() => org.create({ role: 'X', spaceId: old, createdBy: 'human' }), code('conflict'), 'a pick of the archived space is refused');
});
