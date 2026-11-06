// B-076 (owner 05.11.2026: "seit wann ist ein Systemprompt nicht das Hauptding?", the mixed "I"/"you" voice, the money
// section and the <<slots>> in his live Konrad's SYSTEM.md): an untouched 0.3.2 SYSTEM.md becomes the whole standing text at
// the next start – the team's "How I work", "## My role" with today's role text, "## What I have here" – while anything the
// person or the agent wrote stays; agents.update writes the own part and keeps the standard; the stable prompt shows such a
// SYSTEM.md as its main part, once.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { refreshAgentPrompts, shownChanges } from '../../../src/runtime/org/prompt-updates.ts';
import { loadPreviousBodies, modernRoleSuffix } from '../../../src/runtime/org/role-upgrade.ts';
import { hasWorkStandard, ownPart, withOwnPart } from '../../../src/runtime/org/system-parts.ts';
import { PromptTemplates, renderTemplate, standardRuleValues } from '../../../src/runtime/context/templates.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';
import { fixture, route, VIDEO_MODE } from '../context/fixture.ts';

/** Konrad's SYSTEM.md as Autark 0.3.2 wrote it for an existing agent (05.11.2026). */
const KONRAD = `# Standing instructions
This is my SYSTEM.md. I keep it current as my role grows; lessons go to memory, ways of working that worked go to skills.

## How I work
I look at what is known, decide, act, say what changed. To whoever I report to I bring results and real blockers; with colleagues I work directly. What worked, I leave behind: a skill improved, a note corrected.
<<Still open: how I recognise this role going well, and what counts most when two good things conflict, for instance "speed before polish while the offer is being tested".>>

## Who and what I work with
<<Still open: the colleagues, folders and accounts of this work, and an earlier piece that shows what good looks like here.>>

## Money
The money skill shows how this team weighs a purchase.
<<Still open: any standing agreement, for instance "hosting renewals are settled".>>

## Your role
Chief of staff.

You are the person's chief of staff and the first member of their AI team: their goals across company, personal brand and private life get done and verified, and the team grows out of that work.

- "Manager" is your role, not your name: early on, take a human first name that suits you and the person's language (agents.update); they may choose another.
- Without a personal assistant you prepare the person's private to-dos (todos.prepare) when woken for them, and may suggest hiring a secretary.`;

const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
const standing = standardRuleValues({ owner: 'Alex Berger' });
const render = (values: Readonly<Record<string, string>>) => renderTemplate(prompts.standardTemplate(), { ...standing, ...values });

function org() {
  const db = memoryDb();
  const time = clock();
  const { bus } = recordingBus();
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const o = new Org({ db, bus, clock: time, log, templatesDir: path.join(RESOURCES, 'agents') }); // untracked: no hire record, as after a lost one
  const wakes = new WakeQueueImpl({ db, clock: time });
  const s = { db, clock: time, org: o, wakes, log, paths: { resources: RESOURCES, data: '' } } as unknown as Parameters<typeof refreshAgentPrompts>[0];
  return { o, s, wakes };
}

