// Owns: shipped-standard upgrades through real Org, SYSTEM.md files and durable wakes, including restart/restore.
// Never: calls a provider or changes the installed app's data.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Paths } from '../../../src/runtime/contracts.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { refreshAgentPrompts, startPromptUpdates } from '../../../src/runtime/org/prompt-updates.ts';
import { AgentCore } from '../../../src/runtime/agent-core/service.ts';
import { cleanTemplate, PromptTemplates, renderTemplate } from '../../../src/runtime/context/templates.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { clock, memoryDb, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';

const original = cleanTemplate(readFileSync(path.join(RESOURCES, 'prompts', 'agent-default.md'), 'utf8'));
const MARKER = 'My role and what I have here are mine: I rewrite them myself (agents.update) as I learn the work, and what a colleague would change there they tell me in a chat.'; // B-076/B-078: a sentence of the standard part (above "## My role")
const second = original.replace(MARKER, 'Check the evidence, act, and report the result.');
const third = second.replace('Check the evidence, act, and report the result.', 'Check the evidence, finish the work, and report the result.');
/** The B-066 standard as shipped until B-075 (org/standard-upgrade.ts UNTRACKED and the role heading): what an untracked hire holds. */
const B066 = `# Standing instructions
This is your SYSTEM.md{{#creator}}, started by {{creator}}{{/creator}}. You keep it current as your role grows; lessons go to memory, ways of working that worked go to skills.

## How you work
Look at what is known, decide, act, say what changed. Whoever you report to wants results and real blockers; colleagues you work with directly. What worked, leave behind: a skill improved, a note corrected.
<<Still open: how you recognise this role going well, and what counts most when two good things conflict, for instance "speed before polish while the offer is being tested".>>

## Who and what you work with
<<Still open: the colleagues, folders and accounts of this work, and an earlier piece that shows what good looks like here.>>

## Money
The money skill shows how this team weighs a purchase.
<<Still open: any standing agreement, for instance "hosting renewals are settled".>>

## Your role
{{#role}}{{role}}.{{/role}}`;

function fixture(t: TestContext, tracked = true) {
  const dir = tempDir('autark-prompt-updates-');
  const db = memoryDb();
  const time = clock();
  const { bus } = recordingBus();
  const paths = { data: path.join(dir.dir, 'data'), resources: path.join(dir.dir, 'resources') } as Paths;
  mkdirSync(path.join(paths.resources, 'prompts'), { recursive: true });
  // B-076: the standard takes rules.md in; empty here, so these tests watch the standard's own lines (no missing-file warning).
  for (const name of ['identity', 'rules', 'skills', 'compaction']) writeFileSync(path.join(paths.resources, 'prompts', `${name}.md`), '');
  let template = original;
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, error() {}, warn: (message: string) => { warnings.push(message); } };
  let prompts = new PromptTemplates(() => path.join(paths.resources, 'prompts'), () => log, { data: () => paths.data });
  const render = (values: Readonly<Record<string, string>> = {}) => prompts.renderText('agent-default', { owner: 'Ada', ...values });
  const org = new Org({ db, bus, clock: time, log, templatesDir: path.join(RESOURCES, 'agents'), standingRules: render,
    ...(tracked ? { standingTemplate: () => prompts.standardTemplate() } : {}) }); // B-076: as compose/services.ts wires it
  const core = new AgentCore({ dataDir: paths.data, org: () => org, skills: () => undefined, bus, clock: time, log });
  org.setCoreFiles(core);
  core.start();
  const wakes = new WakeQueueImpl({ db, clock: time });
  const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  const s = { db, clock: time, bus, paths, org, wakes, log, prompts, settings: { get: () => settings } } as unknown as Parameters<typeof startPromptUpdates>[0];
  const set = (next: string) => {
    template = next;
    writeFileSync(path.join(paths.resources, 'prompts', 'agent-default.md'), next);
    prompts = new PromptTemplates(() => path.join(paths.resources, 'prompts'), () => log, { data: () => paths.data });
    s.prompts = prompts;
  };
  set(original);
  t.after(() => { core.stop(); db.close(); dir.cleanup(); });
  return { s, org, core, db, wakes, paths, warnings, set, refresh: () => refreshAgentPrompts(s, template.includes('{{rules}}') ? prompts.standardTemplate() : template, render, undefined, { owner: 'Ada' }),
    hire: (name = 'Wes') => org.create({ name, role: 'Writer', instructions: 'Write clearly.', createdBy: HUMAN_ID }) };
}

