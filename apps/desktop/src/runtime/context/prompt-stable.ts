// The STABLE system-prompt section, in a fixed order: (1) identity + org placement (facts only),
// (2) B-076: the agent's SYSTEM.md as the main part – the team's "How I work", its role and what it has here, in one voice
// (agent-core/prompt.ts coreInstructions); an older or own SYSTEM.md without "# How I work" gets the rules live above it
// under "## My instructions" until its prompt update; (3) the rich-answer line from the block catalog (tier by model; it
// names the ui.help guide by its exposed name `ui__help` when the agent's mode offers it, F08; B-049 F5: one line,
// the quick reference is ui.help "blocks"),
// (4) the mode, (6) B-044: its folder and the system map (agent-core/prompt.ts "My folder"),
// (7) B-047 D6: "My environment" (context/environment.ts: this PC, the workspace, how to search the web, screen tools),
// (8) its Main Skills (names + descriptions, agent-core/prompt.ts), (9) B-049 F5: one skills fact line (skills.find /
// skills.load) instead of the index itself – B-059: without the number, so a new or retired skill (or lesson) never
// changes the stable text and renews the agent's native sessions; only an empty ↔ non-empty index does. B-078 D12: the
// always-visible skills joined the pinned notes in one always set with one cap (knowledge/always.ts, volatile).
// The identity/rules values carry the has_<tool> flags of the turn's tool offer (environment.ts toolFlags), so a
// principle that names a tool renders only where it is offered.
// Owns: the placeholder values and section order. Deterministic: the same agent, mode, model
// tier and settings give byte-identical text, so providers can cache the prefix.
// Never: timestamps, task state, memory or anything else that changes per turn (volatile).

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { blockLine } from '../../shared/blocks/prompt.ts';
import type { PromptOptions } from '../../shared/blocks/prompt.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { toWireName } from '../engines/shared.ts';
import { UI_HELP_TOOL } from '../tools/builtin/ui.ts';
import type { PromptTemplates } from './templates.ts';
import '../contracts/people.ts';
import { coreFolderSection, coreInstructions, mainSkillsSection } from '../agent-core/prompt.ts';
import { environmentSection, languageName, offeredTools, toolFlags } from './environment.ts';
import { hasWorkStandard } from '../org/system-parts.ts';

const MAX_REPORTS = 15;
const SKILL_DESCRIPTION_CHARS = 300;

export { languageName };

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

