// B-044 hire seed (org/hire.ts; contract decision 10), B-047 (D9) and B-076: every new agent starts with the team's
// standard SYSTEM.md – the rendered agent-default prompt with the owner's name, the hire's creator and role and the
// team's "How I work" inside it – then "## My role" with its template's or creator's instructions right below the role
// line, then "## What I have here". No slots, no money section: the money skill is a skill. A text that already has the
// team's "# How I work" (B-078: that heading only) gets it no second time, and a standard that would not fit is left out
// with a warning (never silently). Without the rules (no prompt, a fake) a hire is unchanged. From the hire on, the own
// part is the agent's own (B-078).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { standingRuleValues, standingRulesLeftOut, withStandingRules } from '../../../src/runtime/org/hire.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
settings.profile.name = 'Ada';
const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
const rules = (values?: Readonly<Record<string, string>>) => prompts.renderText('agent-default', { ...standingRuleValues(settings), ...values });
const HAVE = /\n\n## What I have here\n- This PC is my workplace, all of it: [^\n]*Ada's logins[^\n]*\n- What Ada and I settle about working together[^\n]*$/;

function setup(standingRules: (values?: Readonly<Record<string, string>>) => string | undefined = rules, warnings: string[] = []) {
  return new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents'), standingRules, log: { warn: (message) => warnings.push(message) } });
}

