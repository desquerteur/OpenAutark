// The parts of an agent's SYSTEM.md, found by their headings (B-076): the team's standard on top (with "# How I work"
// since B-076), "## My role" (older files: "## Your role") with the agent's own role text, and "## What I have here"
// (standing facts and agreements). org/hire.ts, prompt-updates.ts, standard-upgrade.ts, role-upgrade.ts,
// context/prompt-stable.ts and agents.update share these rules.
// Owns: the heading names and the split/join of those parts. Never: reads files or decides what an agent may change.

export const ROLE_HEADING = '## My role';
const ROLE_HEADINGS: readonly string[] = [ROLE_HEADING, '## Your role'];
export const HAVE_HEADING = '## What I have here';
/** The first heading of the team's "How I work" (resources/prompts/rules.md); a SYSTEM.md holding it is a whole standing text. */
export const WORK_HEADING = '# How I work';

/** True for the role heading line, the B-076 form or the older one. */
export function isRoleHeading(line: string): boolean {
  return ROLE_HEADINGS.includes(line.trim());
}

/** The line index of the role heading, or -1. */
export function roleLineIndex(lines: readonly string[]): number {
  return lines.findIndex(isRoleHeading);
}

/** A regex matching the role heading as its own line (both forms), for split/test on whole texts. */
export const ROLE_LINE = /^[ \t]*## (?:My|Your) role[ \t]*$/m;

/** The first heading line of the rules in force (an own rules.md may name its "How I work" differently). */
export function rulesHeading(rules: string | undefined): string | undefined {
  // A top-level heading only: "## Money" or "## How I work" of an older standard never stands for the rules.
  return rules?.split('\n').map((line) => line.trim()).find((line) => /^# \S/.test(line));
}

/**
 * True when the text carries the team's "How I work" itself (a B-076 SYSTEM.md, or an own text that kept it); `rules`:
 * the rules in force, whose own first heading counts too (review fix: "# Wie ich arbeite" in an own rules.md).
 */
export function hasWorkStandard(text: string, rules?: string): boolean {
  const own = rulesHeading(rules);
  return text.split('\n').some((line) => line.trim() === WORK_HEADING || (own !== undefined && line.trim() === own));
}

/** A rendered standard split at "## What I have here": what goes above the role text and what follows it. */
export function splitAtHave(standard: string): { head: string; tail: string } {
  const lines = standard.split('\n');
  const at = lines.findIndex((line) => line.trim() === HAVE_HEADING);
  if (at < 0) return { head: standard.trim(), tail: '' };
  return { head: lines.slice(0, at).join('\n').trim(), tail: lines.slice(at).join('\n').trim() };
}

/**
 * agents.update's instructions (B-076): a text with "# How I work" is the whole SYSTEM.md; otherwise, when the current
 * SYSTEM.md holds the team's standard, the text replaces the own part from the role heading on (the heading is added
 * when the text has none) and the standard above stays. An older SYSTEM.md is replaced whole, as before.
 */
export function withOwnPart(current: string, text: string, rules?: string): string {
  if (hasWorkStandard(text, rules) || !hasWorkStandard(current, rules)) return text;
  const lines = current.split('\n');
  const at = roleLineIndex(lines);
  const standard = (at < 0 ? current : lines.slice(0, at).join('\n')).trim();
  const own = text.trim();
  const first = own.split('\n', 1)[0] ?? '';
  return `${standard}\n\n${isRoleHeading(first) ? own : `${ROLE_HEADING}\n${own}`}`;
}

/** The own part of a SYSTEM.md (from the role heading on) when it holds the team's standard; else the whole text. */
export function ownPart(instructions: string, rules?: string): string {
  if (!hasWorkStandard(instructions, rules)) return instructions;
  const lines = instructions.split('\n');
  const at = roleLineIndex(lines);
  return at < 0 ? instructions : lines.slice(at).join('\n').trim();
}

/** True when the text has a "## What I have here" part. */
export function hasHavePart(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === HAVE_HEADING);
}
