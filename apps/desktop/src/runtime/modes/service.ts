// ModeService: mode bundles (front matter = ModeInfo fields, body = the mode's prompt
// instructions) from two folders, the second replacing the first key by key, plus a built-in
// 'general' fallback:
//   builtin <resources>/modes/*.md   (shipped, read-only)
//   user    <data>/modes/*.md        (CTX8: saved by the person or an agent through modes.save –
//                                     new kinds of work without an app update; `overrides` when it
//                                     replaces a built-in)
// User modes never live in <workspace>: every agent writes files there (files.write, CLI engines'
// own tools), and a mode is part of every prompt, its tool mask and routing – so only the
// modes.save tool and the owner RPC reach them. A data folder inside the workspace turns
// user modes off. A user file must pass save()'s rules, else it is skipped (the built-in stays).
// Owns: parsing/validation of mode files, save/remove of user modes and an mtime-validated cache over both folders.
// Never: decides routing itself – a mode only *declares* skills, tools, category, workspace, verifier and the tier it
// prefers (minTier; qualifiedTier is read and kept for older files); the router and the tools read those
// declarations. Never writes into <resources>.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Clock, Logger, ModeService } from '../contracts.ts';
import type { ModeInfo, ModeSaveInput, ModeSaveResult } from '../../shared/model/knowledge.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { CATEGORIES } from '../models/priors.ts';
import { parseFrontMatter, stringList } from '../skills/frontmatter.ts';

declare module '../contracts/models.ts' {
  interface ModeService {
    /** Addition (CTX8): validates and writes <data>/modes/<key>.md; unknown skills are reported, not refused. */
    save(input: ModeSaveInput): ModeSaveResult;
    /** Addition (CTX8): deletes a user mode; `restored` when a built-in mode of that key is back. Built-ins stay. */
    remove(key: string): { restored: boolean };
    /** Addition (B-044), optional so simple fakes stay valid: <data>/modes, created when missing; undefined while user modes are off. */
    folder?(): string | undefined;
  }
}

/** Used when no mode file exists (fresh checkout, tests) or a key is unknown. */
export const GENERAL_MODE: ModeInfo = {
  key: 'general',
  name: 'General',
  description: 'Everyday work: answering, planning, organizing and delegating.',
  skills: [],
  tools: ['*'],
  category: 'chat',
  instructions: '',
};

export const MODE_WORKSPACES = ['video', 'web', 'computer', 'browser', 'docs'] as const;
export const MODE_TIERS = ['any', 'strong', 'frontier'] as const;
export const MODE_QUALIFIED_TIERS = ['strong', 'frontier'] as const;
/** Routing categories a mode may declare (the internal helper categories are not kinds of work). */
export const MODE_CATEGORIES: readonly string[] = CATEGORIES.filter((category) => !['cheap-chat', 'decision', 'embeddings'].includes(category));
export const LIMITS = { name: 60, description: 500, instructions: 20_000, verifier: 500, items: 40 } as const;

const WORKSPACES: ReadonlySet<string> = new Set(MODE_WORKSPACES);
const TIERS: ReadonlySet<string> = new Set(MODE_TIERS);
const QUALIFIED_TIERS: ReadonlySet<string> = new Set(MODE_QUALIFIED_TIERS);
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_PATTERN = /^!?[a-z*][a-z0-9_.*-]{0,63}$/; // '!' excludes (tools/registry.ts matchesPatterns)
const CACHE_MS = 3000;

export interface ModeServiceOptions {
  resources: string; // <resources>; built-in modes live in <resources>/modes
  /** CTX8: <data>; user modes live in <data>/modes (absent: built-ins only, save refused). */
  data?: string;
  /** CTX8: the agents' workspace – user modes are off while <data>/modes lies inside it. */
  workspace?: string;
  clock: Clock;
  log?: Logger;
  /** CTX8: the skills that exist – save reports the mode's other skill names. */
  skillNames?: () => readonly string[];
  /** CTX8: called with the key after a save or remove (for listeners that cache modes.list). */
  onChange?: (key: string) => void;
}

interface Loaded {
  at: number;
  signature: string;
  modes: Map<string, ModeInfo>;
  files: Map<string, string>; // user mode key → its file
}

