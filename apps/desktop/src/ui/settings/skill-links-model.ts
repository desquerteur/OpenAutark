// Words of Settings › Skills › "Add from link" and the skills installed from links (AF-007): where a source lives, a
// skill's files in one line, the scripts warning, one line per change of an update, and the place select's keys.
// Owns: these words (pure). Never: talks RPC (skill-links.tsx) or decides anything (runtime/skills/links/).

import type { SkillFileChange, SkillInstallTarget, SkillLinkCandidate, SkillLinkSource, SkillLinkTarget } from '../../shared/model/skill-links.ts';
import { fileSize } from '../lib/format.ts';

/** "github.com/anthropics/skills/skills/pdf · main", "example.com/…/SKILL.md", "Uploaded notes.zip". */
export function sourceText(source: SkillLinkSource): string {
  if (source.kind === 'upload') return `Uploaded ${source.url}`;
  if (source.kind === 'github' && source.repo) return `github.com/${source.repo}${source.folder ? `/${source.folder}` : ''}${source.ref ? ` · ${source.ref}` : ''}`;
  try {
    const url = new URL(source.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const shown = parts.length > 3 ? [parts[0], '…', ...parts.slice(-2)] : parts;
    return `${url.host}/${shown.join('/')}`;
  } catch {
    return source.url;
  }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "3 files · 24 KB". */
export function filesLine(skill: Pick<SkillLinkCandidate, 'files' | 'size'>): string {
  return `${plural(skill.files.length, 'file')} · ${fileSize(skill.size)}`;
}

/** The warning for scripts (empty: none). */
export function scriptWarning(scripts: readonly string[]): string {
  if (!scripts.length) return '';
  const named = scripts.length > 3 ? `${scripts.slice(0, 3).join(', ')} and ${scripts.length - 3} more` : scripts.join(', ');
  return `Contains ${scripts.length === 1 ? 'a script' : 'scripts'}: ${named}. ${scripts.length === 1 ? 'It is' : 'They are'} only saved – nothing runs when installing. An agent may run ${scripts.length === 1 ? 'it' : 'them'} later when it uses the skill.`;
}

/** "Changed · forms.md · +2 −1 lines · your edit is replaced". */
export function changeText(change: SkillFileChange): string {
  const verb = change.change === 'added' ? 'Added' : change.change === 'removed' ? 'Removed' : 'Changed';
  const lines = change.lines ? `+${change.lines.added} −${change.lines.removed} lines` : fileSize(change.size);
  const extra = [change.script ? 'script' : '', change.local ? (change.change === 'removed' ? 'your edit is removed' : 'your edit is replaced') : ''].filter(Boolean);
  return [verb, change.path, lines, ...extra].join(' · ');
}

/** The update's summary: "2 files change, 1 is new, 1 goes · 4 stay". */
export function updateSummary(changes: readonly SkillFileChange[], unchanged: number): string {
  if (!changes.length) return 'Up to date – nothing changes.';
  const count = (kind: SkillFileChange['change']) => changes.filter((change) => change.change === kind).length;
  const parts = [
    count('changed') && `${plural(count('changed'), 'file')} ${count('changed') === 1 ? 'changes' : 'change'}`,
    count('added') && `${count('added')} new`,
    count('removed') && `${count('removed')} removed`,
  ].filter(Boolean);
  return `${parts.join(', ')}${unchanged ? ` · ${unchanged} unchanged` : ''}`;
}

/** The place select's value of a target ('shared', 'agent:<id>', 'project:<id>'). */
export function targetKey(target: SkillInstallTarget): string {
  return target.kind === 'shared' ? 'shared' : `${target.kind}:${target.agentId}`;
}

/** The target of a select value among the offered ones. */
export function targetOf(key: string, targets: readonly SkillLinkTarget[]): SkillInstallTarget | undefined {
  return targets.find((entry) => targetKey(entry.target) === key)?.target;
}

/** The routes chosen at first: every skill when there is one, none when there are several (the person picks). */
export function firstChoice(skills: readonly SkillLinkCandidate[]): string[] {
  return skills.length === 1 ? [skills[0]!.route] : [];
}
