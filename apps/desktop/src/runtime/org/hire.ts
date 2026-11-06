// Hiring (OrgService.create): the new agent, checked against the org before anything is saved. Any agent may hire:
// the new agent reports to the creator unless another manager is named. A template that reports to the human (the
// secretary) is a step apart from the company: hired by an agent she still works for the person (role, mode and
// instructions come from the template only). Placed in the template's area (areaKind/forKind in
// org/spaces.ts), a same-kind manager's first.
// B-044 (contract decision 10) / B-047 (D9) / B-066: every new agent starts with the team's standard SYSTEM.md
// (resources/prompts/agent-default.md, or the person's own version in <data>/prompts; rendered with the hire's creator
// and role, never the manager, who changes). B-076: that standard is the whole standing text – the team's "How I work",
// then "## My role" with the template's or creator's instructions right below the role line, then "## What I have here"
// (org/system-parts.ts). B-078 (D15): the creator's instructions are the new agent's "who you are"; from then on its own
// part is its own; for a template hire by an agent it stands below the template's body (withTemplateBody). Text that already holds the team's "# How I work" (the heading of the rules in force) gets it no
// second time – nothing else counts (live 06.11.: an old "# Standing instructions" copy that held the standard's first
// line was taken for the standard and left two agents without it). When the standard would not fit next to the
// instructions, the hire keeps its instructions and the left-out standard is reported (warn), never dropped silently.
// Nothing here enforces any of that text. Existing agents with an old standard: org/standard-upgrade.ts.
// B-047 (D9): a hire without a name gets a free human first name (org/first-names.ts); a taken name gets a number;
// the template's role stays its role.
// Owns: these hiring rules and the new agent's fields. Never: saves it or emits events
// (org/service.ts), or reads the database itself – the org facts come from the caller.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import type { Agent, AgentTemplate, Space } from '../../shared/model/org.ts';
import type { Settings } from '../../shared/model/system.ts';
import type { OrgService } from '../contracts.ts';
import { defaultAvatar } from './avatar.ts';
import { freeFirstName } from './first-names.ts';
import { areaKind } from './spaces.ts';
import { hasHavePart, hasWorkStandard, isRoleHeading, ROLE_LINE, roleLineIndex, rulesHeading, splitAtHave } from './system-parts.ts';
import { cleanMode, cleanName, cleanSkills, cleanText } from './validate.ts';

export type CreateInput = Parameters<OrgService['create']>[0];

/** The org facts a hire is checked against. */
export interface HireFacts {
  template(key: string): AgentTemplate | undefined;
  /** Throws when the org is full. */
  checkRoom(): void;
  requireActive(id: string): Agent;
  nameTaken(name: string): boolean;
  uniqueName(base: string): string;
  space(id: string): Space | undefined;
  /** The active space of an area kind (created on demand), near the manager's space. */
  spaceForKind(kind: Space['kind'], near?: string): Space | undefined;
  now(): number;
  /**
   * B-044/B-047: the standard SYSTEM.md every new agent starts with (rendered agent-default prompt) – `values`
   * adds the hire's creator and role names; absent or '' = none. No manager: it changes, "Who I am" has the live one.
   */
  standingRules?(values?: Readonly<Record<string, string>>): string | undefined;
  /** B-047: something the hire had to leave out (the standard text that did not fit). */
  warn?(message: string, details: Record<string, unknown>): void;
}

/** The longest instructions a hire takes (cleanText's limit below). */
const MAX_INSTRUCTIONS = 20000;

/** B-044: the agent-default prompt's values from the settings (the person's name or "the person"). */
export function standingRuleValues(settings: Pick<Settings, 'profile'>): Record<string, string> {
  const owner = settings.profile.name.trim() || 'the person';
  const company = settings.profile.company?.trim() ?? '';
  return { owner, user_name: owner, ...(company ? { company } : {}) }; // company: for an own rules.md that names it
}

/**
 * `body` inside the standing rules: the standard above it, its "## What I have here" part below it (B-076) – not twice
 * (a text that holds "# How I work" keeps its own), and only when everything fits.
 */
export function withStandingRules(body: string, rules: string | undefined): string {
  const standard = rules?.trim();
  if (!standard) return body;
  if (hasWorkStandard(body, standard)) return body;
  const { head, tail } = splitAtHave(standard);
  const own = body.trim();
  // B-076 live run: a creator that starts its text with "## My role" writes the whole own part – it takes the place of the
  // standard's role heading and line instead of standing under a second one.
  const ownHasRole = isRoleHeading(own.split('\n', 1)[0] ?? '');
  const headLines = head.split('\n');
  const roleAt = roleLineIndex(headLines);
  const above = ownHasRole && roleAt >= 0 ? headLines.slice(0, roleAt).join('\n').trim() : head;
  const text = [above, own, own && hasHavePart(own) ? '' : tail].filter(Boolean).join('\n\n');
  return text.length <= MAX_INSTRUCTIONS ? text : body;
}

/**
 * B-078: a SYSTEM.md that lost the team's standard gets it back on top (agents.update, the startup repair). Only a
 * standard with its own top-level heading and a role heading is put back – the first is how the next look finds it, so
 * this never stacks; without the second the own text would have no place, so nothing is guessed in.
 */
