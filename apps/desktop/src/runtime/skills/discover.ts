// Skill discovery for any folder (wave 3): finds agentskills.io skills – folders holding SKILL.md – below
// a root and returns their index without the instructions: name, description, route (the skill folder
// relative to the root, '/'-separated; '' = the root itself), version, sha256 of the file, modes, size,
// time, and where it comes from (authority) and whether the app trusts it. ONE helper for the agent
// core, an agent's home project (agent-core/home.ts) and any other folder on the PC; it reuses the product skill
// parsing (frontmatter.ts, skill-file.ts) and the text helpers of import-text.ts.
// Bounded: depth, folders visited, skills listed, bytes per SKILL.md; links are never followed; hidden
// and dependency/build folders are skipped except the usual skill homes
// (.agent, .agents, .claude, .codex, .github, .cursor, .gemini, .windsurf, .opencode); a folder holding SKILL.md is a skill and
// not searched further. B-078: `describe` gives a SKILL.md without a description its heading + first sentence (home projects,
// the public library); without it such a file stays a 'no-description' problem (main skills).
// Trust: 'builtin' | 'library' | 'agent' are the app's own skills (trusted – still never a permission);
// 'external' is data: invisible characters removed, and the body only through readSkillBody, which checks it is still
// the text that was listed (sha256).
// Owns: the walk, the index entry and the body read. Never: writes, executes, follows a route found
// inside a file, or treats any text it reads as an instruction to the app.

import { readdirSync, statSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { parseFrontMatter } from './frontmatter.ts';
import { oneLine, skillModes } from './skill-file.ts';
import { sha256, skillSlug, stripInvisible, versionOf } from './import-text.ts';
import { fallbackDescription } from '../../shared/text/external.ts';

/** Dependency and build folders no walk goes into (hidden folders too, except SKILL_HOMES). */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'site-packages']);
const skipped = (name: string, _directory: boolean): boolean => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());

export type SkillAuthority = 'builtin' | 'library' | 'agent' | 'external';

export interface DiscoveredSkill {
  /** Front matter `name` (a usable skill name), else the folder's name made one. */
  name: string;
  /** One line, at most 1024 characters (what it does and when to use it). */
  description: string;
  /** The skill folder relative to the root ('/' separators, '' = the root). */
  route: string;
  folder: string;
  file: string;
  /** Of the SKILL.md text as read – readSkillBody checks it again. */
  sha256: string;
  version?: string;
  modes: string[];
  size: number;
  updatedAt: number;
  authority: SkillAuthority;
  trusted: boolean;
  /** B-078: the description is the body's heading + first sentence (DiscoverOptions.describe), not written by anyone. */
  fallback?: true;
}

export type DiscoveryProblemKind = 'too-large' | 'not-text' | 'no-name' | 'no-description' | 'duplicate' | 'unreadable';
export interface DiscoveryProblem { route: string; problem: DiscoveryProblemKind }

export interface DiscoveryResult {
  root: string;
  skills: DiscoveredSkill[];
  problems: DiscoveryProblem[];
  /** A bound was reached (depth, folders or skills): more may exist. */
  truncated: boolean;
}

export interface DiscoverOptions {
  authority: SkillAuthority;
  maxDepth?: number;
  maxFolders?: number;
  maxSkills?: number;
  maxBytes?: number;
  /** B-078: a missing description becomes the body's heading + first sentence instead of a problem. */
  describe?: boolean;
}

export const DISCOVER_DEFAULTS = { maxDepth: 4, maxFolders: 2000, maxSkills: 200, maxBytes: 256 * 1024 } as const;
const SKILL_FILE = 'SKILL.md';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_HOMES: ReadonlySet<string> = new Set(['.agent', '.agents', '.claude', '.codex', '.github', '.cursor', '.gemini', '.windsurf', '.opencode']);
const TRUSTED: ReadonlySet<SkillAuthority> = new Set(['builtin', 'library', 'agent']);

export const isTrusted = (authority: SkillAuthority): boolean => TRUSTED.has(authority);

/** A folder no walk goes into: hidden (except SKILL_HOMES) or a dependency/build folder – also the rule for skills from a link (links/candidates.ts). */
export const skippedFolder = (name: string): boolean => skipped(name, true) && !SKILL_HOMES.has(name);

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** The file's text when it is UTF-8 within `maxBytes` (else the problem) – also a home skill's other files (agent-core/home-read.ts). */
export function readText(file: string, maxBytes: number): { text: string; size: number; mtime: number } | DiscoveryProblemKind {
  let size: number;
  let mtime: number;
  try {
    const info = statSync(file);
    if (!info.isFile()) return 'unreadable';
    size = info.size;
    mtime = Math.round(info.mtimeMs);
  } catch {
    return 'unreadable';
  }
  if (size > maxBytes) return 'too-large';
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return 'unreadable'; }
  if (bytes.byteLength > maxBytes) return 'too-large';
  if (bytes.includes(0)) return 'not-text';
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), size: bytes.byteLength, mtime };
  } catch {
    return 'not-text';
  }
}

