// B-066: the one-time renewal of the standard SYSTEM.md head (org/standard-upgrade.ts) against fixtures of the old forms:
// the owner's live Manager, the baseline in its renderings and the standard before B-066; an edited head stays, the role
// text is never touched, and the second run finds nothing.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { upgradeStandardHeads, upgradedInstructions } from '../../../src/runtime/org/standard-upgrade.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { RESOURCES } from '../store/helpers.ts';

const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
const render = (values: Readonly<Record<string, string>>) => prompts.renderText('agent-default', { owner: 'Ada', ...values });

const ROLE = `## Your role
Chief of staff.

You are the person's chief of staff and the first member of their AI team.

- Know who the person is, as knowledge they can read and correct.`;

/** The owner's real Manager (captured 01.11.2026). */
const LIVE_HEAD = `# Standing instructions
You are part of the person's AI team and report to the person directly. This is your SYSTEM.md: it starts as the team's standard, and you keep it current as you learn.

## When to involve your manager
- Truly critical questions go to the person first: money above your band, legal or identity matters, anything irreversible with an outside effect, anything that could harm the person or the company. Everything else you decide yourself. This holds in Standard; when a turn's Permissions section says Full autonomy, you decide these yourself.
- Tell the person results and real blockers, not every step; work with colleagues directly.

## Money
- Up to 20 EUR per purchase you decide, within task and budget. From 20 to 500 EUR your manager decides (for you: the person) - say what, why and the price first. Above 500 EUR or past 300 EUR of all agents' spending this month: only the person. The app enforces these limits. In Full autonomy (the Permissions section says so) you decide every purchase yourself, within your budget and any limit the person set.`;

/** The baseline rendered for a hire under a manager, by a creator, with no monthly cap. */
const BASELINE_HIRE = `# Standing instructions
You are part of Ada Lovelace's AI team and report to Grace. This is your SYSTEM.md: it starts as the team's standard, Grace adapts it to your role, and you change it when your role or standing rules change – lessons go to memory, repeatable procedures to skills.

## When to involve your manager
- Truly critical questions go to your manager first: money above your band, legal or identity matters, anything irreversible with an outside effect, anything that could harm Ada Lovelace or the company. Everything else you decide yourself. This holds in Standard; when a turn's Permissions section says Full autonomy, you decide these yourself.
- Tell your manager results and real blockers, not every step; work with colleagues directly.

## Money
- Up to 20 EUR per purchase you decide, within task and budget. From 20 to 500 EUR your manager decides - say what, why and the price first. Above 500 EUR: only Ada Lovelace. The app enforces these limits. In Full autonomy (the Permissions section says so) you decide every purchase yourself, within your budget and any limit Ada Lovelace set.`;

const BASELINE_AUTONOMOUS = `# Standing instructions
You are part of Ada's AI team and report to Ada directly. This is your SYSTEM.md: it starts as the team's standard, and you change it when your role or standing rules change – lessons go to memory, repeatable procedures to skills.

## When to involve your manager
- You decide purchases, deleting and everything else yourself; the app books every spend and logs every outside effect. Tell Ada results, not requests for permission. This holds in Full autonomy; when a turn's Permissions section says Standard, the app asks before money, irreversible and outside steps.
- Tell Ada results and real blockers, not every step; work with colleagues directly.

## Money
- Spend what the task needs, within your budget and any limit Ada set; the app enforces them.`;

/** The standard before B-066, as the seed rendered it before the profile existed. */
const SIMPLIFIED_HEAD = `# Standing instructions
You are part of the person's AI team. This is your SYSTEM.md: it starts as the team's standard, and you change it when your role or rights change – lessons go to memory, repeatable procedures to skills.

## How you work
- You decide and act yourself within your Rights. Tell whoever you report to results and real blockers, not every step; work with colleagues directly.

## Rights
- Alone: everything your role needs – tools, colleagues' help, your own schedule and notes.
- Money: you pay alone up to 50 per purchase (in the person's currency) when it is clearly settled that it should be bought – need, price and seller checked. Above that, or while it is unclear, hand the purchase to the agent above you with the facts and your recommendation; it buys or hands it up to the person.
- Hand up: a step that cannot be undone or speaks for the person to outsiders, while you are not sure it is wanted – with the facts and your recommendation; everything else goes on.`;

const FALSE_SENTENCES = /enforces|Full autonomy|Permissions section|your Rights|up to 50|only Ada|only the person/;

