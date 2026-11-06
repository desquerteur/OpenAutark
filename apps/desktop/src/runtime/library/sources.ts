// The public library's sources (B-078 D13): the shared library itself (library/ of teydra/OpenAutark), three repositories
// of skills (anthropics/skills, obra/superpowers, K-Dense-AI/claude-scientific-skills) and two curated lists people keep of
// the niche ones (index-only, import.ts). Each git source is cloned shallow into <data>/library/<id> when first asked for
// (library.sync) and updated the same way; nothing is fetched by itself. An added source (a repository or a list) is kept in
// <data>/library/sources.json. The entries of all sources are listed from disk (SKILL.md files through skills/discover.ts,
// authority 'external'; lists from their index file), cached until the next sync or LIST_MS.
// Owns: the source list, clone/update, the entry list and its cache. Never: runs a file of a source or treats its text as an instruction.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LibraryEntry, LibrarySource, LibrarySourceState } from '../../shared/model/library.ts';
import { LIBRARY_FOLDER, LIBRARY_REPO } from '../../shared/model/library.ts';
import { discoverSkills } from '../skills/discover.ts';
import { importIndex, readIndex, type FetchText } from './import.ts';
import { runCommand, type Run } from './exec.ts';

export const DEFAULT_SOURCES: readonly LibrarySource[] = [
  { id: 'openautark', kind: 'git', repo: LIBRARY_REPO, folder: LIBRARY_FOLDER, builtin: true },
  { id: 'anthropics-skills', kind: 'git', repo: 'anthropics/skills', builtin: true },
  { id: 'superpowers', kind: 'git', repo: 'obra/superpowers', builtin: true },
  { id: 'scientific-skills', kind: 'git', repo: 'K-Dense-AI/claude-scientific-skills', builtin: true },
  { id: 'awesome-agent-skills', kind: 'index', url: 'https://raw.githubusercontent.com/VoltAgent/awesome-agent-skills/main/README.md', builtin: true },
  { id: 'awesome-claude-skills', kind: 'index', url: 'https://raw.githubusercontent.com/travisvn/awesome-claude-skills/main/README.md', builtin: true },
];

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const CLONE_MS = 180_000;
const LIST_MS = 30 * 60_000;
const DISCOVERY = { authority: 'external' as const, describe: true, maxDepth: 6, maxFolders: 20_000, maxSkills: 3000, maxBytes: 256 * 1024 };

export interface LibraryDeps {
  dataDir: string;
  /** The absolute git (git/exec.ts gitOf().resolve()); undefined = git is missing. */
  git: () => string | undefined;
  run?: Run;
  fetchText?: FetchText;
  now: () => number;
}

export const libraryDir = (dataDir: string): string => path.join(dataDir, 'library');
const sourcesFile = (dataDir: string): string => path.join(libraryDir(dataDir), 'sources.json');
const stateFile = (dataDir: string): string => path.join(libraryDir(dataDir), 'state.json');

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

/** The shipped sources and the ones added on this PC. */
export function listSources(dataDir: string): LibrarySource[] {
  const added = readJson<LibrarySource[]>(sourcesFile(dataDir), []).filter((source) => SOURCE_ID.test(source.id) && (source.kind === 'git' ? REPO.test(source.repo ?? '') : Boolean(source.url)));
  const ids = new Set(DEFAULT_SOURCES.map((source) => source.id));
  return [...DEFAULT_SOURCES, ...added.filter((source) => !ids.has(source.id)).map(({ builtin: _builtin, ...source }) => source)];
}

/** A source from what someone typed: "owner/repo", a github.com URL, or the URL of a list. */
export function sourceOf(given: string): LibrarySource | undefined {
  const text = given.trim();
  const github = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(text);
  if (github && REPO.test(github[1])) return { id: github[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48), kind: 'git', repo: github[1] };
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return undefined;
    const id = `${url.hostname}${url.pathname}`.toLowerCase().replace(/\.(md|json)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-48).replace(/^-+/, '');
    return id ? { id, kind: 'index', url: url.toString() } : undefined;
  } catch { return undefined; }
}

/** Keeps an added source (a known id stays as it is). */
export function addSource(dataDir: string, source: LibrarySource): LibrarySource {
  const known = listSources(dataDir).find((item) => item.id === source.id);
  if (known) return known;
  const added = readJson<LibrarySource[]>(sourcesFile(dataDir), []);
  mkdirSync(libraryDir(dataDir), { recursive: true });
  writeFileSync(sourcesFile(dataDir), JSON.stringify([...added, source], null, 2), 'utf8');
  return source;
}

