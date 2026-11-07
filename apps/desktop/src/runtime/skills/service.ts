// The skill library: agentskills.io skills (folders with SKILL.md: front matter name + description, optional
// `metadata.modes` or top-level `modes`) from five places, highest precedence first:
//   main     <data>/agents/<id>/skills/<name>/SKILL.md          (an agent's Main Skills, agent-core/)
//   agent    <workspace>/agents/<slug>/skills/<name>/SKILL.md   (an agent's own skills)
//   user     <workspace>/skills/<name>/SKILL.md                  (the shared library, editable by the person and agents)
//   imported ~/.codex/skills, ~/.claude/skills                   (read-only, listed as 'user')
//   builtin  <resources>/skills/<name>/SKILL.md                  (shipped, read-only)
// A skill is a plain folder: an agent writes or changes SKILL.md like any file and the next read sees it (mtime
// cache). B-066 routes (owner: "der ganze Baum" under a manager): a name means, for a viewer, its own skill, else the
// nearest manager's up its chain, else the shared one, else the built-in one – so an own copy changes nothing for anyone
// outside that agent's tree. Without a viewer (the person's lists): shared, then built-in. Another agent's own skill is
// still loadable by name when nothing nearer carries it. The per-mode index lists what the viewer's route reaches
// (CTX4 order: up to INDEX_CAP explicit first, then alphabetical; over the cap explicit, then tagged for the mode,
// then the agent's own, then the untagged rest – each alphabetical, so the stable prompt prefix stays byte-identical).
// Main Skills are listed in their owner's own prompt section (mainFor, agent-core/prompt.ts), so the index leaves
// them out. `metadata.always: true` (few, important skills) puts name and description into every prompt that route
// reaches (alwaysFor). invalidate() makes the next read check the folders again. B-078: a description is optional – a skill
// without one shows its heading and first sentence (shared/text/external.ts) until knowledge/describe.ts writes one.
// Owns: discovery with an mtime-validated cache, routes, load, save (with the skill's modes), import of an agent file's
// skills, remove, the per-mode index, the folder a new skill gets (folderFor – skills from a link, links/). Never: puts skill bodies into the index (descriptions only; bodies load on
// demand), treats a skill text as a permission, or writes into builtin/imported folders.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock, Logger, Paths, SkillImportInput, SkillSaveInput, SkillService } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { parseFrontMatter } from './frontmatter.ts';
import { modeKeys, oneLine, skillAlways, skillModes, skillText } from './skill-file.ts';
import { fallbackDescription } from '../../shared/text/external.ts';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const INDEX_CAP = 30; // skill descriptions per prompt (beyond: skills.find)
const CACHE_MS = 3000;

interface Root {
  dir: string;
  source: SkillInfo['source'];
  readOnly: boolean;
  ownerAgentId?: string;
  main?: boolean;
}

interface Entry {
  info: SkillInfo;
  file: string;
  readOnly: boolean;
}

export interface SkillServiceOptions {
  paths: Pick<Paths, 'workspace' | 'resources'>;
  clock: Clock;
  log?: Logger;
  home?: string; // for ~/.codex/skills and ~/.claude/skills (default os.homedir(); '' disables)
  /** Folder slug of an agent under <workspace>/agents (default: the agent id). */
  agentSlug?: (agentId: string) => string;
  /** Agent id for a folder slug (default: the slug itself). */
  agentForSlug?: (slug: string) => string | undefined;
  /** The agents' Main Skills folders (agent-core/layout.ts) and the folder of one agent; absent = none. */
  mainRoots?: () => Array<{ dir: string; ownerAgentId: string }>;
  mainDir?: (agentId: string) => string;
  /** The agent's managers, nearest first (org chain): their skills reach everyone below them. Absent: none. */
  chain?: (agentId: string) => readonly string[];
}

export class SkillLibrary implements SkillService {
  private options: SkillServiceOptions;
  private cache?: { at: number; signature: string; entries: Entry[] };

  constructor(options: SkillServiceOptions) {
    this.options = options;
  }

