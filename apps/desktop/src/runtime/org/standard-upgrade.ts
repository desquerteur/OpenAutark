// One-time upgrade of the standard SYSTEM.md (B-066): an agent hired earlier holds a frozen copy of the standard of its
// day, some with sentences that are no longer true ("The app enforces these limits", "Full autonomy", a Permissions
// section). At runtime start an agent whose head – everything above the line "## Your role" – is exactly one of the old
// standards gets the new head; its role text below that line stays untouched. "Exactly" means the shipped forms below
// (OLD, the live install's form, PRE), compared after normalising what the render filled in (names, amounts): a head the
// person or the agent edited in any other way stays as it is. A new head no longer matches, so no marker is needed.
// Owns: the old forms and exact-head recognition, also used by the ongoing updater (org/prompt-updates.ts).
// Never: rewrites anything below "## Your role" or an edited head.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { Agent } from '../../shared/model/org.ts';
import { renderTemplate } from '../context/templates.ts';
import { roleLineIndex } from './system-parts.ts';

/** The baseline before the 31.10. simplification (OLD/resources/prompts/agent-default.md, above "## Your role"). */
const BASELINE = `# Standing instructions
You are part of {{owner}}'s AI team{{#manager}} and report to {{manager}}{{/manager}}{{^manager}} and report to {{owner}} directly{{/manager}}. This is your SYSTEM.md: it starts as the team's standard{{#creator}}, {{creator}} adapts it to your role{{/creator}}, and you change it when your role or standing rules change – lessons go to memory, repeatable procedures to skills.

## When to involve your manager
{{^autonomous}}- Truly critical questions go to {{#manager}}your manager{{/manager}}{{^manager}}{{owner}}{{/manager}} first: money above your band, legal or identity matters, anything irreversible with an outside effect, anything that could harm {{owner}} or the company. Everything else you decide yourself. This holds in Standard; when a turn's Permissions section says Full autonomy, you decide these yourself.{{/autonomous}}
{{#autonomous}}- You decide purchases, deleting and everything else yourself; the app books every spend and logs every outside effect. Tell {{owner}} results, not requests for permission. This holds in Full autonomy; when a turn's Permissions section says Standard, the app asks before money, irreversible and outside steps.{{/autonomous}}
- Tell {{#manager}}your manager{{/manager}}{{^manager}}{{owner}}{{/manager}} results and real blockers, not every step; work with colleagues directly.

## Money
{{^autonomous}}- Up to {{money_self}} {{currency}} per purchase you decide, within task and budget. From {{money_self}} to {{money_manager}} {{currency}} your manager decides{{^manager}} (for you: {{owner}}){{/manager}} - say what, why and the price first. Above {{money_manager}} {{currency}}{{#money_cap}} or past {{money_cap}} {{currency}} of all agents' spending this month{{/money_cap}}: only {{owner}}. The app enforces these limits. In Full autonomy (the Permissions section says so) you decide every purchase yourself, within your budget and any limit {{owner}} set.{{/autonomous}}
{{#autonomous}}- Spend what the task needs, within your budget and any limit {{owner}} set; the app enforces them.{{/autonomous}}`;

/** The same standard with the older first paragraph ("you keep it current as you learn"): what the owner's live Manager holds. */
const LIVE = BASELINE.replace(
  'and you change it when your role or standing rules change – lessons go to memory, repeatable procedures to skills.',
  'and you keep it current as you learn.',
);

/** The standard between the 31.10. simplification and B-066 (PRE/resources/prompts/agent-default.md). */
const SIMPLIFIED = `# Standing instructions
You are part of {{owner}}'s AI team. This is your SYSTEM.md: it starts as the team's standard{{#creator}}, {{creator}} adapts it to your role{{/creator}}, and you change it when your role or rights change – lessons go to memory, repeatable procedures to skills.

## How you work
- You decide and act yourself within your Rights. Tell whoever you report to results and real blockers, not every step; work with colleagues directly.

## Rights
- Alone: everything your role needs – tools, colleagues' help, your own schedule and notes.
- Money: you pay alone up to 50 per purchase (in {{owner}}'s currency) when it is clearly settled that it should be bought – need, price and seller checked. Above that, or while it is unclear, hand the purchase to the agent above you with the facts and your recommendation; it buys or hands it up to {{owner}}.
- Hand up: a step that cannot be undone or speaks for {{owner}} to outsiders, while you are not sure it is wanted – with the facts and your recommendation; everything else goes on.`;

/** The last untracked standard (B-066); installations may skip the release that first remembers defaults. */
const UNTRACKED = `# Standing instructions
This is your SYSTEM.md{{#creator}}, started by {{creator}}{{/creator}}. You keep it current as your role grows; lessons go to memory, ways of working that worked go to skills.

## How you work
Look at what is known, decide, act, say what changed. Whoever you report to wants results and real blockers; colleagues you work with directly. What worked, leave behind: a skill improved, a note corrected.
<<Still open: how you recognise this role going well, and what counts most when two good things conflict, for instance "speed before polish while the offer is being tested".>>

## Who and what you work with
<<Still open: the colleagues, folders and accounts of this work, and an earlier piece that shows what good looks like here.>>

## Money
The money skill shows how this team weighs a purchase.
<<Still open: any standing agreement, for instance "hosting renewals are settled".>>`;

