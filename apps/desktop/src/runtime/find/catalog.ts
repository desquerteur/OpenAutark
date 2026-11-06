// knowledge.find's part of the knowledge catalog beyond the skill library (B-078 D12): the home project's instruction files
// and skills and the public library, by meaning with hops (knowledge/find.ts) or by words, as 'document' candidates (data,
// written outside this app); knowledge.open opens one page with its marker above it. The skills themselves stay
// candidates.ts's (they open as skills).
// Owns: the mapping to candidates and the open of such an entry. Never: presents such a text as instructions.

import { readFileSync } from 'node:fs';
import type { RuntimeServices } from '../contracts.ts';
import { externalMarker } from '../../shared/text/external.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { readSkillBody } from '../skills/discover.ts';
import { parseFrontMatter } from '../skills/frontmatter.ts';
import { stripInvisible } from '../../shared/text/external.ts';
import { catalogEntries, type CatalogEntry } from '../knowledge/catalog.ts';
import { lexicalCatalog, searchCatalog, type CatalogHit } from '../knowledge/find.ts';
import { GONE, pagesOf, type OpenInput, type Opened } from './open.ts';
import { scoreOf, shortHash, MIN_SCORE, type FindCaller, type Found, type Gather } from './candidates.ts';

const origin = (entry: CatalogEntry): string => (entry.kind === 'library' ? `public library ${entry.library?.source ?? ''}` : 'home project');

function foundOf(hit: CatalogHit, score: number, why: string[]): Found {
  const { entry } = hit;
  return {
    id: `cat:${entry.key}`, kind: 'document', authority: 'document', title: entry.title, route: entry.kind === 'library' ? (entry.library?.url ?? entry.path) : entry.title,
    version: entry.sha ? entry.sha.slice(0, 12) : shortHash(entry.description), score, why: [...why, hit.via ? `close to ${hit.via}` : ''].filter(Boolean).join(' · '), origin: origin(entry),
    ...(entry.description ? { description: entry.description } : {}), ...(entry.path && !/^https?:/.test(entry.path) ? { abs: entry.path } : {}),
  };
}

export async function catalogCandidates(services: RuntimeServices, caller: FindCaller, g: Gather): Promise<Found[]> {
  if (!g.kinds.has('document')) return [];
  const meaning = await searchCatalog(services, caller.agent, g.query, { limit: g.limit * 2 }).catch(() => undefined);
  const hits = (meaning ?? lexicalCatalog(services, caller.agent, g.query, g.limit * 2)).filter((hit) => hit.entry.kind !== 'skill');
  return hits.flatMap((hit) => {
    const scored = scoreOf(g, `${hit.entry.title} ${hit.entry.description}`, { semantic: hit.by === 'meaning' });
    const score = hit.by === 'meaning' ? Math.max(scored.score, Math.min(1, hit.score)) : scored.score;
    return score < MIN_SCORE ? [] : [{ ...foundOf(hit, Number(score.toFixed(3)), scored.why), lexical: scored.lexical }];
  });
}

/** The text of an entry, invisible characters out; undefined when it is not on this PC. */
function entryText(entry: CatalogEntry): string | undefined {
  if (!entry.path || /^https?:/.test(entry.path)) return undefined;
  if (entry.kind === 'library' && entry.sha) {
    const read = readSkillBody({ file: entry.path, sha256: entry.sha, authority: 'external' });
    return 'body' in read ? read.body : undefined;
  }
  try { return parseFrontMatter(stripInvisible(readFileSync(entry.path, 'utf8')).text).body; } catch { return undefined; }
}

export function openCatalog(services: RuntimeServices, caller: FindCaller, key: string, input: OpenInput): Opened {
  const entry = catalogEntries(services, caller.agent).find((item) => item.key === key);
  if (!entry || entry.kind === 'skill') throw new WorkforceError('not_found', GONE);
  const marker = externalMarker(entry.kind === 'library' ? { kind: 'library', source: entry.library?.source ?? '' } : { kind: 'project', folder: 'my home project' });
  const body = entryText(entry) ?? `${entry.description}${entry.library?.url ? `\n${entry.library.url} (only listed here – I read it on the web)` : ''}`;
  const pages = pagesOf(body);
  const page = Math.min(Math.max(1, input.page ?? 1), pages.length);
  const shown = pages[page - 1];
  const candidate = foundOf({ entry, score: 1, by: 'words' }, 1, ['opened']);
  const changed = input.version && input.version !== candidate.version ? `changed since I found it (version ${input.version} → ${candidate.version})` : undefined;
  return { candidate: { ...candidate, lines: { from: shown.firstLine, to: shown.lastLine } }, text: `${marker}\n\n${shown.text}`, page, pages: pages.length, ...(changed ? { changed } : {}) };
}