  /** One skill per name, as `viewerId`'s route resolves it (no viewer: the person's view). */
  list(viewerId?: string): SkillInfo[] {
    return [...this.visible(viewerId).values()].map(entry => entry.info).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every copy, by name: the person's page shows an agent's own copy beside the shared one it stands in for. */
  every(): SkillInfo[] {
    return this.entries().map(entry => entry.info).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string, viewerId?: string): { info: SkillInfo; body: string } | undefined {
    const entry = this.visible(viewerId).get(name);
    if (!entry) return undefined;
    try {
      return { info: entry.info, body: parseFrontMatter(readFileSync(entry.file, 'utf8')).body };
    } catch {
      return undefined;
    }
  }

  save(input: SkillSaveInput): SkillInfo {
    const name = input.name.trim();
    if (!SKILL_NAME.test(name)) throw new WorkforceError('bad_request', 'Skill names are lowercase letters, digits and hyphens.');
    // B-078 D12: a description is not typed by hand any more – without one the body's heading and first sentence stand in until
    // knowledge/describe.ts writes a generated one; a refused save would only lose the skill.
    const description = oneLine(input.description ?? '') || fallbackDescription(input.body) || name.replace(/-/g, ' ');
    const chosen = input.modes ? modeKeys(input.modes) : undefined;
    const viewer = input.ownerAgentId;
    const existing = this.visible(viewer).get(name);
    const own = existing?.info.source === 'agent' && existing.info.ownerAgentId === viewer;
    if (input.main && own && !existing.info.main) throw new WorkforceError('conflict', `The name '${name}' is taken by another skill of this agent. Choose another name.`);
    // Saved where it is when it is the saver's own or the shared one; a manager's, colleague's or built-in skill gets an own copy.
    const inPlace = existing && !existing.readOnly && (input.main ? own : own || !viewer || existing.info.source !== 'agent');
    const dir = inPlace ? existing.info.path : path.join(input.main ? this.mainBase(viewer) : viewer
      ? path.join(this.agentDir(viewer), 'skills')
      : path.join(this.options.paths.workspace, 'skills'), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), skillText(name, description, input.body, chosen ?? existing?.info.modes ?? [], existing?.info.always === true), 'utf8');
    return this.reread(name, viewer);
  }

