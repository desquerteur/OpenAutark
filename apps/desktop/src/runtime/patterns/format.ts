// Team pattern files (resources/patterns/*.md, saved and imported patterns): front matter (name,
// description, version, tags, optional; B-047 D7: the first run picks no team, so a `start` key is
// read like any other unknown one – ignored) + notes for the manager + one "## <Agent name>" section per role, whose first
// lines may set template, role, mode, reportsTo, skills and optional; the rest of a section is that
// agent's instructions (added after its template's).
//
//   ---
//   name: Research team
//   description: A research lead and two researchers.
//   version: 1
//   ---
//   When it fits and how to grow it …
//
//   ## Research lead
//   template: researcher
//   (also: companionOf: <agent> – a companion on that agent's work, the counter-role)
//   role: Research lead
//   Plans the questions …
//
// Owns: parsing and writing this format. Never: grants rights – permission, budget, tool or
// credential lines are dropped and named in the report.

import { WorkforceError } from '../../shared/errors.ts';
import type { Agent } from '../../shared/model/org.ts';
import { PATTERN_MAX_CHARS } from '../../shared/model/team-start.ts';
import { isPermissionField, isSecretField, scrubSecrets } from '../importers/scrub.ts';
import { asList, asText, frontMatter } from '../importers/yaml-lite.ts';

export interface PatternRole {
  name: string;
  template?: string;
  role?: string;
  mode?: string;
  reportsTo?: string;
  companionOf?: string;
  skills: string[];
  optional: boolean;
  body: string;
}

export interface ParsedPattern {
  name: string;
  description: string;
  version: string;
  tags: string[];
  optional: boolean;
  guide: string;
  roles: PatternRole[];
  dropped: string[];
  secretsRemoved: number;
}

const ROLE_KEYS = new Set(['template', 'role', 'mode', 'reportsto', 'reports to', 'companionof', 'companion of', 'skills', 'optional']);
const KEY_LINE = /^([A-Za-z][A-Za-z _-]{0,30}):\s*(.*)$/;
const RIGHTS = /^(budget|grants?|autonomy|approvals?|spend|money|permissions?|permission[ _-]?mode|tools|allowed[ _-]?tools|mcp[ _-]?servers|hooks)$/i;
const MAX_ROLES = 30;

const truthy = (value: string | undefined) => /^(true|yes|1)$/i.test((value ?? '').trim());

function role(heading: string, text: string, dropped: string[]): PatternRole {
  const out: PatternRole = { name: heading.replace(/\*\*/g, '').trim().slice(0, 80), skills: [], optional: false, body: '' };
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index++;
  for (; index < lines.length; index++) {
    const match = KEY_LINE.exec(lines[index].trim());
    if (!match) break;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (ROLE_KEYS.has(key)) {
      if (key === 'template') out.template = value || undefined;
      else if (key === 'role') out.role = value.slice(0, 80) || undefined;
      else if (key === 'mode') out.mode = value || undefined;
      else if (key === 'skills') out.skills = asList(value.replace(/^\[|\]$/g, ''));
      else if (key === 'optional') out.optional = truthy(value);
      else if (key.startsWith('companion')) out.companionOf = value || undefined;
      else out.reportsTo = value || undefined;
    } else if (isSecretField(key) || RIGHTS.test(key)) {
      dropped.push(`${out.name}: "${match[1].trim()}" (rights, budgets and credentials are set in this app)`);
    } else break; // ordinary text that happens to contain a colon: the instructions start here
  }
  out.body = lines.slice(index).join('\n').trim();
  return out;
}

/** Parses a pattern file; throws a user-safe error when it is not one. */
export function parsePattern(source: string): ParsedPattern {
  if (source.length > PATTERN_MAX_CHARS) throw new WorkforceError('bad_request', 'This pattern is too large.');
  const scrubbed = scrubSecrets(source);
  const parsed = frontMatter(scrubbed.text);
  const name = asText(parsed?.data.name);
  if (!parsed || !name) throw new WorkforceError('bad_request', 'A pattern starts with front matter that has a name.');
  const parts = parsed.body.split(/^##\s+(.+)$/m);
  const dropped: string[] = [];
  const roles: PatternRole[] = [];
  for (let i = 1; i < parts.length && roles.length < MAX_ROLES; i += 2) roles.push(role(parts[i], parts[i + 1] ?? '', dropped));
  if (!roles.length) throw new WorkforceError('bad_request', 'A pattern has at least one "## <agent>" section.');
  for (const key of Object.keys(parsed.data)) {
    if (isSecretField(key) || isPermissionField(key) || RIGHTS.test(key)) dropped.push(`"${key}" (rights, budgets and credentials are set in this app)`);
  }
  return {
    name: name.slice(0, 80),
    description: (asText(parsed.data.description) ?? '').slice(0, 500),
    version: (asText(parsed.data.version) ?? '1').slice(0, 32),
    tags: asList(parsed.data.tags).slice(0, 12).map((tag) => tag.slice(0, 40)),
    optional: truthy(asText(parsed.data.optional)),
    guide: parts[0].trim(),
    roles,
    dropped,
    secretsRemoved: scrubbed.count,
  };
}

/** The scrubbed source to store (secrets never reach the database). */
export function storedText(source: string): string {
  return scrubSecrets(source).text;
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const line = (key: string, value: string | undefined) => (value ? `${key}: ${oneLine(value)}\n` : '');
/** A front-matter scalar in double quotes (yaml-lite's scalar() reads \" and \\), so '#' or ':' stay text. */
const quote = (value: string) => `"${oneLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** Instructions as a section body: their own "## " headings become "### " so they never start a new role. */
const body = (text: string) => text.replace(/^##(?=\s)/gm, '###');

/**
 * A pattern of agents of this org: role, mode, template, skills, reporting lines inside the set and
 * instructions – never ids, permissions, budgets, devices, accounts or knowledge. Round-trips
 * through parsePattern: quoted front matter, a role line in every section (so instructions that
 * start with "Word: …" stay instructions) and demoted "## " headings inside instructions.
 */
export function patternFromAgents(input: { name: string; description: string; version: string; agents: readonly Agent[]; companionOf?: ReadonlyMap<string, string> }): string {
  const names = new Map(input.agents.map((agent) => [agent.id, agent.name]));
  const head = `---\nname: ${quote(input.name)}\ndescription: ${quote(input.description)}\nversion: ${quote(input.version)}\n---\n`;
  const sections = input.agents.map((agent) => {
    const reportsTo = agent.managerId ? names.get(agent.managerId) : undefined;
    return `## ${oneLine(agent.name)}\n${line('template', agent.template)}${line('role', agent.role || agent.name)}${line('mode', agent.mode)}${line('reportsTo', reportsTo)}${line('companionOf', names.get(input.companionOf?.get(agent.id) ?? ''))}${line('skills', agent.skills.join(', '))}\n${body(scrubSecrets(agent.instructions).text.trim())}\n`;
  });
  return `${head}\n${sections.join('\n')}`;
}