/** One index entry from a SKILL.md, or the problem (no usable name or description, too large, not text). */
function entryOf(file: string, route: string, options: DiscoverOptions, maxBytes: number): DiscoveredSkill | DiscoveryProblemKind {
  const read = readText(file, maxBytes);
  if (typeof read === 'string') return read;
  const trusted = isTrusted(options.authority);
  const stripped = trusted ? { text: read.text, removed: 0 } : stripInvisible(read.text);
  const clean = stripped.text.replace(/\r\n?/g, '\n');
  const { data, body } = parseFrontMatter(clean);
  const given = typeof data.name === 'string' ? data.name.trim() : '';
  const folder = path.dirname(file);
  const name = SKILL_NAME.test(given) ? given : skillSlug(given) || skillSlug(path.basename(folder));
  if (!name || !SKILL_NAME.test(name)) return 'no-name';
  const written = oneLine(typeof data.description === 'string' ? data.description : '').slice(0, 1024);
  const description = written || (options.describe ? fallbackDescription(body) : '');
  if (!description) return 'no-description';
  const version = versionOf(data);
  return {
    name, description, route, folder, file, sha256: sha256(read.text), ...(version ? { version } : {}),
    modes: skillModes(data).map((mode) => mode.trim().toLowerCase()).filter((mode) => SKILL_NAME.test(mode)).slice(0, 30),
    size: read.size, updatedAt: read.mtime, authority: options.authority, trusted, ...(written ? {} : { fallback: true as const }),
  };
}

/**
 * The skills below `root`, sorted by route. Breadth first: of two skills with the same name the one
 * nearer the root wins (equal depth: the first route in name order); the other is a 'duplicate' problem.
 */
export function discoverSkills(root: string, options: DiscoverOptions): DiscoveryResult {
  const maxDepth = options.maxDepth ?? DISCOVER_DEFAULTS.maxDepth;
  const maxFolders = options.maxFolders ?? DISCOVER_DEFAULTS.maxFolders;
  const maxSkills = options.maxSkills ?? DISCOVER_DEFAULTS.maxSkills;
  const maxBytes = options.maxBytes ?? DISCOVER_DEFAULTS.maxBytes;
  const result: DiscoveryResult = { root: path.resolve(root), skills: [], problems: [], truncated: false };
  const names = new Set<string>();
  const queue: Array<{ dir: string; route: string; depth: number }> = [{ dir: result.root, route: '', depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { dir, route, depth } = queue.shift()!;
    if (++visited > maxFolders) { result.truncated = true; break; }
    const listed = entries(dir);
    if (listed.some((entry) => entry.isFile() && entry.name === SKILL_FILE)) {
      if (result.skills.length >= maxSkills) { result.truncated = true; break; }
      const entry = entryOf(path.join(dir, SKILL_FILE), route, options, maxBytes);
      if (typeof entry === 'string') { result.problems.push({ route, problem: entry }); continue; }
      if (names.has(entry.name)) { result.problems.push({ route, problem: 'duplicate' }); continue; }
      names.add(entry.name);
      result.skills.push(entry);
      continue; // a skill folder's scripts/ and references/ are not searched
    }
    for (const entry of listed) {
      if (!entry.isDirectory()) continue; // links and files are never followed
      if (skipped(entry.name, true) && !SKILL_HOMES.has(entry.name)) continue;
      if (depth + 1 > maxDepth) { result.truncated = true; continue; }
      queue.push({ dir: path.join(dir, entry.name), route: route ? `${route}/${entry.name}` : entry.name, depth: depth + 1 });
    }
  }
  result.skills.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  return result;
}

/**
 * The instructions of a listed skill (below its front matter). `changed`: the file is no longer the
 * text that was listed – the caller lists again before using it. Untrusted text comes back without
 * invisible characters.
 */
export function readSkillBody(skill: Pick<DiscoveredSkill, 'file' | 'sha256' | 'authority'>, maxBytes: number = DISCOVER_DEFAULTS.maxBytes):
  { body: string; sha256: string; changed: boolean } | { problem: DiscoveryProblemKind } {
  const read = readText(skill.file, maxBytes);
  if (typeof read === 'string') return { problem: read };
  const hash = sha256(read.text);
  const trusted = isTrusted(skill.authority);
  const stripped = trusted ? { text: read.text, removed: 0 } : stripInvisible(read.text);
  const clean = stripped.text.replace(/\r\n?/g, '\n');
  return { body: parseFrontMatter(clean).body, sha256: hash, changed: hash !== skill.sha256 };
}

/** Index lines for a prompt or a decision: "- name – description (route)", at most `max`, deterministic order. */
export function skillIndexLines(skills: readonly DiscoveredSkill[], options: { max?: number; descriptionChars?: number } = {}): string[] {
  const chars = options.descriptionChars ?? 300;
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name) || a.route.localeCompare(b.route));
  return sorted.slice(0, options.max ?? 30).map((skill) => {
    const description = skill.description.length > chars ? `${skill.description.slice(0, chars - 1).trimEnd()}…` : skill.description;
    return `- ${skill.name} – ${description}${skill.route ? ` (${skill.route})` : ''}`;
  });
}
