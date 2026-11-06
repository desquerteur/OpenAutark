// B-047 (contract D9) hiring as colleagues: agents.create refuses a role, template or numbered label as a
// name (per hire, so the rest of a team still happens), a hire without a name gets a free human first name,
// and every result returns the new agent's standard SYSTEM.md (path when the agent core is wired, the text)
// and – B-078 – one line that this part is the new agent's own and how I start them (a first line or task).
// first-names.ts: the person-name check and the free-name pick.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { standingRuleValues } from '../../../src/runtime/org/hire.ts';
import { FIRST_NAMES, freeFirstName, personNameProblem } from '../../../src/runtime/org/first-names.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
settings.profile.name = 'Ada';
const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));

function setup(core = true) {
  const standingRules = (values?: Readonly<Record<string, string>>) => prompts.renderText('agent-default', { ...standingRuleValues(settings), ...values });
  const org = new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents'), standingRules });
  const agentCore = core ? { folder: (id: string) => path.join('/data', 'agents', id) } : undefined;
  const services = { org, settings: { get: () => settings }, modes: { list: () => [{ key: 'research', name: 'Research' }] }, agentCore } as unknown as RuntimeServices;
  const manager = org.ensureSeed()!;
  const create = (args: Record<string, unknown>, as: Agent = manager): Promise<ToolOutput> =>
    agentOrgTools.find((tool) => tool.name === 'agents.create')!.run(args, { agent: as, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext);
  return { org, manager, create };
}
const data = (out: ToolOutput) => out.structured as Record<string, any>;

test('agents.update (B-076): a text without How I work replaces the own part; one that would pass 20,000 characters is refused with what fits', async () => {
  const { org, manager } = setup();
  const services = { org, settings: { get: () => settings }, prompts } as unknown as RuntimeServices;
  const update = (args: Record<string, unknown>): Promise<ToolOutput> =>
    agentTools.find((tool) => tool.name === 'agents.update')!.run(args, { agent: manager, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext);
  await update({ instructions: '## My role\nChief of staff for Ada.\n\n## What I have here\n- Budget 50 EUR a month (Ada, 05.11.).' });
  const text = org.require(manager.id).instructions;
  assert.match(text, /^This is my SYSTEM\.md[\s\S]*# How I work[\s\S]*## My role\nChief of staff for Ada\.\n\n## What I have here\n- Budget 50 EUR/);
  const long = await update({ instructions: `## My role\n${'y'.repeat(15_000)}` });
  assert.equal(long.isError, true);
  assert.match(String(long.content.map((part) => ('text' in part ? part.text : '')).join('')), /SYSTEM\.md would be \d+ characters \(at most 20000\); the team's standard above my part takes about \d+, so my own part fits in about \d+\./);
  assert.equal(org.require(manager.id).instructions, text, 'nothing written');
});

test('agents.update (B-078): another agent\'s SYSTEM.md is theirs – instructions are left out with a chat hint, other fields still apply; my own text without the standard gets it back on top', async () => {
  const { org, manager, create } = setup();
  const services = { org, settings: { get: () => settings }, prompts } as unknown as RuntimeServices;
  const update = (args: Record<string, unknown>, as: Agent = manager): Promise<ToolOutput> =>
    agentTools.find((tool) => tool.name === 'agents.update')!.run(args, { agent: as, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined } as ToolContext);
  const mara = org.require(data(await create({ name: 'Mara', role: 'Researcher', instructions: 'Find sources.' })).agentId);
  const only = await update({ agentId: mara.id, instructions: 'Something else.' });
  assert.equal(only.isError, true);
  assert.match(String(only.content.map((part) => ('text' in part ? part.text : '')).join('')), /Nothing written\. SYSTEM\.md is Mara's own – they write it themselves\. I tell Mara in a chat what I would change/);
  assert.equal(org.require(mara.id).instructions, mara.instructions, 'her text stays');
  const mixed = data(await update({ agentId: mara.id, instructions: 'Something else.', role: 'Research lead' }));
  assert.match(mixed.instructions, /^Left as it is\. SYSTEM\.md is Mara's own/);
  assert.equal(org.require(mara.id).role, 'Research lead', 'the other fields apply');
  assert.equal(org.require(mara.id).instructions, mara.instructions);
  org.update(mara.id, { instructions: '# Standing instructions\nWritten by a colleague.' }); // the live 06.11. state: no standard
  const own = await update({ instructions: 'Old copy.\n\n# Standing instructions\nAsk before every step.' }, org.require(mara.id));
  assert.notEqual(own.isError, true);
  const text = org.require(mara.id).instructions;
  assert.match(text, /^This is my SYSTEM\.md[\s\S]*\n# How I work\n[\s\S]*## My role\nResearch lead\.\n\nOld copy\.\n\n# Standing instructions/, 'the standard head is back on top, my text below it');
});

test('a person\'s first name passes; roles, templates, modes and numbered labels do not', () => {
  const roles = ['researcher', 'Researcher', 'Researcher', 'video-editor', 'Video editor', 'research', 'Research'];
  for (const name of ['Mara', 'Anna-Lena', 'Jean Luc', 'Zoë', "O'Neill"]) assert.equal(personNameProblem(name, roles), undefined, name);
  for (const name of ['Researcher', 'research', 'Video Editor', 'Specialist 1', 'Helper', 'AI Agent', 'x', 'mara', 'Bot']) {
    assert.ok(personNameProblem(name, roles), `refused: ${name}`);
  }
});

test('the free first name is stable per seed and skips taken names', () => {
  assert.equal(freeFirstName('ag_1', () => false), freeFirstName('ag_1', () => false));
  const taken = new Set(FIRST_NAMES.slice(0, -1));
  assert.equal(freeFirstName('ag_1', (name) => taken.has(name)), FIRST_NAMES.at(-1));
  assert.equal(freeFirstName('ag_1', () => true), undefined);
});

test('agents.create: a role as name is refused per hire, a missing name becomes a first name, the result carries the SYSTEM.md to adapt', async () => {
  const { org, manager, create } = setup();
  const refused = await create({ template: 'researcher', name: 'Researcher' });
  assert.equal(refused.isError, true);
  assert.match(String(refused.content.map((part) => ('text' in part ? part.text : '')).join('')), /not a person's first name/);

  const team = data(await create({ agents: [{ template: 'researcher', name: 'Mara' }, { template: 'writer', name: 'Writer 2' }, { template: 'designer' }] }));
  assert.deepEqual(team.results.map((result: { ok: boolean }) => result.ok), [true, false, true], 'the refused hire does not stop the others');
  const mara = team.results[0];
  assert.equal(mara.name, 'Mara');
  assert.equal(mara.role, 'Researcher');
  assert.equal(mara.system.path, path.join('/data', 'agents', mara.agentId, 'SYSTEM.md'));
  // B-076: the result carries the hire's own part (its role and what it has here); the team's standard stays above it.
  assert.ok(mara.system.text.startsWith('## My role\nResearcher.'), mara.system.text.slice(0, 80));
  assert.match(mara.system.text, /\n## What I have here\n- This PC is my workplace/);
  assert.doesNotMatch(mara.system.text, /# How I work|<<|Still open/, 'no standard text and no slots in the result');
  assert.match(mara.system.next, /^This is Mara's own part of their SYSTEM\.md, with the "who you are" I gave under "## My role"; the team's standard "How I work" stands above it\. From here Mara grows it themselves\. I start Mara now: a first line in our 1:1 \(chat\.direct\)/);
  assert.match(mara.system.next, /tasks\.create with assignee = Mara's agentId and chatId = our 1:1\)\.$/, 'the field tasks.create takes');
  assert.match(org.get(mara.agentId)!.instructions, /# How I work\n[\s\S]*## My role\nResearcher\./, 'the hire itself holds the whole standard');
  const designer = org.get(team.results[2].agentId)!;
  assert.ok(FIRST_NAMES.includes(designer.name), `a free first name: ${designer.name}`);
  assert.equal(designer.role, 'Designer');
  assert.equal(designer.managerId, manager.id);
});

test('agents.create: a long own part is cut for the result only; every hire result starts the new agent instead of rewriting it (B-078)', async () => {
  const { create } = setup();
  const long = data(await create({ name: 'Theo', role: 'Archivist', instructions: `Archive well. ${'z'.repeat(6500)}` }));
  assert.equal(long.ok, true);
  assert.ok(long.system.text.endsWith('…') && long.system.text.length === 6000, 'the text is cut for the result');
  const short = data(await create({ name: 'Ida', role: 'Editor', instructions: 'Edit tight.' }));
  assert.equal(short.system.next, long.system.next.replaceAll('Theo', 'Ida'), 'one start line for every hire');
  assert.doesNotMatch(short.system.next, /agents\.update/, 'no rewrite of another agent\'s SYSTEM.md');
});

test('agents.create (B-078): a head stands beside me and reports to the person; a named manager still wins', async () => {
  const { org, manager, create } = setup();
  const head = data(await create({ template: 'head', name: 'Paula', role: 'Head of programming', instructions: 'I lead the software work.' }));
  assert.equal(head.ok, true);
  assert.equal(org.get(head.agentId)!.managerId, undefined, 'reports to the person');
  assert.equal(org.get(head.agentId)!.mode, 'manager');
  const text = org.get(head.agentId)!.instructions;
  assert.match(text, /## My role\nHead of programming\.\n\nI lead one area of the person's work[\s\S]*\(skill head-of-staff\)\.\n\nI lead the software work\.\n\n## What I have here\n/, 'head.md stays, the creator\'s "who you are" below it');
  const own = data(await create({ template: 'head', name: 'Rosa', role: 'Head of design', instructions: '## My role\nHead of design.\n\nI lead the look.\n\n## What I have here\n- The Figma account.' }));
  assert.match(org.get(own.agentId)!.instructions, /\n## My role\nHead of design\.\n\nI lead the look\.\n\nI lead one area of the person's work[\s\S]*\(skill head-of-staff\)\.\n\n## What I have here\n- The Figma account\.$/, 'an own part with its headings keeps them; head.md goes into the role');
  const under = data(await create({ template: 'head', name: 'Quinn', role: 'Head of video', managerId: manager.id }));
  assert.equal(org.get(under.agentId)!.managerId, manager.id);
});

test('agents.create: the secretary works for the person; she is started like any hire; no agent core, no path', async () => {
  const { create } = setup(false);
  const secretary = data(await create({ template: 'secretary', name: 'Ella' }));
  assert.equal(secretary.ok, true);
  assert.equal(secretary.system.path, undefined);
  assert.match(secretary.system.next, /^This is Ella's own part of their SYSTEM\.md/);
  assert.match(secretary.system.text, /I report to the person directly/);
});
