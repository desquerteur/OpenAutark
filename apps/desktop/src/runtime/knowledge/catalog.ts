// One knowledge catalog (B-078 D12, owner 06.11.2026: "nicht so getrennt … wie aktuell Skills und Memory"): every text the
// AI can reach, as one list – the skills of every root (skills/service.ts), the home project's instruction files and
// SKILL.md skills (agent-core/home.ts) and the public library (library/sources.ts). Memory is the same kind of text and is
// already embedded by the memory tree; a find searches "catalog" and "memory" together (knowledge/find.ts). Each entry:
// key, title, description (given, else generated – knowledge/describe.ts – else heading + first sentence), size, origin
// (own | project | public), always, path. syncCatalog embeds the entries as virtual vector entries (vectors/virtual.ts: a
// short text whole, a big one by title + description) and removes the ones that are gone; it runs when a find asks and
// the last sync is older than SYNC_MS or something changed (catalogChanged), in the vector system's one queue, never on a
// timer of its own. Afterwards it describes a few entries that have no description.
// Owns: the entry list, the sync and when descriptions are asked for. Never: reads a body into a prompt or treats a text as an instruction.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { SkillInfo } from '../../shared/model/knowledge.ts';
import type { LibraryEntry } from '../../shared/model/library.ts';
import { fallbackDescription } from '../../shared/text/external.ts';
import '../contracts/vectors.ts';
import '../contracts/agent-core.ts';
import { parseFrontMatter } from '../skills/frontmatter.ts';
import { sha256 } from '../skills/import-text.ts';
import { readSkillBody } from '../skills/discover.ts';
import { CHUNK_CHARS } from '../vectors/chunk.ts';
import { embedTextOf } from '../vectors/virtual.ts';
import { libraryEntries } from '../library/sources.ts';
import { helperOf } from '../day/helper.ts';
import { describeFile, describedText, describeText, rememberDescribed } from './describe.ts';

export type CatalogOrigin = 'own' | 'project' | 'public';
export type CatalogKind = 'skill' | 'project' | 'library';

export interface CatalogEntry {
  /** The virtual vector key: catalog/skill/<owner>/<name>, catalog/project/<home>/<route>, catalog/public/<source>/<name>. */
  key: string;
  kind: CatalogKind;
  title: string;
  description: string;
  /** The description was written by someone (front matter), not generated or taken from the text. */
  given: boolean;
  origin: CatalogOrigin;
  always: boolean;
  /** The file on this PC, or the web address of an index-only entry. */
  path: string;
  size: number;
  sha?: string;
  /** The text itself when it is short enough to be embedded whole. */
  body?: string;
  skill?: SkillInfo;
  library?: LibraryEntry;
  /** An own file: a generated description goes into its front matter. */
  writable?: boolean;
}

export const SYNC_MS = 10 * 60_000;
const BUDGET_MS = 60_000;
const DESCRIBE_BATCH = 6;
const PREFIXES = ['catalog/skill', 'catalog/public'] as const;

const shortHash = (text: string): string => sha256(text).slice(0, 10);

/** The description an entry shows: given, else generated, else heading + first sentence of its text. */
function descriptionOf(services: RuntimeServices, given: string, body: string, sha: string): { description: string; given: boolean } {
  const fallback = fallbackDescription(body);
  if (given && given !== fallback) return { description: given, given: true };
  return { description: describedText(services, sha) ?? (given || fallback), given: false };
}

const skillCache = new WeakMap<object, { signature: string; entries: CatalogEntry[] }>();