test('untouched hires follow successive defaults in SYSTEM.md while their complete role suffix stays unchanged', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  const suffix = agent.instructions.slice(agent.instructions.indexOf('## My role'));
  for (const template of [second, third]) {
    f.set(template);
    f.refresh();
    const next = f.org.require(agent.id).instructions;
    assert.equal(next, `${renderTemplate(template, { role: '' }).split('## My role')[0].trim()}\n\n${suffix}`);
    assert.equal(readFileSync(path.join(f.core.folder(agent.id), 'SYSTEM.md'), 'utf8').trimEnd(), next);
    assert.equal(f.wakes.pending(), 0);
  }
  f.refresh();
  assert.equal(f.warnings.length, 0);
});

test('an edit in the standard part gets one complete review per revision; an agent that only fitted its own part follows the standard (B-076 review fix)', (t) => {
  const f = fixture(t);
  const agents = [f.hire('Head'), f.hire('Role')];
  const custom = [agents[0].instructions.replace('the main part of what I read each turn', 'what I read first'),
    agents[1].instructions.replace('Write clearly.', 'Write clearly. Keep customer names private.')];
  agents.forEach((agent, i) => f.org.update(agent.id, { instructions: custom[i], modelPolicy: { effort: 'high' } }));
  f.set(second);
  f.refresh();
  assert.equal(f.org.require(agents[0].id).instructions, custom[0], 'an edited standard part stays');
  const [wake] = f.wakes.list(agents[0].id);
  assert.equal(wake.reason, 'review');
  assert.equal(wake.conversationId, undefined, 'review does not inherit a chat model override');
  assert.match(wake.note!, /replace.*adapt.*keep/);
  // B-072: only what changed, filled in for this agent; the reference is its filled-in standard part, no placeholders
  assert.match(wake.note!, /\n- This is my SYSTEM\.md[^\n]*they tell me in a chat\.\n\+ This is my SYSTEM\.md[^\n]*Check the evidence, act, and report the result\./, wake.note!);
  const reference = /The whole new standard part, filled in: (.+)\.$/m.exec(wake.note!)![1];
  const shown = readFileSync(reference, 'utf8');
  assert.ok(shown.includes('Check the evidence, act, and report the result.') && !shown.includes('{{') && !/## My role/.test(shown), shown.slice(0, 300));
  f.wakes.done([wake.id]);
  const role = f.org.require(agents[1].id).instructions;
  assert.match(role, /Check the evidence, act, and report the result\./, 'its own part edited only: the new standard is in');
  assert.match(role, /Write clearly\. Keep customer names private\./, 'and its own words stay');
  assert.equal(f.wakes.list(agents[1].id).length, 0, 'no review for it');
  f.refresh();
  assert.equal(f.wakes.pending(), 0, 'restart after keeping custom prompts does not ask again');
  f.set(third);
  f.refresh();
  assert.equal(f.wakes.pending(), 1, 'a later default asks the agent with an edited standard again');
  assert.equal(f.org.require(agents[0].id).instructions, custom[0]);
  assert.match(f.org.require(agents[1].id).instructions, /finish the work[\s\S]*Keep customer names private/);
});

test('an agent that adopts the offered standard follows the next revision automatically', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  f.org.update(agent.id, { instructions: agent.instructions.replace('the main part of what I read each turn', 'what I read first') });
  f.set(second);
  f.refresh();
  f.wakes.done(f.wakes.list(agent.id).map((wake) => wake.id));
  f.org.update(agent.id, { instructions: agent.instructions.replace(MARKER, 'Check the evidence, act, and report the result.') });
  f.set(third);
  f.refresh();
  assert.match(f.org.require(agent.id).instructions, /finish the work/);
  assert.equal(f.wakes.pending(), 0);
});

