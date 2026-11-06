// B-076: the agent's own part of SYSTEM.md (from the role heading on) brought to today's form once, when the app renews
// an untouched standard above it (org/prompt-updates.ts). The heading "## Your role" becomes "## My role"; a role text
// that is exactly one a template shipped before ("You are the person's chief of staff …", second person; B-078 the
// first-person chief of staff before the personal manager) becomes that template's text of today – compared without
// its "## What I have here" part, which stays as the agent keeps it; a missing one gets the standard's
// (org/system-parts.ts). Anything the person or the agent wrote themselves stays word for word.
// Owns: recognising the old shipped role texts (resources/agents/previous-bodies.json). Never: touches a role text that
// differs from a shipped one in any character, or the standard part above the role heading.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentTemplate } from '../../shared/model/org.ts';
import { HAVE_HEADING, isRoleHeading, ROLE_HEADING } from './system-parts.ts';

export const PREVIOUS_BODIES_FILE = 'previous-bodies.json';

/** The older shipped role texts per template key (empty when the file is missing or unreadable). */
export function loadPreviousBodies(templatesDir: string | undefined): Record<string, string[]> {
  if (!templatesDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(path.join(templatesDir, PREVIOUS_BODIES_FILE), 'utf8')) as { bodies?: Record<string, unknown> };
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed.bodies ?? {})) {
      if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === 'string').map((item) => tidy(item));
    }
    return out;
  } catch {
    return {};
  }
}

const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();

export interface RoleUpgradeFacts {
  /** The key of the template the agent was hired from, when known (Agent.template). */
  template?: string;
  /** Today's templates (their instructions are the new role texts). */
  templates: readonly Pick<AgentTemplate, 'key' | 'instructions'>[];
  /** Older shipped role texts per template key. */
  previous: Readonly<Record<string, readonly string[]>>;
  /** The standard's "## What I have here" part, rendered for this agent ('' = none). */
  have: string;
}

/**
 * `suffix` (the text from the role heading on) in today's form: the heading "## My role", an old shipped role text swapped
 * for today's, the what-I-have part added when missing. Returns the suffix unchanged when nothing applies.
 */
export function modernRoleSuffix(suffix: string, facts: RoleUpgradeFacts): string {
  const lines = suffix.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.length || !isRoleHeading(lines[0])) return suffix;
  const heading = ROLE_HEADING;
  // The hire wrote "<heading>\n<role>.\n\n<body>": the role line stays, the body is compared as a whole.
  const roleLine = lines[1]?.trim() && !lines[1].trim().startsWith('#') ? lines[1] : undefined;
  const rest = lines.slice(roleLine === undefined ? 1 : 2);
  const haveAt = rest.findIndex((line) => line.trim() === HAVE_HEADING);
  const ownHave = haveAt < 0 ? '' : rest.slice(haveAt).join('\n').trim(); // the agent's own facts: never compared or swapped
  let body = tidy((haveAt < 0 ? rest : rest.slice(0, haveAt)).join('\n'));
  let swapped = false;
  const keys = facts.template ? [facts.template] : Object.keys(facts.previous);
  for (const key of keys) {
    if (!(facts.previous[key] ?? []).includes(body)) continue;
    const today = facts.templates.find((template) => template.key === key)?.instructions;
    if (today?.trim()) { body = tidy(today); swapped = true; }
    break;
  }
  // Only on the way from the old form ("## Your role"): an own part already in today's form that dropped "What I have
  // here" did so on purpose and keeps it that way (verification 05.11.).
  const addHave = lines[0].trim() !== heading && !ownHave && Boolean(facts.have.trim());
  if (!swapped && !addHave && lines[0].trim() === heading) return suffix;
  if (!swapped && !addHave) return [heading, ...lines.slice(1)].join('\n');
  const parts = [[heading, roleLine].filter((line) => line !== undefined).join('\n'), body];
  parts.push(ownHave || (addHave ? facts.have.trim() : ''));
  return parts.filter((part) => part.trim()).join('\n\n');
}