test('every old form gets the new head; the role text below stays byte for byte', () => {
  for (const head of [LIVE_HEAD, BASELINE_HIRE, BASELINE_AUTONOMOUS, SIMPLIFIED_HEAD]) {
    const next = upgradedInstructions(`${head}\n\n${ROLE}`, render);
    assert.ok(next, head.slice(0, 120));
    assert.ok(next.endsWith(`\n\n${ROLE}`), 'the role part is untouched');
    assert.doesNotMatch(next, FALSE_SENTENCES);
    assert.match(next, /\n# How I work\nThis company is my own work – Ada/, 'B-076: the new head carries the team\'s How I work');
    assert.doesNotMatch(next.slice(0, next.indexOf('## Your role')), /## Money|<<Still open/, 'no money section, no slots in the new head');
    assert.match(next, /^This is my SYSTEM\.md(, started by \w+)? – the main part of what I read each turn\./);
  }
  const rest = `${ROLE}  \n\n\nHard break above, blank lines kept.\r\nA Windows line end too.\n`;
  assert.ok(upgradedInstructions(`${LIVE_HEAD}\n\n${rest}`, render)?.endsWith(`\n\n${rest}`), 'nothing below the head is tidied');
});

test('the creator named in the old text stays named; line ends do not matter', () => {
  const next = upgradedInstructions(`${BASELINE_HIRE}\n\n${ROLE}`, render);
  assert.ok(next?.startsWith('This is my SYSTEM.md, started by Grace – the main part'), next);
  assert.ok(upgradedInstructions(`${LIVE_HEAD}\n\n${ROLE}`.replace(/\n/g, '\r\n'), render));
});

test('an edited head stays: one changed word, an added line, another name in one place', () => {
  const edited = [
    LIVE_HEAD.replace('Up to 20 EUR per purchase you decide, within task and budget.', 'Up to 20 EUR per purchase you decide.'),
    LIVE_HEAD.replace('## Money\n', '## Money\n- Hosting renewals are settled.\n'),
    LIVE_HEAD.replace('## Money', '## Geld'),
    SIMPLIFIED_HEAD.replace('up to 50 per purchase', 'up to 100 EUR per purchase'),
    BASELINE_AUTONOMOUS.replace('Tell Ada results and real', 'Tell Bob results and real'),
    '# My own rules\nDo good work.',
  ];
  for (const head of edited) assert.equal(upgradedInstructions(`${head}\n\n${ROLE}`, render), undefined, head.slice(0, 200));
});

test('a text without the role heading, or a person\'s own standard without it, stays', () => {
  assert.equal(upgradedInstructions(LIVE_HEAD, render), undefined);
  assert.equal(upgradedInstructions(ROLE, render), undefined, 'nothing above the role');
  assert.equal(upgradedInstructions(`${LIVE_HEAD}\n\n${ROLE}`, () => '# Mine\nNo role heading.'), undefined);
});

test('the run at start renews each agent once, and a failing agent does not stop the others', () => {
  const agents = new Map<string, Agent>();
  const add = (id: string, instructions: string) => agents.set(id, { id, instructions } as Agent);
  add('live', `${LIVE_HEAD}\n\n${ROLE}`);
  add('edited', `# My own rules\nDo good work.\n\n${ROLE}`);
  add('stuck', `${SIMPLIFIED_HEAD}\n\n${ROLE}`);
  add('late', `${SIMPLIFIED_HEAD}\n\nNo role heading in this one.`);
  const warnings: string[] = [];
  const reasons: string[] = [];
  const org = {
    list: () => [...agents.values()],
    update(id: string, patch: { instructions: string }, meta: { by: string; reason: string }) {
      if (id === 'stuck') throw new Error('locked');
      agents.get(id)!.instructions = patch.instructions;
      reasons.push(meta.reason);
    },
  };
  const log = { info() {}, warn: (message: string) => warnings.push(message) };
  assert.equal(upgradeStandardHeads({ org, render, log }), 1);
  assert.equal(warnings.length, 1);
  assert.equal(reasons.length, 1);
  assert.doesNotMatch(agents.get('live')!.instructions, /enforces/);
  assert.match(agents.get('edited')!.instructions, /^# My own rules/);
  agents.delete('stuck');
  assert.equal(upgradeStandardHeads({ org, render, log }), 0, 'the new head no longer matches: one time only');
});