/** B-076: the B-075 first-person standard (0.3.2) – an install whose hire record is lost still renews it. */
const FIRST_PERSON = `# Standing instructions
This is my SYSTEM.md{{#creator}}, started by {{creator}}{{/creator}}. I keep it current as my role grows; lessons go to memory, ways of working that worked go to skills.

## How I work
I look at what is known, decide, act, say what changed. To whoever I report to I bring results and real blockers; with colleagues I work directly. What worked, I leave behind: a skill improved, a note corrected.
<<Still open: how I recognise this role going well, and what counts most when two good things conflict, for instance "speed before polish while the offer is being tested".>>

## Who and what I work with
<<Still open: the colleagues, folders and accounts of this work, and an earlier piece that shows what good looks like here.>>

## Money
The money skill shows how this team weighs a purchase.
<<Still open: any standing agreement, for instance "hosting renewals are settled".>>`;

const MARK = '\u0002';
const AMOUNTS = new Set(['money_self', 'money_manager', 'money_cap']);

const groupFor = (key: string): string => (AMOUNTS.has(key) ? '[0-9][0-9.,]*' : key === 'currency' ? '[^\\s]{1,8}' : '[^\\n]{1,80}?');

/** Every render of `template` as a whole-text pattern: a filled-in value matches any name, and the same value each time. */
function renderedForms(template: string): RegExp[] {
  const keys = [...new Set([...template.matchAll(/\{\{[#^/]?([a-z_]+)\}\}/g)].map((match) => match[1]))];
  const flags = keys.filter((key) => template.includes(`{{#${key}}}`) || template.includes(`{{^${key}}}`));
  const forms: RegExp[] = [];
  for (let bits = 0; bits < 2 ** flags.length; bits++) {
    const values: Record<string, string> = {};
    for (const key of keys) values[key] = `${MARK}${key}${MARK}`;
    flags.forEach((key, index) => { if (!(bits & (1 << index))) values[key] = ''; });
    const seen = new Set<string>();
    const source = renderTemplate(template, values)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(new RegExp(`${MARK}([a-z_]+)${MARK}`, 'g'), (_all, key: string) => {
        if (seen.has(key)) return `\\k<${key}>`;
        seen.add(key);
        return `(?<${key}>${groupFor(key)})`;
      });
    forms.push(new RegExp(`^${source}$`));
  }
  return forms;
}

let oldForms: RegExp[] | undefined;
const knownForms = (): RegExp[] => (oldForms ??= [BASELINE, LIVE, SIMPLIFIED].flatMap(renderedForms));

const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();

/** The line index of the role heading ("## My role", older "## Your role"), or -1. */
function roleLine(lines: readonly string[]): number {
  return roleLineIndex(lines);
}

/** Recognizes an untouched standard head, including saved defaults; returns the original role suffix unchanged. */
export function standardHead(instructions: string, templates: readonly string[]): { creator: string; suffix: string } | undefined {
  const lines = instructions.split('\n');
  const at = roleLine(lines);
  if (at < 1) return undefined;
  const head = tidy(lines.slice(0, at).join('\n'));
  const forms = [...knownForms(), ...[UNTRACKED, FIRST_PERSON, ...templates].flatMap((template) => {
    const parts = tidy(template).split('\n');
    const role = roleLine(parts);
    return renderedForms((role < 0 ? parts : parts.slice(0, role)).join('\n').trim());
  })];
  for (const form of forms) {
    const match = form.exec(head);
    if (match) return { creator: match.groups?.creator ?? '', suffix: lines.slice(at).join('\n') };
  }
  return undefined;
}

/**
 * `instructions` with the new head when its head is an old standard's exact form, else undefined. `render` gives the
 * standard in force for these values (the shipped one or the person's own version).
 */
export function upgradedInstructions(instructions: string, render: (values: Readonly<Record<string, string>>) => string | undefined): string | undefined {
  const lines = instructions.split('\n'); // the part below stays byte for byte
  const at = roleLine(lines);
  if (at < 1) return undefined;
  const head = tidy(lines.slice(0, at).join('\n'));
  let creator: string | undefined;
  if (!knownForms().some((form) => {
    const match = form.exec(head);
    creator = match?.groups?.creator;
    return Boolean(match);
  })) return undefined;
  const standard = tidy(render({ creator: creator ?? '', role: '' }) ?? '').split('\n');
  const newAt = roleLine(standard);
  if (newAt < 1) return undefined; // a person's own standard without the heading: nothing to swap in
  return `${standard.slice(0, newAt).join('\n').trim()}\n\n${lines.slice(at).join('\n')}`;
}

export interface StandardUpgradeFacts {
  org: {
    list(filter: { includeArchived: boolean }): Agent[];
    update(id: string, patch: { instructions: string }, meta: { by: string; reason: string }): unknown;
  };
  render(values: Readonly<Record<string, string>>): string | undefined;
  log: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

/** Runtime start, after the agent folders are reconciled: every agent with an old standard gets the new head; returns how many. */
export function upgradeStandardHeads(facts: StandardUpgradeFacts): number {
  let upgraded = 0;
  try {
    for (const agent of facts.org.list({ includeArchived: true })) {
      const next = upgradedInstructions(agent.instructions, facts.render);
      if (next === undefined) continue;
      try {
        facts.org.update(agent.id, { instructions: next }, { by: HUMAN_ID, reason: 'The app renewed the standard part of SYSTEM.md.' });
        upgraded++;
      } catch (error) {
        facts.log.warn('standard SYSTEM.md head not renewed', { agentId: agent.id, error: String(error) });
      }
    }
  } catch (error) {
    facts.log.warn('standard SYSTEM.md heads not checked', { error: String(error) });
  }
  if (upgraded) facts.log.info('standard SYSTEM.md head renewed', { agents: upgraded });
  return upgraded;
}
