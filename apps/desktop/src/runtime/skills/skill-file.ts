// SKILL.md front matter as the skill library reads and writes it: the agentskills.io fields (name,
// description) plus `modes` (top level or under `metadata`) – the modes whose index lists the skill – and `always`
// (name and description in every prompt, for the few skills that must not be missed).
// Owns: reading those fields and building a SKILL.md text. Never: touches files (skills/service.ts).

import { WorkforceError } from '../../shared/errors.ts';
import { stringList } from './frontmatter.ts';

export const MODE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MODES = 30;

/** Chosen mode keys, trimmed, lowercase, without duplicates; refuses malformed keys. */
export function modeKeys(modes: readonly string[]): string[] {
  const keys = [...new Set(modes.map(mode => mode.trim().toLowerCase()).filter(Boolean))];
  if (keys.length > MAX_MODES) throw new WorkforceError('bad_request', `A skill lists at most ${MAX_MODES} modes.`);
  const bad = keys.find(key => !MODE_KEY.test(key));
  if (bad) throw new WorkforceError('bad_request', `'${bad}' is not a mode key (lowercase letters, digits and hyphens).`);
  return keys;
}

const metadataOf = (data: Record<string, unknown>): Record<string, unknown> =>
  (data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : {});

/** `modes` at top level or under agentskills `metadata.modes` (the spec keeps extras in metadata). */
export function skillModes(data: Record<string, unknown>): string[] {
  return [...new Set([...stringList(data.modes), ...stringList(metadataOf(data).modes)])];
}

/** `metadata.always: true` (or top level): name and description stand in every prompt this skill's route reaches. */
export function skillAlways(data: Record<string, unknown>): boolean {
  return data.always === true || metadataOf(data).always === true;
}

/** Whitespace folded, control characters dropped (the description is one front matter line). */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** SKILL.md text: front matter (name, quoted description, metadata: modes, always) + body. */
export function skillText(name: string, description: string, body: string, modes: readonly string[], always = false): string {
  const head = [`name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (modes.length || always) head.push('metadata:');
  if (modes.length) head.push(`  modes: [${modes.join(', ')}]`);
  if (always) head.push('  always: true');
  return `---\n${head.join('\n')}\n---\n\n${body.trim()}\n`;
}