/** Placeholder values for the identity/rules templates. */
export function identityValues(services: RuntimeServices, agent: Agent): Record<string, string> {
  const profile = safe(() => services.settings.get().profile, undefined);
  const name = profile?.name?.trim() ?? '';
  const boss = agent.managerId ? safe(() => services.people?.get(agent.managerId!), undefined) : undefined; // F-52: a person may manage an agent
  const manager = boss && !boss.owner ? { name: `${boss.name} (colleague, ${agent.managerId})`, role: boss.title }
    : agent.managerId ? safe(() => services.org.get(agent.managerId!), undefined) : undefined;
  const space = agent.spaceId ? safe(() => services.org.spaces().find((item) => item.id === agent.spaceId), undefined) : undefined;
  const reports = safe(() => services.org.list(), [] as Agent[])
    .filter((item) => item.managerId === agent.id && !item.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const reportText = reports.slice(0, MAX_REPORTS).map((item) => (item.role ? `${item.name} (${item.role})` : item.name)).join(', ')
    + (reports.length > MAX_REPORTS ? ` and ${reports.length - MAX_REPORTS} more` : '');
  return {
    agent_name: agent.name,
    agent_role: agent.role?.trim() ?? '',
    team: agent.team?.trim() ?? '',
    space: space?.name ?? '',
    manager_name: manager ? (manager.role ? `${manager.name} (${manager.role})` : manager.name) : '',
    reports: reportText,
    user_given: name ? 'yes' : '',
    user_name: name || 'the CEO',
    user_label: name || 'CEO',
    company: profile?.company?.trim() ?? '',
    language: languageName(profile?.language),
    timezone: profile?.timezone?.trim() ?? '',
  };
}

/**
 * Block-prompt options: tier for the routed model ('lite' for local/small, mini-apps only for
 * strong/frontier) and the ui.help tool under the name engines see – only when this agent's mode
 * really offers it (the same rule as the turn's tool offer), so the prompt never names a missing tool.
 */
export function blockOptions(services: RuntimeServices, input: { agent: Agent; mode: ModeInfo; route: RouteDecision }): PromptOptions {
  const tier = safe(() => services.catalog.get(input.route.modelId)?.tier, undefined);
  const offered = safe(() => services.tools.specsFor(input.agent, input.mode).some((spec) => spec.name === UI_HELP_TOOL), false);
  return {
    tier: tier === 'local' || tier === 'small' ? 'lite' : 'full',
    app: tier === 'strong' || tier === 'frontier',
    ...(offered ? { helpTool: toWireName(UI_HELP_TOOL) } : {}),
  };
}

/** Mode instructions without a leading "# <Mode> mode" heading (the section has its own). */
function modeBody(mode: ModeInfo): string {
  return mode.instructions.replace(/\r\n?/g, '\n').replace(/^\s*#\s[^\n]*\n+/, '').trim();
}

/** B-049 F5: the mode's one-line description only when it has no instructions (they say the same at length). */
export function modeSection(mode: ModeInfo): string {
  const lines = [`## Mode: ${mode.name}`];
  const body = modeBody(mode);
  if (body) lines.push(body);
  else if (mode.description.trim()) lines.push(mode.description.trim());
  return lines.join('\n');
}

/**
 * B-049 F5: one fact line – the tools that find and load the mode's skills (each named only when `offered` has it);
 * B-059: the default text names no count. `skills` and `count` stay for an own skills.md that renders them.
 * B-066: `always` – the few `metadata.always` skills by name and description, so "read this before spending money"
 * really reaches the main AI; only a change to one of those changes this text.
 */
export function skillsSection(services: RuntimeServices, templates: PromptTemplates, agent: Agent, mode: ModeInfo, offered: ReadonlySet<string> = offeredTools(services, agent, mode)): string {
  const skills = safe(() => services.skills.indexFor(agent, mode), []);
  if (!skills.length) return '';
  const line = (skill: SkillInfo) => `- ${skill.name} – ${excerpt(skill.description, SKILL_DESCRIPTION_CHARS)}`;
  const has = (name: string) => (offered.has(name) ? 'yes' : '');
  // B-078 D12: the always-skills moved into the one always set (knowledge/always.ts, the volatile "pinned" section); {{always}} stays '' for an own skills.md
  return templates.render('skills', { skills: skills.map(line).join('\n'), always: '', count: String(skills.length), has_skills_find: has('skills.find'), has_skills_load: has('skills.load') });
}

export function buildStable(services: RuntimeServices, templates: PromptTemplates, input: { agent: Agent; mode: ModeInfo; route: RouteDecision }): string {
  const { agent, mode, route } = input;
  const offered = offeredTools(services, agent, mode); // one offer for the flags and the environment (the turn's own rule)
  const values = { ...identityValues(services, agent), ...toolFlags(offered) };
  const sections = [templates.render('identity', values)];
  const own = coreInstructions(services, agent)?.trim();
  const redacted = own ? safe(() => services.secrets.redact(own), own) : '';
  if (own && hasWorkStandard(own, templates.get('rules'))) {
    sections.push(redacted); // B-076: SYSTEM.md is the main part – the team's "How I work", my role, what I have here
  } else {
    sections.push(templates.render('rules', values)); // an older or own SYSTEM.md without the standard: the rules live
    if (own) sections.push(`## My instructions\n${redacted}`);
  }
  sections.push(blockLine(blockOptions(services, { agent, mode, route }))); // B-049 F5: one line; the quick reference is ui.help "blocks"
  sections.push(modeSection(mode));
  sections.push(coreFolderSection(services, agent, mode)); // B-044: its folder, that it keeps it current, the home project
  sections.push(environmentSection(services, { agent, mode, route }, offered)); // B-047 D6: this PC, workspace, web, screen
  sections.push(mainSkillsSection(services, agent));
  sections.push(skillsSection(services, templates, agent, mode, offered));
  return sections.filter((section) => section.trim()).join('\n\n');
}