  /** An agent file's skill as the owner's own, under a free name (a taken name gets -2, -3 …). */
  importSkill(input: SkillImportInput): SkillInfo {
    const description = oneLine(input.description);
    if (!SKILL_NAME.test(input.name) || !description) throw new WorkforceError('bad_request', 'This skill has no valid name or description.');
    const modes = modeKeys(input.modes);
    const base = input.main ? this.mainBase(input.ownerAgentId) : input.ownerAgentId ? path.join(this.agentDir(input.ownerAgentId), 'skills') : path.join(this.options.paths.workspace, 'skills');
    const name = this.freeName(input.name, base);
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'SKILL.md'), skillText(name, description, input.body, modes), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return this.reread(name, input.ownerAgentId);
  }

  /** AF-007: the folder a new skill of this name gets – an agent's own skills, else the shared library (the routes above). */
  folderFor(name: string, ownerAgentId?: string): string {
    if (!SKILL_NAME.test(name)) throw new WorkforceError('bad_request', 'Skill names are lowercase letters, digits and hyphens.');
    return path.join(ownerAgentId ? path.join(this.agentDir(ownerAgentId), 'skills') : path.join(this.options.paths.workspace, 'skills'), name);
  }

  remove(name: string): void {
    const entry = this.visible().get(name);
    if (!entry) throw new WorkforceError('not_found', `Skill '${name}' not found.`);
    if (entry.readOnly) throw new WorkforceError('bad_request', `Skill '${name}' is built in or imported from another tool's folder; change a copy in <workspace>/skills instead.`);
    rmSync(entry.info.path, { recursive: true, force: true });
    this.cache = undefined;
  }

  indexFor(agent: Agent, mode: ModeInfo): SkillInfo[] {
    const explicit = new Set([...mode.skills, ...agent.skills]);
    // No `modes` front matter = useful in every mode; otherwise only in the listed modes (`modes: [none]`, a key no mode
    // has: in no mode's index – G1, the app's own skills; skills.find with a query and skills.load still reach it). Skills of
    // agents outside the viewer's chain stay out (they are still loadable by name); own Main Skills have their own section (mainFor).
    const usable = this.routed(agent).filter(info => explicit.has(info.name) || info.modes.length === 0 || info.modes.includes(mode.key));
    // list() is alphabetical and sort() is stable: every tier stays alphabetical (stable prompt prefix).
    if (usable.length <= INDEX_CAP) return usable.sort((a, b) => Number(explicit.has(b.name)) - Number(explicit.has(a.name)));
    // Over the cap untagged (imported, user) skills must not push the mode's own ones out.
    const tier = (info: SkillInfo): number => (explicit.has(info.name) ? 0 : info.modes.includes(mode.key) ? 1 : info.source === 'agent' ? 2 : 3);
    return usable.sort((a, b) => tier(a) - tier(b)).slice(0, INDEX_CAP);
  }

  /** The agent's own Main Skills, alphabetical – its prompt lists them all (agent-core/prompt.ts). */
  mainFor(agent: Agent): SkillInfo[] {
    return this.entries().map(entry => entry.info).filter(info => info.main === true && info.ownerAgentId === agent.id).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The `metadata.always` skills this viewer's route reaches in this mode, alphabetical and few: their descriptions stand in every prompt. */
  alwaysFor(agent: Agent, mode: ModeInfo): SkillInfo[] {
    return this.routed(agent).filter(info => info.always === true && (info.modes.length === 0 || info.modes.includes(mode.key))); // one cap for the whole always set: knowledge/always.ts
  }

  /** The next read checks the folders again at once (their signature; unchanged files are not parsed again). */
  invalidate(): void {
    if (this.cache) this.cache.at = Number.NEGATIVE_INFINITY;
  }

  /** The viewer plus its managers, nearest first. */
  private chainOf(viewerId: string): string[] {
    try { return [viewerId, ...(this.options.chain?.(viewerId) ?? [])]; } catch { return [viewerId]; }
  }

  /** One entry per name: the viewer's own, each manager's up its chain, shared, built in; other agents' last, so they hide nothing. */
  private visible(viewerId?: string): Map<string, Entry> {
    const chain = viewerId ? this.chainOf(viewerId) : [];
    const rank = (entry: Entry): number => {
      const owner = entry.info.ownerAgentId;
      if (!owner) return chain.length;
      const near = chain.indexOf(owner);
      return near >= 0 ? near : chain.length + 1;
    };
    const best = new Map<string, { entry: Entry; rank: number }>();
    for (const entry of this.entries()) { // root order inside one rank: main before agent, shared before imported before built in
      const at = rank(entry);
      const known = best.get(entry.info.name);
      if (!known || at < known.rank) best.set(entry.info.name, { entry, rank: at });
    }
    return new Map([...best].map(([name, found]) => [name, found.entry]));
  }

  /** What this viewer's route reaches, alphabetical: no skills of agents outside its chain and not its own Main Skills (their own section). */
  private routed(agent: Agent): SkillInfo[] {
    const chain = new Set(this.chainOf(agent.id));
    return this.list(agent.id).filter(info => (info.source !== 'agent' || chain.has(info.ownerAgentId ?? '')) && !(info.main && info.ownerAgentId === agent.id));
  }

  private reread(name: string, viewerId?: string): SkillInfo {
    this.cache = undefined;
    const saved = this.visible(viewerId).get(name);
    if (!saved) throw new WorkforceError('internal', 'Skill was written but could not be read back.');
    return saved.info;
  }

  /** `name`, else `name-2`, `name-3` … – free among all listed skills and folders in `base`. */
  private freeName(name: string, base: string): string {
    const taken = (candidate: string) => this.entries().some(entry => entry.info.name === candidate) || existsSync(path.join(base, candidate));
    for (let index = 1; index < 1000; index++) {
      const suffix = index === 1 ? '' : `-${index}`;
      const candidate = `${name.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
    throw new WorkforceError('conflict', `No free name for skill '${name}'.`);
  }

  // ---------------------------------------------------------------- discovery

  private mainBase(agentId: string | undefined): string {
    if (!agentId || !this.options.mainDir) throw new WorkforceError('bad_request', 'A Main Skill needs its agent.');
    return this.options.mainDir(agentId);
  }

  private agentDir(agentId: string): string {
    const slug = this.options.agentSlug?.(agentId) ?? agentId;
    if (!/^[A-Za-z0-9_.-]+$/.test(slug) || slug.includes('..')) throw new WorkforceError('bad_request', 'Invalid agent folder.');
    return path.join(this.options.paths.workspace, 'agents', slug);
  }

  private roots(): Root[] {
    const roots: Root[] = (this.options.mainRoots?.() ?? []).map(root => ({ ...root, source: 'agent' as const, readOnly: false, main: true }));
    const agentsDir = path.join(this.options.paths.workspace, 'agents');
    for (const slug of safeReaddir(agentsDir)) {
      const ownerAgentId = this.options.agentForSlug ? this.options.agentForSlug(slug) : slug;
      if (ownerAgentId) roots.push({ dir: path.join(agentsDir, slug, 'skills'), source: 'agent', readOnly: false, ownerAgentId });
    }
    roots.push({ dir: path.join(this.options.paths.workspace, 'skills'), source: 'user', readOnly: false });
    const home = this.options.home ?? os.homedir();
    if (home) {
      roots.push({ dir: path.join(home, '.codex', 'skills'), source: 'user', readOnly: true });
      roots.push({ dir: path.join(home, '.claude', 'skills'), source: 'user', readOnly: true });
    }
    roots.push({ dir: path.join(this.options.paths.resources, 'skills'), source: 'builtin', readOnly: true });
    return roots;
  }

  /** Every skill copy, root order. Cheap signature: every SKILL.md path + mtime. Re-checked at most every CACHE_MS. */
  private entries(): Entry[] {
    const now = this.options.clock.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.entries;
    const files: Array<{ root: Root; file: string; folder: string; mtime: number }> = [];
    for (const root of this.roots()) {
      for (const folder of safeReaddir(root.dir)) {
        const file = path.join(root.dir, folder, 'SKILL.md');
        const mtime = safeMtime(file);
        if (mtime !== undefined) files.push({ root, file, folder, mtime });
      }
    }
    const signature = files.map(entry => `${entry.file}@${entry.mtime}`).join('|');
    if (this.cache && this.cache.signature === signature) {
      this.cache.at = now;
      return this.cache.entries;
    }
    const entries: Entry[] = [];
    const names = new Map<Root, Set<string>>();
    for (const { root, file, folder, mtime } of files) {
      try {
        const { data, body } = parseFrontMatter(readFileSync(file, 'utf8'));
        const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : folder;
        const inRoot = names.get(root) ?? new Set<string>();
        names.set(root, inRoot);
        if (inRoot.has(name)) continue; // two folders of one root carry this name: the first counts
        inRoot.add(name);
        const given = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : '';
        const description = given || fallbackDescription(body); // B-078: a hand-written SKILL.md without one is still found
        const info: SkillInfo = {
          name, description, source: root.source, ownerAgentId: root.ownerAgentId,
          path: path.dirname(file), modes: skillModes(data), updatedAt: Math.round(mtime),
        };
        if (root.main) info.main = true;
        if (skillAlways(data)) info.always = true;
        entries.push({ file, readOnly: root.readOnly, info });
      } catch (error) {
        this.options.log?.warn('skill could not be read', { file, error: String(error) });
      }
    }
    this.cache = { at: now, signature, entries };
    return entries;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}

function safeMtime(file: string): number | undefined {
  try { return statSync(file).mtimeMs; } catch { return undefined; }
}
