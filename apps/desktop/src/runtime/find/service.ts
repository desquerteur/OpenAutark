// FindService (FIND, wave 3): the one find/open path every caller shares – the agent's knowledge.find /
// knowledge.open tools. It asks the existing stores (candidates.ts: skill
// library, knowledge notes, references; B-078 the rest of the knowledge catalog – home project files and the public library,
// find/catalog.ts – no second index), merges what they found into one ranked list and opens one
// candidate page by page (open.ts).
// Ranking: score buckets of SCORE_BUCKET, then authority (skill > document > hint), then score, then id.
// Owns: the merge and the ranking. Never: grants anything, stores query text, or opens anything by itself.

import type { RuntimeServices } from '../contracts.ts';
import type { FindCandidate, FindKind, FindOpened } from '../../shared/model/find.ts';
import { AUTHORITY_ORDER } from '../../shared/model/find.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { idTokens } from '../knowledge/query-rewrite.ts';
import { queryTokens } from '../subconscious/text.ts';
import { noteCandidates, referenceCandidates, skillCandidates, type FindCaller, type Found, type Gather } from './candidates.ts';
import { GONE, openNote, openSkill, type OpenInput, type Opened } from './open.ts';
import { catalogCandidates, openCatalog } from './catalog.ts';
import { WorkforceError } from '../../shared/errors.ts';

export const ALL_KINDS: readonly FindKind[] = ['main-skill', 'product-skill', 'note', 'reference', 'document'];
export type { FindCaller };
export const MAX_LIMIT = 20;
const SCORE_BUCKET = 0.05;

export interface FindQuery {
  query: string;
  kinds?: readonly FindKind[];
  limit?: number;
  signal?: AbortSignal;
}

const authorityRank = (candidate: FindCandidate) => AUTHORITY_ORDER.indexOf(candidate.authority);

/** Transitive order: score bucket, authority, score, id. */
export function rankOrder(a: FindCandidate, b: FindCandidate): number {
  const bucket = (c: FindCandidate) => Math.round(c.score / SCORE_BUCKET);
  return bucket(b) - bucket(a) || authorityRank(a) - authorityRank(b) || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Without internal fields (abs path, keyword share). */
export function publicCandidate(found: Found): FindCandidate {
  const { abs: _abs, lexical: _lexical, ...rest } = found;
  return rest;
}

export class FindService {
  private readonly services: () => RuntimeServices;

  constructor(services: () => RuntimeServices) {
    this.services = services;
  }

  async find(caller: FindCaller, query: FindQuery): Promise<Found[]> {
    const services = this.services();
    const mode = modeOf(services, caller);
    const gather: Gather = {
      query: query.query, tokens: queryTokens(query.query), ids: idTokens(query.query),
      kinds: new Set(query.kinds?.length ? query.kinds : ALL_KINDS), limit: Math.max(1, Math.min(query.limit ?? 8, MAX_LIMIT)), signal: query.signal,
    };
    const lists = await Promise.all([
      quiet(() => skillCandidates(services, caller, gather, mode)),
      quiet(() => noteCandidates(services, caller, gather)),
      quiet(() => referenceCandidates(services, caller, gather)),
      quiet(() => catalogCandidates(services, caller, gather)),
    ]);
    const merged = new Map<string, Found>();
    for (const found of lists.flat()) {
      if (!gather.kinds.has(found.kind)) continue;
      const known = merged.get(found.id);
      if (!known) { merged.set(found.id, found); continue; }
      const [best, other] = known.score >= found.score ? [known, found] : [found, known];
      merged.set(found.id, { ...best, section: best.section ?? other.section, why: [...new Set([best.why, other.why].flatMap((why) => why.split(' · ')))].join(' · ') });
    }
    return [...merged.values()].sort(rankOrder).slice(0, gather.limit);
  }

  /** Opens one page of a candidate. */
  async open(caller: FindCaller, input: OpenInput): Promise<FindOpened & { candidate: Found }> {
    const services = this.services();
    const mode = modeOf(services, caller);
    const [prefix, ...rest] = input.id.split(':');
    const local = rest.join(':');
    let opened: Opened | undefined;
    if (prefix === 'skill') opened = openSkill(services, caller, local, input, mode);
    else if (prefix === 'note' || prefix === 'ref') opened = openNote(services, caller, local, input); // references are knowledge rows
    else if (prefix === 'cat') opened = openCatalog(services, caller, local, input); // B-078: a home project or public library entry
    if (!opened) throw new WorkforceError('not_found', GONE);
    return { candidate: opened.candidate, text: opened.text, page: opened.page, pages: opened.pages, ...(opened.changed ? { changed: opened.changed } : {}), follow: [] };
  }
}

function modeOf(services: RuntimeServices, caller: FindCaller): ModeInfo | undefined {
  const key = caller.mode ?? caller.agent?.mode;
  if (!key) return undefined;
  try { return services.modes.get(key); } catch { return undefined; }
}

async function quiet<T>(work: () => T[] | Promise<T[]>): Promise<T[]> {
  try { return await work(); } catch { return []; }
}

const services = new WeakMap<object, FindService>();

/** The runtime's find service (one per RuntimeServices, created on first use – no composition step). */
export function findService(runtime: RuntimeServices): FindService {
  let service = services.get(runtime);
  if (!service) {
    service = new FindService(() => runtime);
    services.set(runtime, service);
  }
  return service;
}