const cache = new Map<string, { at: number; entries: LibraryEntry[] }>();

/** Clones (shallow) or updates one source, or fetches its list. The state is kept per source. */
export async function syncSource(deps: LibraryDeps, source: LibrarySource): Promise<LibrarySourceState> {
  const dir = libraryDir(deps.dataDir);
  mkdirSync(dir, { recursive: true });
  let problem: string | undefined;
  if (source.kind === 'index') {
    const result = await importIndex(dir, source.id, source.url ?? '', deps.fetchText);
    if ('problem' in result) problem = result.problem;
  } else {
    problem = await cloneOrPull(deps, source);
  }
  cache.delete(deps.dataDir);
  const states = readJson<Record<string, { syncedAt?: number; problem?: string }>>(stateFile(deps.dataDir), {});
  states[source.id] = problem ? { ...states[source.id], problem } : { syncedAt: deps.now() };
  writeFileSync(stateFile(deps.dataDir), JSON.stringify(states, null, 2), 'utf8');
  return stateOf(deps.dataDir, source, states[source.id]);
}

async function cloneOrPull(deps: LibraryDeps, source: LibrarySource): Promise<string | undefined> {
  const git = deps.git();
  if (!git) return 'git is not installed on this PC';
  const run = deps.run ?? runCommand;
  const target = path.join(libraryDir(deps.dataDir), source.id);
  const url = `https://github.com/${source.repo}.git`;
  const fail = (result: { stderr: string }) => result.stderr.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? 'git failed';
  if (!existsSync(path.join(target, '.git'))) {
    const cloned = await run(git, ['clone', '--depth', '1', '--single-branch', '--no-tags', url, target], { cwd: libraryDir(deps.dataDir), timeoutMs: CLONE_MS });
    return cloned.code === 0 ? undefined : fail(cloned);
  }
  const fetched = await run(git, ['-C', target, 'fetch', '--depth', '1', '--no-tags', 'origin'], { timeoutMs: CLONE_MS });
  if (fetched.code !== 0) return fail(fetched);
  const reset = await run(git, ['-C', target, 'reset', '--hard', 'FETCH_HEAD'], { timeoutMs: CLONE_MS });
  return reset.code === 0 ? undefined : fail(reset);
}

function stateOf(dataDir: string, source: LibrarySource, state: { syncedAt?: number; problem?: string } | undefined): LibrarySourceState {
  return { source, entries: entriesOf(dataDir, source).length, ...(state?.syncedAt ? { syncedAt: state.syncedAt } : {}), ...(state?.problem ? { problem: state.problem } : {}) };
}

/** Every source with when it was fetched and how many entries it holds. */
export function sourceStates(dataDir: string): LibrarySourceState[] {
  const states = readJson<Record<string, { syncedAt?: number; problem?: string }>>(stateFile(dataDir), {});
  return listSources(dataDir).map((source) => stateOf(dataDir, source, states[source.id]));
}

/** One source's entries as they are on this PC. */
function entriesOf(dataDir: string, source: LibrarySource): LibraryEntry[] {
  if (source.kind === 'index') return readIndex(libraryDir(dataDir), source.id);
  const root = path.join(libraryDir(dataDir), source.id, ...(source.folder ? source.folder.split('/') : []));
  try { if (!statSync(root).isDirectory()) return []; } catch { return []; }
  return discoverSkills(root, DISCOVERY).skills.map((skill) => ({
    source: source.id, name: skill.name, description: skill.description, file: skill.file, size: skill.size, sha256: skill.sha256, ...(skill.fallback ? { fallback: true as const } : {}),
    url: `https://github.com/${source.repo}/blob/HEAD/${[source.folder, skill.route].filter(Boolean).join('/')}/SKILL.md`,
  }));
}

/** Every entry of every source on this PC (cached until a sync or LIST_MS). */
export function libraryEntries(dataDir: string, now: number): LibraryEntry[] {
  const known = cache.get(dataDir);
  if (known && now - known.at < LIST_MS) return known.entries;
  const entries = listSources(dataDir).flatMap((source) => entriesOf(dataDir, source));
  cache.set(dataDir, { at: now, entries });
  return entries;
}

/** The entry `name` of `source`, or undefined. */
export function libraryEntry(dataDir: string, now: number, source: string, name: string): LibraryEntry | undefined {
  return libraryEntries(dataDir, now).find((entry) => entry.source === source && entry.name === name);
}