function writableSkill(services: RuntimeServices, info: SkillInfo): boolean {
  if (info.source === 'agent') return true;
  if (info.source !== 'user') return false;
  const relative = path.relative(services.paths.workspace, info.path);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Every skill copy of every root as an entry (cached while no SKILL.md changed). */
export function skillEntries(services: RuntimeServices): CatalogEntry[] {
  let every: SkillInfo[];
  try { every = services.skills.every?.() ?? services.skills.list(); } catch { return []; }
  const signature = every.map((info) => `${info.path}@${info.updatedAt}`).join('|');
  const known = skillCache.get(services);
  if (known && known.signature === signature) return known.entries;
  const entries = every.flatMap((info): CatalogEntry[] => {
    let text: string;
    try { text = readFileSync(path.join(info.path, 'SKILL.md'), 'utf8'); } catch { return []; }
    const body = parseFrontMatter(text).body;
    const sha = sha256(text);
    const { description, given } = descriptionOf(services, info.description, body, sha);
    return [{
      key: `catalog/skill/${info.ownerAgentId ?? info.source}/${info.name}`, kind: 'skill', title: info.name, description, given,
      origin: 'own', always: info.always === true, path: path.join(info.path, 'SKILL.md'), size: body.length, sha,
      ...(body.length <= CHUNK_CHARS ? { body } : {}), skill: info, writable: writableSkill(services, info),
    }];
  });
  skillCache.set(services, { signature, entries });
  return entries;
}

/** The home project's instruction files and skills of `agent` as entries ([] without a usable home). */
export function projectEntries(services: RuntimeServices, agent: Agent | undefined): CatalogEntry[] {
  const homes = services.agentCore?.homes;
  let home: string | undefined;
  try { home = agent ? homes?.usable(agent.id) : undefined; } catch { home = undefined; }
  if (!homes || !home) return [];
  const prefix = `catalog/project/${shortHash(home.toLowerCase())}`;
  const files = homes.instructionsIn(home).map((file): CatalogEntry => ({
    key: `${prefix}/${file.route}`, kind: 'project', title: file.route, ...descriptionOf(services, file.description, file.text, file.sha256),
    origin: 'project', always: file.always, path: file.file, size: file.text.length, sha: file.sha256, ...(file.text.length <= CHUNK_CHARS ? { body: file.text } : {}),
  }));
  const skills = homes.skillsIn(home).skills.map((skill): CatalogEntry => ({
    key: `${prefix}/${skill.route || skill.name}`, kind: 'project', title: skill.name, description: describedText(services, skill.sha256) ?? skill.description, given: !skill.fallback,
    origin: 'project', always: false, path: skill.file, size: skill.size, sha: skill.sha256,
  }));
  return [...files, ...skills];
}

/** The public library's entries on this PC. */
export function publicEntries(services: RuntimeServices): CatalogEntry[] {
  let entries: LibraryEntry[];
  try { entries = libraryEntries(services.paths.data, services.clock.now()); } catch { return []; }
  return entries.map((entry): CatalogEntry => ({
    key: `catalog/public/${entry.source}/${entry.name}`, kind: 'library', title: entry.name,
    description: (entry.sha256 ? describedText(services, entry.sha256) : undefined) ?? entry.description, given: !entry.fallback,
    origin: 'public', always: false, path: entry.file ?? entry.url ?? '', size: entry.size ?? entry.description.length, ...(entry.sha256 ? { sha: entry.sha256 } : {}), library: entry,
  }));
}

/** The whole catalog a viewer reaches (its home project only for an agent). */
export function catalogEntries(services: RuntimeServices, viewer?: Agent): CatalogEntry[] {
  return [...skillEntries(services), ...projectEntries(services, viewer), ...publicEntries(services)];
}

// ------------------------------------------------------------------ sync

interface SyncState { at: number; dirty: boolean; running?: Promise<void>; homes: Set<string> }
const syncs = new WeakMap<object, SyncState>();

function stateOf(services: RuntimeServices): SyncState {
  let state = syncs.get(services);
  if (!state) { state = { at: Number.NEGATIVE_INFINITY, dirty: true, homes: new Set() }; syncs.set(services, state); }
  return state;
}

/** Something in the catalog changed (a skill saved, a library synced): the next find syncs again. */
export function catalogChanged(services: RuntimeServices): void {
  stateOf(services).dirty = true;
}

/** Starts a sync in the background when one is due; the find goes on with what is embedded. */
export function kickCatalog(services: RuntimeServices, viewer?: Agent): Promise<void> | undefined {
  const state = stateOf(services);
  if (!services.vectors?.embedTexts || !services.vectors.available()) return undefined;
  if (state.running) return state.running;
  const home = viewer ? projectEntries(services, viewer)[0]?.key.split('/').slice(0, 3).join('/') : undefined;
  const newHome = home !== undefined && !state.homes.has(home);
  if (!state.dirty && !newHome && services.clock.now() - state.at < SYNC_MS) return undefined;
  state.dirty = false;
  state.at = services.clock.now();
  state.running = syncCatalog(services, viewer).catch((error: unknown) => {
    try { services.log.debug('catalog sync failed', { error: String(error) }); } catch { /* nothing to report to */ }
  }).finally(() => { state.running = undefined; });
  return state.running;
}

/** Embeds what changed, removes what is gone, then describes a few entries without a description. */
export async function syncCatalog(services: RuntimeServices, viewer?: Agent): Promise<void> {
  const vectors = services.vectors;
  if (!vectors?.embedTexts) return;
  const entries = catalogEntries(services, viewer);
  const state = stateOf(services);
  const projectPrefix = entries.find((entry) => entry.kind === 'project')?.key.split('/').slice(0, 3).join('/');
  if (projectPrefix) state.homes.add(projectPrefix);
  const keys = new Set(entries.map((entry) => entry.key.toLowerCase()));
  for (const prefix of [...PREFIXES, ...(projectPrefix ? [projectPrefix] : [])]) {
    for (const key of vectors.virtualKeys?.(prefix) ?? []) if (!keys.has(key.toLowerCase())) vectors.forget?.(key);
  }
  const items = entries.map((entry) => ({ key: entry.key, text: embedTextOf({ title: entry.title, description: entry.description, ...(entry.body ? { body: entry.body } : {}) }) }));
  for (let at = 0; at < items.length;) {
    const result = await vectors.embedTexts(items.slice(at), { budgetMs: BUDGET_MS });
    if (result.failed || !result.remaining) break;
    at = items.length - result.remaining;
  }
  await describeSome(services, entries);
}

/** A few entries without a written description get a generated one (decision model); none without a model. */
export async function describeSome(services: RuntimeServices, entries: readonly CatalogEntry[], runner = helperOf(services)): Promise<number> {
  if (!runner) return 0;
  const due = entries.filter((entry) => !entry.given && entry.sha && !describedText(services, entry.sha)).slice(0, DESCRIBE_BATCH);
  const changed: CatalogEntry[] = [];
  for (const entry of due) {
    const text = entryText(entry);
    if (!text) continue;
    let description: string | undefined;
    try { description = await describeText(runner, { title: entry.title, text }); } catch { description = undefined; }
    if (!description || !entry.sha) continue;
    rememberDescribed(services, entry.sha, description, services.clock.now()); // also an own file: the same text is not asked again
    if (entry.writable && entry.skill) describeFile(entry.path, entry.skill.name, description, sha256, entry.sha); // the skill library sees the new mtime on its next read
    changed.push({ ...entry, description });
  }
  if (changed.length) await services.vectors?.embedTexts?.(changed.map((entry) => ({ key: entry.key, text: embedTextOf({ title: entry.title, description: entry.description, ...(entry.body ? { body: entry.body } : {}) }) })));
  return changed.length;
}

/** An entry's text for its description (a library file through the external read; an index-only entry has none). */
function entryText(entry: CatalogEntry): string | undefined {
  if (entry.body) return entry.body;
  if (!entry.path || /^https?:/.test(entry.path)) return undefined;
  if (entry.kind === 'library' && entry.sha) {
    const read = readSkillBody({ file: entry.path, sha256: entry.sha, authority: 'external' });
    return 'body' in read ? read.body : undefined;
  }
  try { return parseFrontMatter(readFileSync(entry.path, 'utf8')).body; } catch { return undefined; }
}