test('a hire starts with the whole standard SYSTEM.md – the team\'s How I work, its role with the template text, what it has here; named for its creator and role (never its manager); the seed Manager too', () => {
  const org = setup();
  const manager = org.ensureSeed()!;
  assert.ok(manager.instructions.startsWith('This is my SYSTEM.md – the main part of what I read each turn.'), manager.instructions.slice(0, 120));
  assert.match(manager.instructions, /\n\n# How I work\nThis company is my own work – Ada, my colleagues/, 'the team\'s rules are part of it, with the owner\'s name');
  assert.match(manager.instructions, /What only they can give \(a signature, a code sent to their phone, a password nobody saved\)/);
  assert.match(manager.instructions, /colleague or a stronger model \(model\.set\)/, 'every tool flag rendered: the text is the same in every mode');
  assert.doesNotMatch(manager.instructions, /\{\{|\}\}|<<|Still open|## Money|## Your role|You are /, 'no placeholder, no slot, no money section, one voice');
  assert.doesNotMatch(manager.instructions, /report to Ada|agent above|your manager|my manager/, 'true for a top agent: "Who I am" has the live chain');
  assert.doesNotMatch(manager.instructions, /Rights|\b50\b|\b300\b/, 'no fixed amounts, no rights: the money skill holds that thinking');
  assert.match(manager.instructions, /\n## My role\nPersonal manager\.\n\nI am the person's personal manager – their right hand/, 'the template text follows its role line');
  assert.match(manager.instructions, HAVE, 'what it has here closes the text');
  assert.ok(manager.instructions.indexOf('# How I work') < manager.instructions.indexOf('## My role'));
  const writer = org.create({ template: 'writer', name: 'Wes', createdBy: manager.id });
  const standard = rules({ creator: 'Manager', role: 'Writer' });
  assert.ok(writer.instructions.startsWith(standard.slice(0, standard.indexOf('## What I have here')).trim()));
  assert.match(writer.instructions, /^This is my SYSTEM\.md, started by Manager – the main part/m);
  assert.doesNotMatch(writer.instructions, /report to (Ada|Manager)/, 'the name of its manager is not frozen into the text');
  assert.doesNotMatch(writer.instructions, /monthly|limit/i, 'no spend limit in the text');
  assert.ok(writer.instructions.includes(`## My role\nWriter.\n\n${org.template('writer')!.instructions.trim()}\n\n## What I have here`));
  const own = org.create({ name: 'Quill', role: 'Editor', instructions: 'Edit tight.', createdBy: HUMAN_ID });
  assert.match(own.instructions, /\n## My role\nEditor\.\n\nEdit tight\.\n\n## What I have here\n/);
  assert.match(own.instructions, HAVE);
});

test('the rules come once, and a refinement stays the agent\'s', () => {
  const org = setup();
  const first = org.create({ name: 'Rae', role: 'Researcher', instructions: 'Find sources.', createdBy: HUMAN_ID });
  const again = org.create({ name: 'Rex', role: 'Researcher', instructions: first.instructions, createdBy: HUMAN_ID });
  assert.equal(again.instructions, first.instructions, 'text that has the rules gets them no second time');
  const refined = org.update(first.id, { instructions: `${first.instructions}\n- Hosting renewals are settled (Ada, 05.11.).` }, { by: HUMAN_ID });
  assert.match(refined.instructions, /Hosting renewals are settled/);
  const ownWhat = org.create({ name: 'Rio', role: 'Researcher', instructions: 'Find sources.\n\n## What I have here\n- Only the shared drive.', createdBy: HUMAN_ID });
  assert.equal((ownWhat.instructions.match(/## What I have here/g) ?? []).length, 1, 'an own what-I-have part replaces the standard one');
  assert.match(ownWhat.instructions, /- Only the shared drive\.$/);
});

test('without rules a hire is unchanged; rules that would not fit are left out with a warning, never silently', () => {
  const bare = setup(() => undefined).create({ name: 'Bo', role: 'Helper', instructions: 'Help.', createdBy: HUMAN_ID });
  assert.equal(bare.instructions, 'Help.');
  assert.equal(withStandingRules('Help.', ''), 'Help.');
  assert.equal(withStandingRules('x'.repeat(19_990), '# Standing rules\nA long text.'), 'x'.repeat(19_990));
  assert.equal(withStandingRules('', '# Standing rules\n- one'), '# Standing rules\n- one');
  assert.equal(withStandingRules('Mine.', '# Standing rules\n## My role\nR.\n\n## What I have here\n- this PC'), '# Standing rules\n## My role\nR.\n\nMine.\n\n## What I have here\n- this PC', 'the own text sits between the role line and what I have here');
  assert.equal(withStandingRules('# How I work\nmine', 'Preface.\n\n# How I work\nthe standard'), '# How I work\nmine', 'a text with How I work keeps its own');
  // B-076 live run: a creator's text that starts with the role heading takes the standard's role heading's place – one "## My role".
  assert.equal(withStandingRules('## My role\nI am Clara.', '# Standing rules\n## My role\nR.\n\n## What I have here\n- this PC'), '# Standing rules\n\n## My role\nI am Clara.\n\n## What I have here\n- this PC');
  assert.equal(standingRulesLeftOut('x'.repeat(19_990), '# Standing rules\nA long text.'), true);
  assert.equal(standingRulesLeftOut('Help.', '# Standing rules\nA long text.'), false, 'it fits');
  assert.equal(standingRulesLeftOut('# Standing rules\nmine', '# Standing rules\nA long text.'), false, 'already there');
  const warnings: string[] = [];
  const long = setup(rules, warnings).create({ name: 'Lu', role: 'Archivist', instructions: 'y'.repeat(19_900), createdBy: HUMAN_ID });
  assert.equal(long.instructions, 'y'.repeat(19_900), 'the person\'s instructions win');
  assert.equal(warnings.length, 1, 'the left-out standard is reported');
  assert.match(warnings[0], /did not fit/);
  assert.deepEqual(standingRuleValues(settings), { owner: 'Ada', user_name: 'Ada' });
});


test('B-047: a hire without a name gets a free human first name and keeps the template role', () => {
  const org = setup();
  const manager = org.ensureSeed()!;
  assert.equal(manager.name, 'Manager', 'the seed keeps its role as a name until it names itself');
  const first = org.create({ template: 'researcher', createdBy: manager.id });
  const second = org.create({ template: 'researcher', createdBy: manager.id });
  for (const hire of [first, second]) {
    assert.match(hire.name, /^\p{Lu}\p{Ll}+$/u, `a first name, not a role: ${hire.name}`);
    assert.equal(hire.role, 'Researcher');
  }
  assert.notEqual(first.name, second.name, 'names stay unique');
  assert.equal(org.create({ template: 'writer', name: 'Writer', createdBy: HUMAN_ID }).name, 'Writer', 'an explicit name is the creator\'s choice (agents.create checks it)');
});

test('B-078 (live 06.11.): a copied old text that holds the standard\'s first line but no "# How I work" still gets the standard', () => {
  const org = setup();
  const manager = org.ensureSeed()!;
  const firstLine = manager.instructions.split('\n', 1)[0];
  const copy = `${firstLine}\n\n# Standing instructions\nAsk before each step.`;
  const jonas = org.create({ name: 'Jonas', role: 'Product QA', instructions: copy, createdBy: HUMAN_ID });
  assert.equal((jonas.instructions.match(/\n# How I work\n/g) ?? []).length, 1, 'the standard is in, once');
  assert.ok(jonas.instructions.indexOf('# How I work') < jonas.instructions.indexOf('## My role\nProduct QA.'), 'on top');
  assert.ok(jonas.instructions.includes('# Standing instructions\nAsk before each step.'), 'the copied text stays as its own part');
});
