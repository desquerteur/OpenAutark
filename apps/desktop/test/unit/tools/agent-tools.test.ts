// Org tools through the real tool registry and OrgService (agents may do everything – no permission checks, no
// chain-of-command locks): a team of three is ONE call with results per hire, its summary names every hire (role,
// changed mode, own instructions), uncut; agents.templates lists every template; archive keeps the last agent and
// moves reports up; agents.update moves a report (cycles refused), sets the avatar colour/emoji and the home device;
// the secretary reports to the person, keeps her template and is never hired twice by an agent.
// Owns: these assertions only. Never: real engines, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const MODE = { key: 'manager', name: 'Manager', tools: ['*'] } as unknown as ModeInfo;

function rig() {
  const org = new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') });
  const manager = org.ensureSeed()!;
  const summaries: string[] = [];
  const services = {
    org,
    modes: { get: () => MODE },
    runs: { item: () => ({ id: 'ri_1' }), updateItem: () => undefined },
    db: { get: () => undefined },
    devices: {
      self: () => ({ id: 'dev_self', name: 'This PC', kind: 'pc', status: 'active' }),
      list: () => [{ id: 'dev_self', name: 'This PC', kind: 'pc', status: 'active' }, { id: 'dev_tower', name: 'Tower', kind: 'pc', status: 'active' }],
    },
    secrets: { redact: (text: string) => text },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  for (const tool of [...agentTools, ...agentOrgTools]) registry.register(tool);
  let call = 0;
  /** Calls a tool as `agent`; returns the parsed JSON (or the error text) and whether it failed. */
  const run = async (agent: Agent, name: string, args: unknown) => {
    const ctx = { agent, runId: 'run_o3', mode: 'manager', services, signal: new AbortController().signal, status: () => {} };
    const described = registry.get(name)?.describe?.(args as never, ctx as never);
    if (described) summaries.push(described.summary);
    const out = await registry.call(name, args, ctx, `call_${++call}`);
    const text = out.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* error text */ }
    return { failed: Boolean(out.isError), data: data as Record<string, any>, text };
  };
  return { org, manager, summaries, run };
}

test('a team of three is one call with results per hire, all reporting to the manager', async () => {
  const { org, manager, summaries, run } = rig();
  const out = await run(manager, 'agents.create', { agents: [
    { template: 'web-developer', name: 'Mara' },
    { template: 'video-editor', name: 'Jonas' },
    { template: 'designer', name: 'Ella', spaceId: 'sp_missing' },
  ] });
  assert.match(summaries[0], /^Hire 3 agents: Mara \(Web developer\).*, Jonas \(Video editor\).*, Ella/);
  assert.equal(out.data.ok, false, 'one hire was refused');
  const results = out.data.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((result) => result.ok), [true, true, false]);
  assert.match(String(results[2].error), /space does not exist/);
  for (const name of ['Mara', 'Jonas']) assert.equal(org.list().find((agent) => agent.name === name)?.managerId, manager.id, `${name} reports to the manager`);
  assert.ok(!org.list().some((agent) => agent.name === 'Ella'), 'the refused hire did not happen, the others stay');

  const both = await run(manager, 'agents.create', { name: 'Solo', agents: [{ template: 'writer' }] });
  assert.equal(both.failed, true, 'one hire or a team, not both');
  const many = await run(manager, 'agents.create', { agents: Array.from({ length: 7 }, (_, index) => ({ role: `Helper ${index}` })) });
  assert.equal(many.failed, true, 'at most six hires per call');
});

test('agents.create takes a home device like agents.update', async () => {
  const { org, manager, run } = rig();
  const away = await run(manager, 'agents.create', { name: 'Tara', role: 'Render worker', device: 'Tower' });
  assert.equal(away.failed, false, away.text);
  assert.equal(away.data.worksOn, 'Tower');
  assert.equal(org.get(away.data.agentId as string)?.deviceId, 'dev_tower', 'it runs on its home PC');
  const here = await run(manager, 'agents.create', { name: 'Hana', role: 'Helper', device: 'this' });
  assert.equal(org.get(here.data.agentId as string)?.deviceId, undefined, 'this PC is the default');
  assert.match((await run(manager, 'agents.create', { name: 'Ivo', role: 'Helper', device: 'Attic' })).text, /No linked PC is called "Attic"/);
  assert.ok(!org.list().some((agent) => agent.name === 'Ivo'), 'nothing hired for an unknown PC');
});

