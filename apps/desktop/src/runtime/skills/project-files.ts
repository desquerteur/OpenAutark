// A project folder's instruction files in every vendor convention (B-078 D12, owner 06.11.2026: "falls es in einem
// Projektordner … aktive Skills gibt, dann sollen die auch richtig reingeladen werden … verschiedene Benennungssysteme"):
// AGENTS.md, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md, .github/instructions/*.instructions.md,
// .cursor/rules/*.mdc, .cursorrules, .windsurfrules, .windsurf/rules/*.md, .clinerules (a file or a folder of .md). The
// SKILL.md homes are discover.ts's (SKILL_HOMES). Bounded: MAX_FILES files of at most MAX_BYTES each; links are not
// followed (readText reads only plain files). Every text is external: invisible characters removed, and whoever shows it
// puts the project marker above it (shared/text/external.ts).
// Owns: which files count and the entry of one. Never: writes, follows a route found in a file, or treats a text as an instruction to the app.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fallbackDescription, stripInvisible } from '../../shared/text/external.ts';
import { readText } from './discover.ts';
import { parseFrontMatter } from './frontmatter.ts';
import { oneLine } from './skill-file.ts';
import { sha256 } from './import-text.ts';

export const MAX_FILES = 24;
export const MAX_BYTES = 64 * 1024;

export interface ProjectFile {
  /** Relative to the project folder, '/' separators. */
  route: string;
  file: string;
  /** The vendor convention it follows (agents, claude, gemini, copilot, cursor, windsurf, cline). */
  vendor: string;
  title: string;
  /** Its front matter description, else its first heading + first sentence. */
  description: string;
  /** The body without front matter, invisible characters removed. */
  text: string;
  size: number;
  sha256: string;
  /** Front matter says it always applies (Cursor alwaysApply, Copilot applyTo "**"). */
  always: boolean;
}

const ROOT_FILES: ReadonlyArray<[string, string]> = [
  ['AGENTS.md', 'agents'], ['CLAUDE.md', 'claude'], ['GEMINI.md', 'gemini'], ['.cursorrules', 'cursor'], ['.windsurfrules', 'windsurf'], ['.clinerules', 'cline'],
  ['.github/copilot-instructions.md', 'copilot'],
];
const FOLDERS: ReadonlyArray<[string, RegExp, string]> = [
  ['.github/instructions', /\.instructions\.md$/i, 'copilot'],
  ['.cursor/rules', /\.(mdc|md)$/i, 'cursor'],
  ['.windsurf/rules', /\.md$/i, 'windsurf'],
  ['.clinerules', /\.md$/i, 'cline'],
];

function names(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && pattern.test(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** One instruction file as an entry, or undefined when it is not usable text. */
export function projectFile(root: string, route: string, vendor: string): ProjectFile | undefined {
  const file = path.join(root, ...route.split('/'));
  const read = readText(file, MAX_BYTES);
  if (typeof read === 'string') return undefined;
  const clean = stripInvisible(read.text).text.replace(/\r\n?/g, '\n');
  const { data, body } = parseFrontMatter(clean);
  if (!body.trim()) return undefined;
  const given = typeof data.description === 'string' ? oneLine(data.description).slice(0, 300) : '';
  const applyTo = typeof data.applyTo === 'string' ? data.applyTo.trim() : '';
  return {
    route, file, vendor, title: route, description: given || fallbackDescription(body), text: body.trim(), size: read.size, sha256: sha256(read.text),
    always: data.alwaysApply === true || applyTo === '**' || applyTo === '**/*',
  };
}

/** The instruction files of a project folder, in a fixed order (root files, then each folder alphabetical), at most MAX_FILES. */
export function projectFiles(root: string): ProjectFile[] {
  const out: ProjectFile[] = [];
  const add = (route: string, vendor: string) => {
    if (out.length >= MAX_FILES || out.some((entry) => entry.route === route)) return;
    const entry = projectFile(root, route, vendor);
    if (entry) out.push(entry);
  };
  for (const [route, vendor] of ROOT_FILES) add(route, vendor);
  for (const [folder, pattern, vendor] of FOLDERS) {
    for (const name of names(path.join(root, ...folder.split('/')), pattern)) add(`${folder}/${name}`, vendor);
  }
  return out;
}