export class ModeLibrary implements ModeService {
  private options: ModeServiceOptions;
  private userDir?: string;
  private cache?: Loaded;

  constructor(options: ModeServiceOptions) {
    this.options = options;
    this.userDir = userModesDir(options);
  }

  list(): ModeInfo[] {
    return [...this.load().modes.values()].sort((a, b) => (a.key === 'general' ? -1 : b.key === 'general' ? 1 : a.key.localeCompare(b.key)));
  }

  get(key: string): ModeInfo {
    const modes = this.load().modes;
    return modes.get(key) ?? modes.get('general') ?? GENERAL_MODE;
  }

  save(input: ModeSaveInput): ModeSaveResult {
    if (!this.userDir) throw new WorkforceError('unavailable', 'This runtime keeps no modes of its own (no data folder outside the workspace).');
    const key = modeKey(input.key, 'key');
    const loaded = this.load();
    const from = input.from === undefined ? undefined : modeKey(input.from, 'from');
    const base = from ? loaded.modes.get(from) : loaded.modes.get(key);
    if (from && !base) throw new WorkforceError('not_found', `Mode '${from}' not found.`);
    const mode = validated(key, input, base);
    const text = serialize(mode);
    validated(key, userInput(key, text), undefined); // values kept from `base` must pass the load rules too, or nothing is written
    const file = loaded.files.get(key) ?? path.join(this.userDir, `${key}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
    this.cache = undefined;
    const saved = this.load().modes.get(key);
    if (saved?.source !== 'user') throw new WorkforceError('internal', 'The mode was written but could not be read back.');
    this.options.onChange?.(key);
    const known = this.options.skillNames ? new Set(this.options.skillNames()) : undefined;
    return { mode: saved, unknownSkills: known ? saved.skills.filter((skill) => !known.has(skill)) : [] };
  }

  remove(key: string): { restored: boolean } {
    const loaded = this.load();
    const file = loaded.files.get(key);
    if (!file) {
      if (loaded.modes.has(key)) throw new WorkforceError('forbidden', `'${key}' is a built-in mode and cannot be deleted.`);
      throw new WorkforceError('not_found', `Mode '${key}' not found.`);
    }
    rmSync(file, { force: true });
    this.cache = undefined;
    const restored = this.load().modes.get(key)?.source === 'builtin';
    this.options.onChange?.(key);
    return { restored };
  }

  /** B-044: the folder of the own modes (Settings › Modes › Open folder; a file there is a mode) – created when missing. */
  folder(): string | undefined {
    if (!this.userDir) return undefined;
    mkdirSync(this.userDir, { recursive: true });
    return this.userDir;
  }

  private roots(): Array<{ dir: string; source: 'builtin' | 'user' }> {
    const roots: Array<{ dir: string; source: 'builtin' | 'user' }> = [{ dir: path.join(this.options.resources, 'modes'), source: 'builtin' }];
    if (this.userDir) roots.push({ dir: this.userDir, source: 'user' });
    return roots;
  }

  /** Cheap signature: every mode file's folder, name, mtime and size. Re-checked at most every CACHE_MS. */
  private load(): Loaded {
    const now = this.options.clock.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache;
    const files = this.roots().flatMap((root) => listMarkdown(root.dir).map((file) => ({ ...file, root })));
    const signature = files.map((file) => `${file.root.source}:${file.name}@${file.mtime}:${file.size}`).join('|');
    if (this.cache && this.cache.signature === signature) {
      this.cache.at = now;
      return this.cache;
    }
    const modes = new Map<string, ModeInfo>([['general', { ...GENERAL_MODE, source: 'builtin' }]]);
    const userFiles = new Map<string, string>();
    const builtins = new Set(['general']); // built-in files come first, so this is complete before any user file
    for (const { name, root } of files) {
      const file = path.join(root.dir, name);
      try {
        const fileKey = name.replace(/\.md$/i, '');
        const text = readFileSync(file, 'utf8');
        if (root.source === 'builtin') {
          const parsed = parseMode(fileKey, text);
          builtins.add(parsed.key);
          modes.set(parsed.key, { ...parsed, source: 'builtin' });
          continue;
        }
        const mode = this.userMode(fileKey, text);
        modes.set(mode.key, { ...mode, source: 'user', ...(builtins.has(mode.key) ? { overrides: true } : {}) });
        userFiles.set(mode.key, file);
      } catch (error) {
        this.options.log?.warn('mode file skipped', { file: name, source: root.source, error: String(error) });
      }
    }
    this.cache = { at: now, signature, modes, files: userFiles };
    return this.cache;
  }

  /** A user file passes save()'s rules or throws. */
  private userMode(fileKey: string, text: string): ModeInfo {
    const input = userInput(fileKey, text);
    return validated(input.key, input, undefined);
  }
}

/** <data>/modes – unless it lies inside the workspace, where any agent could write a mode. */
function userModesDir(options: ModeServiceOptions): string | undefined {
  if (!options.data) return undefined;
  const real = (dir: string) => { try { return realpathSync.native(dir); } catch { return path.resolve(dir); } };
  const dir = path.join(real(options.data), 'modes');
  if (!options.workspace) return dir;
  const relative = path.relative(real(options.workspace), dir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return dir;
  options.log?.warn('user modes are off: the data folder lies inside the workspace', { dir });
  return undefined;
}

/** A user file's fields as save() takes them: front matter required, text or list values, a `key` matching the file name. */
function userInput(fileKey: string, text: string): ModeSaveInput {
  const { data, body } = parseFrontMatter(text);
  if (!Object.keys(data).length) throw bad('no front matter.');
  const str = (field: string, alias = field): string | undefined => {
    const raw = data[field] ?? data[alias];
    if (typeof raw === 'string') return raw.trim();
    if (raw == null) return undefined;
    throw bad(`${field}: text expected.`);
  };
  const list = (field: string): string[] | undefined => {
    const raw = data[field];
    if (Array.isArray(raw) || typeof raw === 'string') return stringList(raw);
    if (raw == null) return undefined;
    throw bad(`${field}: a list expected.`);
  };
  const key = modeKey(fileKey, 'file name');
  const named = str('key');
  if (named !== undefined && named.toLowerCase() !== key) throw bad(`key: '${named}' does not match the file name.`);
  return {
    key, name: str('name'), description: str('description'), instructions: body,
    skills: list('skills'), tools: list('tools'), category: str('category'), verifier: str('verifier'),
    workspace: str('workspace') as ModeSaveInput['workspace'],
    minTier: str('minTier', 'min_tier') as ModeSaveInput['minTier'],
    qualifiedTier: str('qualifiedTier', 'qualified_tier') as ModeSaveInput['qualifiedTier'],
  };
}

/** Parses one mode file; the file name is the key unless front matter sets `key`. */
export function parseMode(fileKey: string, text: string): ModeInfo {
  const { data, body } = parseFrontMatter(text);
  const key = (typeof data.key === 'string' && data.key.trim() ? data.key.trim() : fileKey).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`invalid mode key '${key}'`);
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const tools = stringList(data.tools);
  const workspace = str(data.workspace);
  const minTier = str(data.minTier ?? data.min_tier);
  const qualifiedTier = str(data.qualifiedTier ?? data.qualified_tier);
  return {
    key,
    name: str(data.name) ?? key.charAt(0).toUpperCase() + key.slice(1),
    description: str(data.description) ?? '',
    skills: stringList(data.skills),
    tools: tools.length ? tools : ['*'],
    category: str(data.category) ?? (key === 'general' ? 'chat' : key),
    workspace: workspace && WORKSPACES.has(workspace) ? workspace as ModeInfo['workspace'] : undefined,
    verifier: str(data.verifier),
    minTier: minTier && TIERS.has(minTier) ? minTier as ModeInfo['minTier'] : undefined,
    ...(qualifiedTier && QUALIFIED_TIERS.has(qualifiedTier) ? { qualifiedTier: qualifiedTier as ModeInfo['qualifiedTier'] } : {}),
    instructions: body,
  };
}

function bad(message: string): WorkforceError {
  return new WorkforceError('bad_request', message);
}

function modeKey(value: string, field: string): string {
  const key = value.trim().toLowerCase();
  if (!KEY.test(key)) throw bad(`${field}: mode keys are lowercase letters, digits and hyphens (at most 64).`);
  return key;
}

/** One trimmed line of at most `max` characters (whitespace runs fold to one space). */
function line(value: string, field: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) throw bad(`${field}: at most ${max} characters.`);
  return text;
}

/** Trimmed, de-duplicated entries that match `pattern`. */
function entries(values: readonly string[], field: string, pattern: RegExp): string[] {
  const list = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (list.length > LIMITS.items) throw bad(`${field}: at most ${LIMITS.items} entries.`);
  const wrong = list.find((value) => !pattern.test(value));
  if (wrong) throw bad(`${field}: '${wrong}' is not a valid entry.`);
  return list;
}

function oneOf<T extends string>(value: string, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw bad(`${field}: one of ${allowed.join(', ')}.`);
  return value as T;
}

/** The mode to write (or a user file's mode, no base): given fields validated, the rest kept from `base`. */
function validated(key: string, input: ModeSaveInput, base: ModeInfo | undefined): ModeInfo {
  const name = input.name === undefined ? base?.name ?? key.charAt(0).toUpperCase() + key.slice(1) : line(input.name, 'name', LIMITS.name);
  const description = input.description === undefined ? base?.description ?? '' : line(input.description, 'description', LIMITS.description);
  const instructions = (input.instructions ?? base?.instructions ?? '').replace(/\r\n/g, '\n').trim();
  if (!name) throw bad('name: a mode needs a name.');
  if (!description) throw bad('description: a mode needs a description (what kind of work it is for).');
  if (!instructions) throw bad('instructions: a mode needs instructions (the prompt section agents get in it).');
  if (instructions.length > LIMITS.instructions) throw bad(`instructions: at most ${LIMITS.instructions} characters.`);
  const tools = input.tools === undefined ? base?.tools ?? ['*'] : entries(input.tools, 'tools', TOOL_PATTERN);
  const verifier = input.verifier === undefined ? base?.verifier : line(input.verifier, 'verifier', LIMITS.verifier) || undefined;
  const workspace = input.workspace === undefined ? base?.workspace : input.workspace === '' ? undefined : oneOf(input.workspace, 'workspace', MODE_WORKSPACES);
  const qualified = input.qualifiedTier === undefined ? base?.qualifiedTier : input.qualifiedTier === '' ? undefined : oneOf(input.qualifiedTier, 'qualifiedTier', MODE_QUALIFIED_TIERS);
  const minTier = input.minTier === undefined ? base?.minTier : oneOf(input.minTier, 'minTier', MODE_TIERS);
  return {
    key, name, description,
    skills: input.skills === undefined ? base?.skills ?? [] : entries(input.skills, 'skills', KEY),
    tools: tools.length ? tools : ['*'],
    category: input.category === undefined ? base?.category ?? 'chat' : oneOf(input.category, 'category', MODE_CATEGORIES),
    ...(workspace ? { workspace } : {}),
    ...(verifier ? { verifier } : {}),
    ...(minTier ? { minTier } : {}),
    ...(qualified ? { qualifiedTier: qualified } : {}),
    instructions,
  };
}

/** Front matter in the subset skills/frontmatter.ts reads back exactly (single-quoted strings). */
function serialize(mode: ModeInfo): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const list = (field: string, values: readonly string[]) => (values.length ? [`${field}:`, ...values.map((value) => `  - ${quote(value)}`)] : [`${field}: []`]);
  const head = [
    `key: ${mode.key}`, `name: ${quote(mode.name)}`, `description: ${quote(mode.description)}`,
    ...list('skills', mode.skills), ...list('tools', mode.tools), `category: ${mode.category}`,
    ...(mode.workspace ? [`workspace: ${mode.workspace}`] : []),
    ...(mode.verifier ? [`verifier: ${quote(mode.verifier)}`] : []),
    ...(mode.minTier ? [`minTier: ${mode.minTier}`] : []),
    ...(mode.qualifiedTier ? [`qualifiedTier: ${mode.qualifiedTier}`] : []),
  ];
  return `---\n${head.join('\n')}\n---\n\n${mode.instructions}\n`;
}

function listMarkdown(dir: string): Array<{ name: string; mtime: number; size: number }> {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => /\.md$/i.test(name) && !name.startsWith('_')).sort()
      .map(name => { const stat = statSync(path.join(dir, name)); return { name, mtime: stat.mtimeMs, size: stat.size }; });
  } catch {
    return [];
  }
}
