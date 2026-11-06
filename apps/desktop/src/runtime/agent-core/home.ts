// B-044 AGENT-HOME: an agent's home project - the folder its turns start in when the task has no worktree of its own
// (git/records.ts turnCwd: task worktree -> home -> workspace), like a coding agent opened in a source folder; the agent
// still works anywhere. Stored as `home` in the agent's agent.json (<data>/agents/<id>/agent.json - layout.ts
// manifestText writes it, store.ts keeps it across renames), so an edit on disk counts like every edit there. Reading it
// without native file tools: home-read.ts (skills.load home; files.read and files.list by absolute path).
// The agent sets it itself (agents.update home), the person with agents.setHome or in the file. A folder that is not
// there (also after a restore on another PC) is 'missing', a file or a network path 'refused'; then turns start in the
// workspace. An edit of agent.json on disk reaches the agent view at once (watch.ts -> reread -> 'agentCore.changed').
// Also here: the root a native write of the agent counts in (writeRoot - a home outside the workspace counts like the
// workspace) and the home's skills (skills/discover.ts, authority 'external': untrusted, bounded HOME_DISCOVERY,
// cached TTL_MS per folder, no timer) and, B-078, its instruction files in every vendor convention (skills/project-files.ts,
// cached the same way).
// Owns: these rules, reading the agent.json field and the skill cache. Never: writes into the home folder, follows a
// route found in a skill, or treats a skill text as an instruction.

import { lstatSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Clock, Paths } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HOME_MAX_CHARS, type AgentHome, type AgentHomeProblem } from '../../shared/model/agent-core.ts';
import { discoverSkills, type DiscoveryResult } from '../skills/discover.ts';
import { projectFiles, type ProjectFile } from '../skills/project-files.ts';
import { signature } from '../root/text-doc.ts';
import { isCoreFolderName, manifestFile, readManifest } from './layout.ts';

export type HomePaths = Pick<Paths, 'data' | 'workspace' | 'resources' | 'temp'>;

/** How long a home folder's skill list is reused before it is walked again on its next use. */
export const TTL_MS = 10 * 60_000;
/** How long a home folder's checks (exists, may be written) are reused while agent.json is unchanged. */
export const CHECK_MS = 30_000;
const SKILL_CACHE = 32;
export const HOME_DISCOVERY = { maxDepth: 4, maxFolders: 1000, maxSkills: 100, maxBytes: 256 * 1024, describe: true } as const;
const NETWORK = /^[\\/]{2}/; // \\host\share, //host/share
const CONTROL = /[\u0000-\u001f\u007f]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i; // two+ letters, so "C:\..." stays a drive path
const EXPANDED = /^[~%$]/; // ~/..., %USERPROFILE%\..., $HOME/... are resolved by shells, not by us

/** True only when `resource` is a filesystem path that resolves inside `root`. */
export function insideWorkspace(resource: string | undefined, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!resource || !resource.trim() || !root) return false;
  let value = resource.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value); } catch { return false; }
  } else if (URL_SCHEME.test(value) || EXPANDED.test(value)) {
    return false;
  }
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const base = impl.resolve(root);
  const target = impl.resolve(base, value);
  const fold = (text: string) => (platform === 'win32' ? text.toLowerCase() : text);
  const relative = impl.relative(fold(base), fold(target));
  return relative === '' || (!relative.startsWith('..') && !impl.isAbsolute(relative));
}

