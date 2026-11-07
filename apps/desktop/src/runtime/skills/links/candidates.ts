// The skills of a source view (AF-007), as the preview lists them: every folder with a SKILL.md, nearer the root first; a
// skill's own subfolders are not searched (like skills/discover.ts, whose folder rule – hidden and dependency folders
// skipped, the usual skill homes kept – applies here too). Per skill: the name (a valid front matter name, else one made
// from it or from the folder), the description (written, else the body's heading and first sentence), its files with the
// ones that look like scripts, and short notes; over a limit (LINK_LIMITS) the skill is a problem, never cut silently.
// SKILL.md is external text: invisible characters removed (shared/text/external.ts), the cleaned text is what is installed.
// Owns: these rules, the script heuristics and the bytes a skill is installed with. Never: writes, runs a file or treats a text as an instruction.

import { createHash } from 'node:crypto';
import type { SkillLinkCandidate, SkillLinkFile } from '../../../shared/model/skill-links.ts';
import { fallbackDescription, stripInvisible } from '../../../shared/text/external.ts';
import { skippedFolder } from '../discover.ts';
import { parseFrontMatter } from '../frontmatter.ts';
import { skillSlug } from '../import-text.ts';
import { oneLine } from '../skill-file.ts';
import { LINK_LIMITS, skillBudget, type SourceFile, type SourceView } from './archive.ts';
import type { ZipBudget } from '../../files/zip.ts';

/** The source record the app writes beside an installed skill – never taken from a source. */
export const RECORD_FILE = '.autark-source.json';
const SKILL_FILE = 'SKILL.md';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_EXT = new Set([
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'vbs', 'vbe', 'wsf', 'hta', 'reg', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'py', 'pyw', 'rb', 'pl', 'pm', 'php', 'lua', 'r', 'jl', 'tcl', 'awk', 'applescript', 'scpt', 'command', 'exe', 'dll', 'so', 'dylib', 'jar', 'msi', 'com', 'scr', 'app', 'bin',
]);
const SCRIPT_FOLDERS = new Set(['scripts', 'bin', 'tools', 'hooks']);
const MARKDOWN = /\.(md|mdc|markdown)$/i;

/** A skill the preview found, with what installing it needs. */
export interface FoundSkill {
  info: SkillLinkCandidate;
  /** Its files by path relative to the skill folder (the source record is never among them). */
  files: Map<string, SourceFile>;
}

export interface FoundSkills {
  skills: FoundSkill[];
  problems: Array<{ route: string; problem: string }>;
  truncated: boolean;
}

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** Looks like something that runs: a script or binary extension, a scripts/ or bin/ folder, an executable bit. */
export function isScript(path: string, mode = 0): boolean {
  const name = path.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (SCRIPT_EXT.has(ext) || (mode & 0o111) !== 0) return true;
  return path.includes('/') && SCRIPT_FOLDERS.has((path.split('/')[0] ?? '').toLowerCase()) && !/^(md|markdown|txt)$/.test(ext); // scripts/README.md is text
}

/** UTF-8 text of a file or undefined (a NUL byte or invalid UTF-8). */
export function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
}

/**
 * The bytes a file is installed with: Markdown without invisible characters (external text, like every text from
 * outside this app), everything else as it came. The update preview compares with the same rule.
 */
export function installBytes(path: string, bytes: Buffer): { bytes: Buffer; removed: number } {
  if (!MARKDOWN.test(path)) return { bytes, removed: 0 };
  const text = textOf(bytes);
  if (text === undefined) return { bytes, removed: 0 };
  const clean = stripInvisible(text);
  return clean.removed ? { bytes: Buffer.from(clean.text, 'utf8'), removed: clean.removed } : { bytes, removed: 0 };
}

const depthOf = (route: string): number => (route ? route.split('/').length : 0);
const parentOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The skill folders of a view, nearer the root first; nested ones inside another skill and skipped folders left out. */
export function skillFolders(view: SourceView): string[] {
  const folders = [...view.files.keys()].filter((file) => file === SKILL_FILE || file.endsWith(`/${SKILL_FILE}`)).map(parentOf)
    .filter((route) => depthOf(route) <= LINK_LIMITS.depth && !route.split('/').filter(Boolean).some(skippedFolder))
    .sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0));
  const kept: string[] = [];
  for (const route of folders) {
    if (kept.some((outer) => outer === '' || route.startsWith(`${outer}/`))) continue; // inside another skill: part of it
    kept.push(route);
  }
  return kept;
}