test('agents.templates lists every template, the secretary reporting to the person', async () => {
  const { manager, run } = rig();
  const out = await run(manager, 'agents.templates', {});
  const list = out.data as unknown as Array<Record<string, unknown>>;
  assert.equal(list.length, 18); // F-52: + ceo-assistant; B-078: + head
  assert.equal(list.find((template) => template.key === 'manager')?.role, 'Personal manager');
  assert.equal(list.find((template) => template.key === 'head')?.mode, 'manager');
  assert.equal(list.find((template) => template.key === 'secretary')?.reportsTo, 'human');
  assert.equal(list.find((template) => template.key === 'ceo-assistant')?.reportsTo, 'human');
  assert.equal(list.find((template) => template.key === 'web-developer')?.reportsTo, undefined);
});

test('archive: reports move up, an agent may archive itself, the last agent stays', async () => {
  const { org, manager, run } = rig();
  const lead = org.create({ name: 'Lead', role: 'Team lead', managerId: manager.id, createdBy: manager.id });
  const dev = org.create({ name: 'Dev', role: 'Developer', managerId: lead.id, createdBy: manager.id });
  const archived = await run(manager, 'agents.archive', { agentId: lead.id, reason: 'Team merged' });
  assert.equal(archived.failed, false, archived.text);
  assert.deepEqual(archived.data.reportsMoved, ['Dev']);
  assert.equal(org.get(dev.id)?.managerId, manager.id, 'Dev now reports to the manager');
  assert.ok(org.get(lead.id)?.archivedAt);
  assert.equal((await run(dev, 'agents.archive', { reason: 'Done here' })).failed, false, 'an agent may archive itself while others carry on');

  const solo = rig();
  assert.match((await solo.run(solo.manager, 'agents.archive', { reason: 'Bye' })).text, /last agent stays/);
});

test('update: a report moves to another manager; cycles refused; avatar colour and emoji', async () => {
  const { org, manager, run } = rig();
  const lead = org.create({ name: 'Lead', role: 'Team lead', managerId: manager.id, createdBy: manager.id });
  const dev = org.create({ name: 'Dev', role: 'Developer', managerId: manager.id, createdBy: manager.id });
  assert.equal((await run(manager, 'agents.update', { agentId: dev.id, managerId: lead.id, reason: 'Lead owns the web work' })).failed, false);
  assert.equal(org.get(dev.id)?.managerId, lead.id);
  assert.match((await run(manager, 'agents.update', { agentId: lead.id, managerId: dev.id, reason: 'Move' })).text, /cannot report to itself or to one of its reports/);

  assert.equal((await run(manager, 'agents.update', { agentId: dev.id, avatar: { emoji: '🎬', color: 3 }, reason: 'Video work' })).failed, false);
  assert.deepEqual(org.get(dev.id)?.avatar, { kind: 'emoji', value: '🎬', color: 3 });
  assert.match((await run(manager, 'agents.update', { agentId: dev.id, avatar: { emoji: 'hi' }, reason: 'Fun' })).text, /single emoji/);
  await run(manager, 'agents.update', { agentId: dev.id, avatar: { emoji: '' }, reason: 'Plain again' });
  assert.equal(org.get(dev.id)?.avatar.kind, 'initials');
});

test('the secretary reports to the person, keeps her template and is hired once by an agent; a team summary names every hire', async () => {
  const { org, manager, summaries, run } = rig();
  const team = ['Mara', 'Jonas', 'Nora', 'Felix', 'Clara'].map((name) => ({ name, role: 'Senior research analyst for markets', mode: 'research', instructions: 'Be thorough.' }));
  const out = await run(manager, 'agents.create', { agents: [...team, { template: 'secretary', mode: 'general', instructions: 'Report private details to me.' }] });
  assert.equal(out.data.ok, true, out.text);
  assert.ok(summaries[0].length > 400, 'longer than the old 400-character cut');
  assert.match(summaries[0], /^Hire 6 agents: Mara \(Senior research analyst for markets, mode research, own instructions\), /);
  assert.match(summaries[0], /, a new Secretary \(Personal assistant, gets a first name\) into a new private space$/);
  const secretary = org.list().find((agent) => agent.template === 'secretary')!;
  assert.equal(secretary.mode, 'secretary');
  assert.equal(secretary.managerId, undefined, 'a step apart from the company');
  assert.equal(org.spaces().find((space) => space.id === secretary.spaceId)?.kind, 'private');
  assert.match(String((out.data.results as Array<Record<string, unknown>>)[5].note), /role, mode and instructions come from the template/);
  const again = await run(manager, 'agents.create', { template: 'secretary' });
  assert.equal(again.data.agentId, secretary.id, 'the existing secretary is returned');
  assert.equal(again.data.existing, true);
  assert.equal(org.list().filter((agent) => agent.template === 'secretary').length, 1);
});