export function withStandardHead(body: string, standard: string | undefined): string {
  return rulesHeading(standard) === undefined || !ROLE_LINE.test(standard ?? '') ? body : withStandingRules(body, standard);
}

/**
 * B-078 review: an agent's "who you are" for a template hire joins the template's body, as patterns/library.ts does –
 * a head keeps head.md. The body goes first; an own part that starts with the role heading keeps it on top and gets the
 * body before its "## What I have here". A whole SYSTEM.md or a text that already holds the body is taken as it is.
 */
export function withTemplateBody(own: string, base: string | undefined): string {
  const body = base?.trim() ?? '';
  const text = own.trim();
  if (!body || !text || hasWorkStandard(text) || text.includes(body)) return own;
  if (!isRoleHeading(text.split('\n', 1)[0] ?? '')) return `${body}\n\n${text}`;
  const { head, tail } = splitAtHave(text);
  return [head, body, tail].filter(Boolean).join('\n\n');
}

/** B-047: true when withStandingRules leaves the rules out only because both would not fit (worth a warning). */
export function standingRulesLeftOut(body: string, rules: string | undefined): boolean {
  const standard = rules?.trim();
  if (!standard) return false;
  return withStandingRules(body, rules) === body && !hasWorkStandard(body, standard);
}

/** B-047: the values the standard SYSTEM.md is rendered with for one hire ('' = none: the prompt leaves that part out). */
export function hireValues(input: { creator?: Pick<Agent, 'name'>; role: string; name?: string }): Record<string, string> {
  // B-076: an own rules.md may name the agent ({{agent_name}}); the shipped one does not.
  return { creator: input.creator?.name ?? '', role: input.role, ...(input.role ? { agent_role: input.role } : {}), ...(input.name ? { agent_name: input.name } : {}) };
}

/** The agent `input` hires, validated; throws a user-safe WorkforceError. */
export function hiredAgent(input: CreateInput, org: HireFacts): Agent {
  const template = input.template ? org.template(input.template) : undefined;
  if (input.template && !template) throw new WorkforceError('not_found', 'This agent template does not exist.', { details: { template: input.template } });
  org.checkRoom();
  const creator = input.createdBy;
  if (creator !== HUMAN_ID) org.requireActive(creator);

  const toHuman = template?.reportsTo === 'human';
  const managerId = toHuman ? undefined : input.managerId ?? (creator === HUMAN_ID ? undefined : creator);
  const boss = managerId ? org.requireActive(managerId) : undefined;
  const given: Pick<CreateInput, 'role' | 'instructions' | 'mode'> = toHuman && creator !== HUMAN_ID ? {} : input;

  const now = org.now();
  const id = newId('ag', now);
  // B-047 (D9): no name given – a free human first name (the template's role stays the role); all taken – the old "Writer 2".
  let name = cleanName(input.name ?? freeFirstName(id, (candidate) => org.nameTaken(candidate)) ?? template?.name ?? 'Agent');
  if (org.nameTaken(name)) name = org.uniqueName(name);
  const target = input.spaceId ? org.space(input.spaceId) : undefined;
  if (input.spaceId && !target) throw new WorkforceError('not_found', 'This space no longer exists.');
  if (target?.archivedAt) throw new WorkforceError('conflict', 'This space is archived.');
  const role = cleanText(given.role ?? template?.role ?? '', 'role', 80).trim();
  const own = given.instructions === undefined ? undefined : cleanText(given.instructions, 'instructions', MAX_INSTRUCTIONS);
  const joined = creator !== HUMAN_ID && own !== undefined ? withTemplateBody(own, template?.instructions) : undefined;
  const body = joined !== undefined && joined.length <= MAX_INSTRUCTIONS ? joined : cleanText(own ?? template?.instructions ?? '', 'instructions', MAX_INSTRUCTIONS);
  const creatorAgent = creator === HUMAN_ID || toHuman ? undefined : org.requireActive(creator); // the secretary's text is no creator's to adapt
  const rules = org.standingRules?.(hireValues({ creator: creatorAgent, role, name }));
  if (standingRulesLeftOut(body, rules)) {
    org.warn?.('the standard instructions did not fit next to the hire\'s instructions and were left out', { name, chars: body.length, max: MAX_INSTRUCTIONS });
  }
  const agent: Agent = {
    id,
    name,
    role,
    avatar: defaultAvatar(id, name),
    spaceId: input.spaceId,
    managerId,
    instructions: withStandingRules(body, rules),
    mode: cleanMode(given.mode ?? template?.mode ?? 'general'),
    skills: template ? cleanSkills(template.skills) : [],
    modelPolicy: template?.effort ? { effort: template.effort } : {},
    status: 'idle',
    template: template?.key,
    createdBy: creator,
    createdAt: now,
    updatedAt: now,
  };
  // After validation (no space left behind by a refused hire): the area, a same-kind manager's first.
  const area = areaKind(template);
  if (!agent.spaceId && area) agent.spaceId = org.spaceForKind(area, boss?.spaceId)?.id;
  if (!agent.spaceId) delete agent.spaceId;
  if (!agent.managerId) delete agent.managerId;
  if (!agent.template) delete agent.template;
  return agent;
}