/** The sentence agents.core and the prompt show for a problem. */
export function problemText(reason: string): string {
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Turns start in the workspace.`;
}

/** The `home` agent.json holds (undefined: none, or no usable absolute path). */
export function homeOf(manifest: string | undefined): string | undefined {
  if (!manifest) return undefined;
  try {
    const raw = (JSON.parse(manifest) as { home?: unknown }).home;
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value && value.length <= HOME_MAX_CHARS && !CONTROL.test(value) && path.isAbsolute(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Why `dir` cannot be a home project (undefined: it can) - the reason is said to whoever sets it. */
export function homeProblem(dir: string): { problem: AgentHomeProblem; reason: string } | undefined {
  if (NETWORK.test(dir)) return { problem: 'refused', reason: 'a network folder cannot be a home project' };
  if (!path.isAbsolute(dir)) return { problem: 'refused', reason: 'give an absolute folder path' };
  let isDir: boolean;
  try { isDir = statSync(dir).isDirectory(); } catch { return { problem: 'missing', reason: 'this folder does not exist on this PC' }; }
  return isDir ? undefined : { problem: 'refused', reason: 'this is a file, not a folder' };
}

/**
 * The folder an agent's `home` value names: '' clears (undefined); a relative path is inside the workspace;
 * '~', '%VAR%' and '$VAR' are not expanded (shells do that, the app does not). Throws 'bad_request' with the reason.
 */
export function resolveHome(paths: HomePaths, value: string): string | undefined {
  const given = value.trim();
  if (!given) return undefined;
  if (given.length > HOME_MAX_CHARS || CONTROL.test(given)) throw new WorkforceError('bad_request', 'home: a folder path of at most 1024 characters on one line.');
  if (/^[~%$]/.test(given)) throw new WorkforceError('bad_request', 'home: give the folder as an absolute path (~, %VAR% and $VAR are not expanded).');
  const dir = path.resolve(paths.workspace, given);
  const problem = homeProblem(dir);
  if (problem) throw new WorkforceError('bad_request', `home: ${problem.reason}.`);
  return dir;
}

/** `dir` is the workspace or inside it. */
export const inWorkspace = (paths: Pick<Paths, 'workspace'>, dir: string): boolean => insideWorkspace(dir, paths.workspace);

export interface HomeDeps {
  dataDir: string;
  paths?: HomePaths;
  clock: Clock;
  discover?: typeof discoverSkills;
  /** B-078: the instruction files of a folder (tests). */
  readProjectFiles?: typeof projectFiles;
}

/** The read side: agent.json's home per agent (stat-cached), its state, and the skills found in it. */
export class AgentHomes {
  private readonly deps: HomeDeps;
  private readonly reads = new Map<string, { sig: string; home?: string; state?: AgentHome; at: number }>();
  private readonly skills = new Map<string, { at: number; result: DiscoveryResult }>();
  private readonly instructions = new Map<string, { at: number; files: ProjectFile[] }>();

  constructor(deps: HomeDeps) {
    this.deps = deps;
  }

  /** resolveHome with this runtime's folders and rules (agents.update home judges a value with it). */
  resolve(value: string): string | undefined {
    if (!this.deps.paths) throw new WorkforceError('unavailable', 'Home projects are not available in this runtime.');
    return resolveHome(this.deps.paths, value);
  }

  /** agent.json's home now (one lstat; read again only when the file changed). */
  stored(agentId: string): string | undefined {
    return this.entry(agentId)?.home;
  }

  /** The home with its state (undefined: none set, or no paths to judge it by). */
  state(agentId: string): AgentHome | undefined {
    const entry = this.entry(agentId);
    const paths = this.deps.paths;
    if (!entry?.home || !paths) return undefined;
    const now = this.deps.clock.now();
    if (entry.state && now - entry.at < CHECK_MS) return entry.state;
    const problem = homeProblem(entry.home);
    entry.state = { path: entry.home, inWorkspace: inWorkspace(paths, entry.home), ...(problem ? { problem: problem.problem, text: problemText(problem.reason) } : {}) };
    entry.at = now;
    return entry.state;
  }

  /** The folder turns may start in (undefined: none set or not usable now). */
  usable(agentId: string): string | undefined {
    const state = this.state(agentId);
    return state && !state.problem ? state.path : undefined;
  }

  /** The skills of a home folder (bounded walk, untrusted; cached TTL_MS, the least recently used goes first). */
  skillsIn(dir: string): DiscoveryResult {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    const now = this.deps.clock.now();
    const known = this.skills.get(key);
    if (known && now - known.at < TTL_MS) return known.result;
    const result = (this.deps.discover ?? discoverSkills)(dir, { authority: 'external', ...HOME_DISCOVERY });
    this.skills.delete(key);
    if (this.skills.size >= SKILL_CACHE) this.skills.delete(this.skills.keys().next().value!);
    this.skills.set(key, { at: now, result });
    return result;
  }

  /** B-078: the instruction files of a home folder in every vendor convention (bounded, external; cached TTL_MS like the skills). */
  instructionsIn(dir: string): ProjectFile[] {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    const now = this.deps.clock.now();
    const known = this.instructions.get(key);
    if (known && now - known.at < TTL_MS) return known.files;
    const files = (this.deps.readProjectFiles ?? projectFiles)(dir);
    this.instructions.delete(key);
    if (this.instructions.size >= SKILL_CACHE) this.instructions.delete(this.instructions.keys().next().value!);
    this.instructions.set(key, { at: now, files });
    return files;
  }

  /** agent.json changed on disk (watch.ts): read again; true when the home it names is another one now. */
  reread(agentId: string): boolean {
    const before = this.reads.get(agentId)?.home;
    this.forget(agentId);
    return this.stored(agentId) !== before;
  }

  /** After a write of agent.json (or a rolled-back hire): read again, and the old folder's skills too. */
  forget(agentId: string): void {
    const home = this.reads.get(agentId)?.home;
    this.reads.delete(agentId);
    const key = home && (process.platform === 'win32' ? home.toLowerCase() : home);
    if (key) { this.skills.delete(key); this.instructions.delete(key); }
  }

  private entry(agentId: string): { sig: string; home?: string; state?: AgentHome; at: number } | undefined {
    if (!isCoreFolderName(agentId)) return undefined;
    const file = manifestFile(this.deps.dataDir, agentId);
    let sig: string;
    try { sig = signature(lstatSync(file)); } catch { this.reads.delete(agentId); return undefined; }
    const known = this.reads.get(agentId);
    if (known && known.sig === sig) return known;
    const entry = { sig, home: homeOf(readManifest(file)), at: 0 };
    this.reads.set(agentId, entry);
    return entry;
  }
}

/**
 * The root a write of this agent at `resource` counts in: its usable home when the resource lies inside a home
 * outside the workspace, else the workspace.
 */
export function writeRoot(homes: Pick<AgentHomes, 'usable'> | undefined, agentId: string, resource: string | undefined, workspace: string): string {
  if (!homes || !resource) return workspace;
  let home: string | undefined;
  try { home = homes.usable(agentId); } catch { return workspace; }
  return home && !insideWorkspace(home, workspace) && insideWorkspace(resource, home) ? home : workspace;
}