/** The skill of one folder, or why it cannot be installed. */
async function skillOf(view: SourceView, route: string, fallbackName: string, budget: ZipBudget): Promise<FoundSkill | string> {
  const prefix = route ? `${route}/` : '';
  const skillFile = view.files.get(`${prefix}${SKILL_FILE}`);
  if (!skillFile) return 'no SKILL.md';
  if (skillFile.size > LINK_LIMITS.skillFileBytes) return 'SKILL.md is larger than 256 KB';
  const text = textOf(await skillFile.read(budget));
  if (text === undefined) return 'SKILL.md is not text';
  const clean = stripInvisible(text);
  const { data, body } = parseFrontMatter(clean.text.replace(/\r\n?/g, '\n'));
  const given = typeof data.name === 'string' ? data.name.trim() : '';
  const folderName = route.split('/').pop() || fallbackName;
  const name = SKILL_NAME.test(given) ? given : skillSlug(given) || skillSlug(folderName);
  if (!name || !SKILL_NAME.test(name)) return 'no usable name';
  const written = oneLine(typeof data.description === 'string' ? data.description : '').slice(0, 1024);
  const description = written || fallbackDescription(body);
  if (!description) return 'SKILL.md has no description and no text';
  const files = new Map<string, SourceFile>();
  const listed: SkillLinkFile[] = [];
  const notes: string[] = [];
  let size = 0;
  for (const [file, entry] of view.files) {
    if (prefix && !file.startsWith(prefix)) continue;
    const own = file.slice(prefix.length);
    if (own === RECORD_FILE) { notes.push(`${RECORD_FILE} of the source left out (the app writes its own)`); continue; }
    if (entry.size > LINK_LIMITS.fileBytes) return `${own} is larger than 10 MB`;
    size += entry.size;
    files.set(own, entry);
    listed.push({ path: own, size: entry.size, ...(isScript(own, entry.mode) ? { script: true as const } : {}) });
  }
  if (files.size > LINK_LIMITS.skillFiles) return `holds more than ${LINK_LIMITS.skillFiles} files`;
  if (size > LINK_LIMITS.skillBytes) return 'is larger than 30 MB';
  listed.sort((a, b) => (a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skipped = view.skipped.filter((entry) => !prefix || entry.path.startsWith(prefix));
  const reasons = new Map<string, number>();
  for (const entry of skipped) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  for (const [reason, count] of reasons) notes.push(`${plural(count, 'file')} left out (${reason})`);
  if (clean.removed) notes.push(`${plural(clean.removed, 'invisible character')} removed from SKILL.md`);
  if (name !== given) notes.push(given ? `Named ${name} (the name "${given.slice(0, 64)}" is not a skill name)` : `Named ${name} after its folder`);
  if (!written) notes.push('No description written; the first lines stand in');
  const scripts = listed.filter((file) => file.script).map((file) => file.path);
  return { info: { route, name, description, files: listed, size, scripts, notes }, files };
}

/** Every skill of a view (at most LINK_LIMITS.skills; the same name twice: the one nearer the root). */
export async function findSkills(view: SourceView, fallbackName: string): Promise<FoundSkills> {
  const result: FoundSkills = { skills: [], problems: [], truncated: false };
  const names = new Set<string>();
  const budget = skillBudget();
  for (const route of skillFolders(view)) {
    if (result.skills.length >= LINK_LIMITS.skills) { result.truncated = true; break; }
    const found = await skillOf(view, route, fallbackName, budget).catch((error: Error) => error.message || 'could not be read');
    if (typeof found === 'string') { result.problems.push({ route, problem: found }); continue; }
    if (names.has(found.info.name)) { result.problems.push({ route, problem: `another skill of this source is named ${found.info.name}` }); continue; }
    names.add(found.info.name);
    result.skills.push(found);
  }
  return result;
}