test('untracked B-066 defaults upgrade even across a skipped release; custom prompts get the first offer', (t) => {
  const f = fixture(t, false);
  f.set(B066); // B-075: the shipped standard speaks in the first person now; an untracked hire still holds the B-066 one
  const standard = f.hire('Standard');
  assert.match(standard.instructions, /^# Standing instructions\nThis is your SYSTEM\.md/);
  const custom = f.hire('Custom');
  f.org.update(custom.id, { instructions: '# My instructions\nKeep this wording.' });
  f.set(second);
  f.refresh();
  assert.match(f.org.require(standard.id).instructions, /^This is my SYSTEM\.md[\s\S]*Check the evidence/);
  assert.match(f.org.require(standard.id).instructions, /\n## My role\nWriter\.\n\nWrite clearly\.\n\n## What I have here\n- This PC is my workplace/, 'B-076: the role heading in today\'s form, what it has here added once');
  assert.equal(f.org.require(custom.id).instructions, '# My instructions\nKeep this wording.');
  assert.equal(f.wakes.pending(), 1);
});

test('disk edits reconciled at startup: an edited standard part is protected, an edited own part kept while the standard renews; renewal failures remain retryable', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  const head = f.hire('Head');
  const file = path.join(f.core.folder(agent.id), 'SYSTEM.md');
  const headFile = path.join(f.core.folder(head.id), 'SYSTEM.md');
  writeFileSync(file, agent.instructions.replace('Write clearly.', 'My disk edit.'));
  writeFileSync(headFile, head.instructions.replace('the main part of what I read each turn', 'what I read first'));
  f.core.reconcileAll();
  f.set(second);
  f.refresh();
  assert.match(readFileSync(file, 'utf8'), /Check the evidence[\s\S]*My disk edit/, 'own part kept, standard renewed');
  assert.match(readFileSync(headFile, 'utf8'), /what I read first/, 'the edited standard part stays');
  assert.equal(f.wakes.pending(), 1, 'one review: the agent with the edited standard part');
  const next = f.hire('Retry');
  f.set(third);
  const update = f.org.update.bind(f.org);
  f.org.update = () => { throw new Error('unwritable'); };
  f.refresh();
  assert.equal(f.org.require(next.id).instructions, next.instructions);
  f.org.update = update;
  f.refresh();
  assert.match(f.org.require(next.id).instructions, /finish the work/);
});

test('a wake failure rolls back its marker and queued row so the review is retried', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  f.org.update(agent.id, { instructions: 'Custom instructions.' });
  f.set(second);
  const wake = f.wakes.wake.bind(f.wakes);
  f.wakes.wake = (request) => { wake(request); throw new Error('failed after insert'); };
  f.refresh();
  assert.equal(f.wakes.pending(), 0);
  f.wakes.wake = wake;
  f.refresh();
  assert.equal(f.wakes.pending(), 1);
  assert.equal(f.org.require(agent.id).instructions, 'Custom instructions.');
});

test('restoring an archived custom agent offers its pending update once without a restart', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  f.hire('Other');
  f.org.update(agent.id, { instructions: 'Custom archived prompt.' });
  f.org.archive(agent.id);
  f.set(second);
  const off = startPromptUpdates(f.s);
  t.after(off);
  assert.equal(f.wakes.pending(), 0);
  f.org.restore(agent.id);
  assert.equal(f.wakes.pending(), 1);
  f.org.update(agent.id, { role: 'Editor' });
  assert.equal(f.wakes.pending(), 1);
});

test('a failed default marker does not leave an orphan hire', (t) => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_default BEFORE INSERT ON kv WHEN NEW.ns = 'agent-prompt-defaults' BEGIN SELECT RAISE(ABORT, 'marker failed'); END;");
  assert.throws(() => f.hire(), /marker failed/);
  assert.equal(f.org.list().length, 0);
});

