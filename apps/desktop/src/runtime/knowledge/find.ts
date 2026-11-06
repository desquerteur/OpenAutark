// One find over the catalog (B-078 D12): the query is embedded once and compared with the catalog's virtual entries – and,
// when asked, memory – with two hops (vectors/hops.ts: what lies close to a good hit is found too). Each hit comes back as
// its entry with origin and score; a skill only as the copy the viewer's route reaches. Without an embedder, or before the
// catalog is embedded, the same entries are matched by their words (subconscious/text.ts lexicalRelevance).
// Owns: the search, the mapping of hits to entries and the lines a find shows. Never: loads a body or treats a found text as an instruction.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { externalMarker, originLabel } from '../../shared/text/external.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import '../contracts/vectors.ts';
import { lexicalRelevance, queryTokens } from '../subconscious/text.ts';
import { catalogEntries, kickCatalog, type CatalogEntry } from './catalog.ts';

export const FIND_HOPS = 2;
const DESCRIPTION_CHARS = 240;
const MIN_LEXICAL = 0.25;

export interface CatalogHit {
  entry: CatalogEntry;
  score: number;
  /** The entry this one was reached through (multi-hop). */
  via?: string;
  /** How it was found. */
  by: 'meaning' | 'words';
}

/** The skills a viewer's route reaches, by name → folder (another copy of the name is not the viewer's). */
function visibleSkills(services: RuntimeServices, viewer: Agent | undefined): Map<string, string> {
  try { return new Map(services.skills.list(viewer?.id).map((info) => [info.name, info.path])); } catch { return new Map(); }
}

function reachable(entry: CatalogEntry, visible: ReadonlyMap<string, string>): boolean {
  return entry.kind !== 'skill' || !entry.skill || visible.get(entry.skill.name) === entry.skill.path;
}

/** The catalog's hits by meaning, best first; undefined when nothing can be searched by meaning (no embedder, nothing embedded yet). */
export async function searchCatalog(services: RuntimeServices, viewer: Agent | undefined, query: string, options: { limit?: number; hops?: number } = {}): Promise<CatalogHit[] | undefined> {
  const vectors = services.vectors;
  if (!vectors?.available() || !vectors.embedTexts) return undefined;
  void kickCatalog(services, viewer);
  const limit = Math.max(1, Math.min(options.limit ?? 8, 30));
  const result = await vectors.search({ query, in: ['catalog'], k: Math.min(limit * 2, 50), hops: options.hops ?? FIND_HOPS });
  if (!result.hits.length && result.searched.embeddedFiles === 0) return undefined;
  const entries = catalogEntries(services, viewer);
  const byKey = new Map(entries.map((entry) => [entry.key.toLowerCase(), entry]));
  const visible = visibleSkills(services, viewer);
  const hits: CatalogHit[] = [];
  for (const hit of result.hits) {
    const entry = byKey.get(hit.path.toLowerCase());
    if (!entry || !reachable(entry, visible) || hits.some((known) => known.entry.key === entry.key)) continue;
    const via = hit.via ? byKey.get(hit.via.toLowerCase())?.title : undefined;
    hits.push({ entry, score: hit.score, by: 'meaning', ...(via ? { via } : {}) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The catalog's hits by words (no embedder): the share of the query's salient words an entry's title + description carries. */
export function lexicalCatalog(services: RuntimeServices, viewer: Agent | undefined, query: string, limit = 8): CatalogHit[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const visible = visibleSkills(services, viewer);
  return catalogEntries(services, viewer)
    .filter((entry) => reachable(entry, visible))
    .map((entry) => ({ entry, score: lexicalRelevance(tokens, `${entry.title.replace(/[-_/]/g, ' ')} ${entry.description}`), by: 'words' as const }))
    .filter((hit) => hit.score >= MIN_LEXICAL)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit);
}

/** By meaning when it can, else by words. */
export async function findInCatalog(services: RuntimeServices, viewer: Agent | undefined, query: string, limit = 8): Promise<CatalogHit[]> {
  let meaning: CatalogHit[] | undefined;
  try { meaning = await searchCatalog(services, viewer, query, { limit }); } catch { meaning = undefined; }
  return meaning ?? lexicalCatalog(services, viewer, query, limit);
}

/** How an entry is opened: skills.load for a skill, library.read for a library entry, files.read for a project file. */
export function openHint(entry: CatalogEntry): string {
  if (entry.kind === 'skill') return `skills.load ${entry.title}`;
  if (entry.kind === 'library') return entry.library?.file ? `library.read ${entry.library.source} ${entry.title}` : (entry.library?.url ?? '');
  return `files.read ${entry.path}`;
}

/** One hit as a find line: name, where it comes from, when it helps, how to open it. */
export function catalogLine(hit: CatalogHit): string {
  const where = hit.entry.kind === 'library' ? originLabel({ kind: 'library', source: hit.entry.library?.source ?? '' }) : hit.entry.kind === 'project' ? 'home project' : hit.entry.skill?.source === 'builtin' ? 'built in' : 'skill';
  const via = hit.via ? `, close to ${hit.via}` : '';
  return `- ${hit.entry.title} (${where}${via}) – ${excerpt(hit.entry.description, DESCRIPTION_CHARS)} · ${openHint(hit.entry)}`;
}

/** The markers the hits need, once each, above them (texts written outside this app). */
export function markerLines(hits: readonly CatalogHit[]): string[] {
  const lines: string[] = [];
  const sources = [...new Set(hits.filter((hit) => hit.entry.kind === 'library').map((hit) => hit.entry.library?.source ?? ''))];
  if (sources.length) lines.push(externalMarker({ kind: 'library', source: sources.join(', ') }));
  if (hits.some((hit) => hit.entry.kind === 'project')) lines.push(externalMarker({ kind: 'project', folder: 'my home project' }));
  return lines;
}