test('Konrad\'s untouched 0.3.2 SYSTEM.md becomes the whole standing text: How I work, today\'s role text in the first person, what he has here', () => {
  const { o, s, wakes } = org();
  const konrad = o.create({ template: 'manager', name: 'Konrad', createdBy: HUMAN_ID });
  o.update(konrad.id, { instructions: KONRAD }, { by: HUMAN_ID });
  refreshAgentPrompts(s, prompts.standardTemplate(), render, undefined, standing);
  const next = o.require(konrad.id).instructions;
  assert.ok(next.startsWith('This is my SYSTEM.md – the main part of what I read each turn.'), next.slice(0, 100));
  assert.match(next, /\n# How I work\nThis company is my own work – Alex Berger, my colleagues/);
  assert.match(next, /\n## My role\nChief of staff\.\n\nI am the person's personal manager – their right hand/, 'B-078: today\'s personal manager text');
  assert.match(next, /\n## What I have here\n- This PC is my workplace, all of it: [^\n]*Alex Berger's logins/);
  assert.doesNotMatch(next, /## Your role|You are |\byou\b|\bmay\b|<<|Still open|## Money/, 'one voice, no slots, no money section');
  assert.equal((next.match(/# How I work/g) ?? []).length, 1);
  assert.equal(wakes.pending(), 0, 'an untouched standard needs no review');
  refreshAgentPrompts(s, prompts.standardTemplate(), render, undefined, standing);
  assert.equal(o.require(konrad.id).instructions, next, 'a second start changes nothing');
});

test('an own role text stays word for word – only the heading takes today\'s form and what I have here joins once', () => {
  const previous = loadPreviousBodies(path.join(RESOURCES, 'agents'));
  assert.ok(previous.manager?.[0]?.startsWith('You are the person\'s chief of staff'), 'the shipped old texts are known');
  const templates = [{ key: 'manager', instructions: 'I am the chief of staff.' }];
  const have = '## What I have here\n- This PC.';
  const own = '## Your role\nChief of staff.\n\nRun the books my way.';
  assert.equal(modernRoleSuffix(own, { template: 'manager', templates, previous, have }), '## My role\nChief of staff.\n\nRun the books my way.\n\n## What I have here\n- This PC.');
  const old = `## Your role\nChief of staff.\n\n${previous.manager[0]}`;
  assert.equal(modernRoleSuffix(old, { template: 'manager', templates, previous, have }), '## My role\nChief of staff.\n\nI am the chief of staff.\n\n## What I have here\n- This PC.');
  const done = '## My role\nChief of staff.\n\nRun the books my way.\n\n## What I have here\n- Only the shared drive.';
  assert.equal(modernRoleSuffix(done, { template: 'manager', templates, previous, have }), done, 'already today\'s form: untouched');
  assert.equal(modernRoleSuffix('## Your role\nX.\n\n## What I have here\n- mine', { templates, previous, have }), '## My role\nX.\n\n## What I have here\n- mine', 'only the heading');
  const dropped = '## My role\nSupport for customers.';
  assert.equal(modernRoleSuffix(dropped, { templates, previous, have }), dropped, 'today\'s form without "What I have here" was chosen: it stays so');
  assert.equal(hasWorkStandard('# Standing instructions\n## How I work\nold', '## How I work\nan own rules.md'), false, 'only a top-level heading stands for the rules');
});

test('agents.update writes the own part and keeps the standard; a text with How I work replaces the whole file; ownPart is what a creator sees', () => {
  const whole = 'Preface.\n\n# How I work\nStandard.\n\n## My role\nWriter.\n\nOld.\n\n## What I have here\n- PC';
  assert.equal(withOwnPart(whole, 'Writes books.\n\n## What I have here\n- PC, budget 50 (Ada, 05.11.)'), 'Preface.\n\n# How I work\nStandard.\n\n## My role\nWrites books.\n\n## What I have here\n- PC, budget 50 (Ada, 05.11.)');
  assert.equal(withOwnPart(whole, '## My role\nEditor.'), 'Preface.\n\n# How I work\nStandard.\n\n## My role\nEditor.');
  assert.equal(withOwnPart(whole, '# How I work\nMine entirely.'), '# How I work\nMine entirely.');
  assert.equal(withOwnPart('Old style text.', 'New text.'), 'New text.', 'an older SYSTEM.md is replaced whole, as before');
  assert.equal(ownPart(whole), '## My role\nWriter.\n\nOld.\n\n## What I have here\n- PC');
  assert.equal(ownPart('Old style text.'), 'Old style text.');
});

test('review fixes: an own rules.md heading counts as the standard; the review diff is cut between lines with a count', () => {
  const own = 'Vorwort.\n\n# Wie ich arbeite\nIch.\n\n## My role\nR.\n\n## What I have here\n- PC';
  assert.equal(hasWorkStandard(own), false, 'the shipped heading alone does not know it');
  assert.equal(hasWorkStandard(own, '# Wie ich arbeite\nIch.'), true, 'the rules in force name it');
  assert.equal(withOwnPart(own, 'Neu.', '# Wie ich arbeite\nIch.'), 'Vorwort.\n\n# Wie ich arbeite\nIch.\n\n## My role\nNeu.', 'agents.update keeps an own standard too');
  assert.equal(ownPart(own, '# Wie ich arbeite'), '## My role\nR.\n\n## What I have here\n- PC');
  const many = Array.from({ length: 300 }, (_, i) => `+ line ${i} ${'x'.repeat(30)}`);
  const shown = shownChanges(many);
  assert.ok(shown.length <= 4200, String(shown.length));
  assert.match(shown, /\n… \(\d+ more changed lines – the whole new standard part is in the file named below\)$/);
  assert.ok(shown.split('\n').slice(0, -1).every((line) => line.startsWith('+ line ')), 'no line cut in half');
  assert.equal(shownChanges(['- a', '+ b']), '- a\n+ b');
});

test('the stable prompt shows a whole standing SYSTEM.md as its main part, once, without the rules above it; the PC\'s language is a fact', () => {
  const f = fixture();
  const standard = render({ creator: '', role: 'Video editor' });
  const text = standard.replace('## What I have here', 'Cut tight.\n\n## What I have here');
  const vid = { ...f.vid, instructions: text }; // the fixture has no agent core: the prompt reads agent.instructions
  const { stable } = f.context.prompt({ agent: vid, mode: VIDEO_MODE, route: route() });
  assert.equal((stable.match(/# How I work/g) ?? []).length, 1, 'the rules once');
  assert.ok(!stable.includes('## My instructions'), 'no wrapper: SYSTEM.md stands as it is');
  assert.ok(stable.indexOf('# Who I am') < stable.indexOf('This is my SYSTEM.md') && stable.indexOf('This is my SYSTEM.md') < stable.indexOf('## Mode: Video'), 'who I am, then SYSTEM.md, then the mode');
  assert.ok(stable.includes('## My role\nVideo editor.\n\nCut tight.'));
  assert.match(stable, /whose language is set to \w+\./);
  assert.doesNotMatch(stable, /Write to me in/); // B-078 (D17): the language line now says my answers follow the person's
});

test('B-078: the first-person chief of staff of 0.3.2/0.3.3 becomes today\'s personal manager text; its own "What I have here" stays as it is', () => {
  const previous = loadPreviousBodies(path.join(RESOURCES, 'agents'));
  const chief = previous.manager?.find((body) => body.startsWith('I am the person\'s chief of staff'));
  assert.ok(chief, 'the B-076 manager text is known');
  const today = new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') }).template('manager')!;
  const have = '## What I have here\n- This PC.';
  const own = `## My role\nChief of staff.\n\n${chief}\n\n## What I have here\n- SSH to the VPS (Ada, 05.11.).`;
  const next = modernRoleSuffix(own, { template: 'manager', templates: [today], previous, have });
  assert.equal(next, `## My role\nChief of staff.\n\n${today.instructions.trim()}\n\n## What I have here\n- SSH to the VPS (Ada, 05.11.).`);
  assert.equal(modernRoleSuffix(`## My role\nChief of staff.\n\n${chief}\nMy own line.`, { template: 'manager', templates: [today], previous, have }).includes('My own line.'), true, 'an edited text stays');
});