test('a fresh seed can review an edited global prompt before agents start', (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.paths.data, 'prompts'), { recursive: true });
  writeFileSync(path.join(f.paths.data, 'prompts', 'agent-default.md'), '# Custom standard\nKeep me.');
  const manager = f.org.ensureSeed()!;
  const off = startPromptUpdates(f.s);
  t.after(off);
  assert.equal(f.wakes.list(manager.id).length, 1);
  assert.equal(f.wakes.list(manager.id)[0].origin?.source, 'system-prompt:agent-default');
});

test('a replacement template without a role boundary is offered for review and never guessed into SYSTEM.md', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  f.set('# New custom standard\nDifferent layout.');
  f.refresh();
  assert.equal(f.org.require(agent.id).instructions, agent.instructions);
  assert.equal(f.wakes.pending(), 1);
  assert.equal(new KvRepo(f.db).get<{ template: string }>('agent-prompt-defaults', agent.id)?.template, '# New custom standard\nDifferent layout.');
});

test('B-072: a new standard that changes nothing for an agent once filled in wakes nobody; the review never shows a placeholder', (t) => {
  const f = fixture(t);
  const agent = f.hire();
  f.org.update(agent.id, { instructions: agent.instructions.replace('the main part of what I read each turn', 'what I read first') }); // an edited standard part (B-076: the own part alone renews)
  f.set(original.replace('{{#creator}}, started by {{creator}}{{/creator}}', '{{#creator}}, set up by {{creator}}{{/creator}}'));
  f.refresh();
  assert.equal(f.wakes.pending(), 0, 'hired by the person: no creator, so the filled-in standard is the same');
  f.set(second);
  f.refresh();
  const [wake] = f.wakes.list(agent.id);
  assert.ok(wake && !wake.note!.includes('{{'), wake?.note);
});

test('B-078: a SYSTEM.md without the team\'s "# How I work" (an old copied head) gets the standard back on top at start, its text kept below, once', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.paths.resources, 'prompts', 'rules.md'), '# How I work\nI finish what I start.');
  f.set(original);
  const agent = f.hire('Jonas');
  const old = '# Standing instructions\nThis is my SYSTEM.md.\n\n## How I work\nAsk before each step.';
  f.org.update(agent.id, { instructions: old });
  f.refresh();
  const next = f.org.require(agent.id).instructions;
  assert.match(next, /^This is my SYSTEM\.md – the main part[\s\S]*\n# How I work\nI finish what I start\.\n\n## My role\nWriter\.\n\n# Standing instructions\nThis is my SYSTEM\.md\.\n\n## How I work\nAsk before each step\.\n\n## What I have here\n/, next);
  const [wake] = f.wakes.list(agent.id);
  assert.equal(f.wakes.pending(), 1, 'one review wake: the old text may hold an older standard');
  assert.equal(wake.reason, 'review');
  assert.match(wake.note!, /my whole earlier text now stands under "## My role"[\s\S]*I clean my own part/);
  f.refresh();
  assert.equal(f.org.require(agent.id).instructions, next, 'a second start changes nothing');
  assert.equal(f.wakes.pending(), 1, 'and wakes nobody again');
});

test('B-078 review: a SYSTEM.md whose head is exactly an old shipped standard gets it swapped at start, no copy kept, no wake', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.paths.resources, 'prompts', 'rules.md'), '# How I work\nI finish what I start.');
  f.set(original);
  const agent = f.hire('Nora');
  f.org.update(agent.id, { instructions: `${renderTemplate(B066, { role: 'Writer' })}\n\nWrite clearly.` });
  f.refresh();
  const next = f.org.require(agent.id).instructions;
  assert.match(next, /\n# How I work\nI finish what I start\.\n[\s\S]*Write clearly\./, next);
  assert.doesNotMatch(next, /# Standing instructions|## How you work/, 'the old standard is gone, not stacked');
  assert.equal(f.wakes.pending(), 0);
});
