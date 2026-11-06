// Candidates of one find call (FIND, wave 3) from the stores that already exist – no index of its own:
//  * skills: the skill library (name + description) – the agent's own and the ones its mode or profile names are
//    main skills, the rest product skills;
//  * memory notes: the knowledge search (its own rules on who sees which note) – each with the day it was saved and its age;
//  * references: the person's references – knowledge rows of scope 'reference' (references/references.ts), opened as notes.
// One explainable score for all of them: the share of the query's salient words a candidate's own text carries
// (subconscious/text.ts lexicalRelevance), at least SEMANTIC_FLOOR for a match by meaning, plus an exact-ID bonus, a
// small bonus for the underlying search's own rank and one for a main skill. Files are searched with files.search.
// Owns: the mapping, the score and its `why`. Never: copies text into the result beyond a short description, or embeds.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { FindCandidate, FindKind } from '../../shared/model/find.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { KnowledgeItem, KnowledgeKind, ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import { exactId } from '../knowledge/query-rewrite.ts';
import { savedText } from '../knowledge/age.ts';
import { profileZone } from '../context/time.ts';
import { findReferences } from '../references/references.ts';
import { lexicalRelevance } from '../subconscious/text.ts';

/** Who asks: the agent (absent = the person on this PC), the turn's chat and thread, its mode. */
export interface FindCaller {
  agent?: Agent;
  conversationId?: string;
  thread?: string;
  mode?: string;
  /** Who asks – kept for wording and tests, never a right. */
  via: 'agent' | 'owner';
}

/** A candidate with what only the runtime needs (never shown): the file on disk, the keyword share. */
export interface Found extends FindCandidate {
  abs?: string;
  /** The share of the query's words in its own text (0 = a match by meaning or ID only). */
  lexical?: number;
}

export interface Gather {
  query: string;
  /** Salient words of the query (subconscious/text.ts queryTokens). */
  tokens: string[];
  /** Exact IDs in the query (query-rewrite.ts idTokens). */
  ids: string[];
  kinds: ReadonlySet<FindKind>;
  limit: number;
  signal?: AbortSignal;
}

export const MIN_SCORE = 0.25;
export const SEMANTIC_FLOOR = 0.6;
const EXACT_BONUS = 0.2;
const RANK_BONUS = 0.1;
const MAIN_BONUS = 0.05;
export const NOTE_KINDS: KnowledgeKind[] = ['fact', 'preference', 'experience', 'procedure', 'plan', 'note'];

export const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** The score of `text` for the query, with its reason parts. */
export function scoreOf(g: Pick<Gather, 'tokens' | 'ids'>, text: string, options: { semantic?: boolean; rank?: number } = {}): { score: number; why: string[]; lexical: number } {
  const why: string[] = [];
  const lexical = lexicalRelevance(g.tokens, text);
  let score = lexical;
  if (score > 0) why.push(`matches ${Math.round(score * Math.min(g.tokens.length, 4))} of ${Math.min(g.tokens.length, 4)} words`);
  if (options.semantic) { score = Math.max(score, SEMANTIC_FLOOR); why.push('similar meaning'); }
  if (g.ids.length && exactId(g.ids, text)) { score += EXACT_BONUS; why.push('exact ID'); }
  if (options.rank !== undefined && score > 0) score += RANK_BONUS / (1 + options.rank);
  return { score: Math.min(1, Number(score.toFixed(3))), why, lexical };
}

/** Is this skill one of the caller's main skills (its own, or named by its profile or mode)? */
function mainSkill(info: SkillInfo, caller: FindCaller, mode: ModeInfo | undefined): boolean {
  const agent = caller.agent;
  if (!agent) return false;
  return (info.source === 'agent' && info.ownerAgentId === agent.id) || agent.skills.includes(info.name) || Boolean(mode?.skills.includes(info.name));
}

const skillOrigin = (info: SkillInfo, main: boolean): string =>
  info.source === 'builtin' ? 'built-in' : info.source === 'agent' ? (main ? 'your own' : 'agent skill') : 'skill library';

/** The candidate of one skill (version: its text's hash); undefined when it cannot be read. */
export function skillFound(services: RuntimeServices, caller: FindCaller, info: SkillInfo, mode: ModeInfo | undefined, score: number, why: string[]): Found | undefined {
  const loaded = services.skills.get(info.name);
  if (!loaded) return undefined;
  const main = mainSkill(info, caller, mode);
  return {
    id: `skill:${info.name}`, kind: main ? 'main-skill' : 'product-skill', authority: 'skill', title: info.name,
    route: `skills/${path.basename(info.path)}/SKILL.md`, abs: path.join(info.path, 'SKILL.md'), version: shortHash(loaded.body), score: Math.min(1, score + (main ? MAIN_BONUS : 0)),
    why: [...why, ...(main ? [info.source === 'agent' ? 'your own skill' : 'named for you'] : [])].join(' · ') || 'skill', origin: skillOrigin(info, main),
    ...(info.description ? { description: info.description } : {}),
  };
}

export function skillCandidates(services: RuntimeServices, caller: FindCaller, g: Gather, mode: ModeInfo | undefined): Found[] {
  if (!g.kinds.has('main-skill') && !g.kinds.has('product-skill')) return [];
  const out: Found[] = [];
  for (const info of services.skills.list()) {
    const { score, why, lexical } = scoreOf(g, `${info.name.replace(/-/g, ' ')} ${info.description}`);
    if (score < MIN_SCORE) continue;
    const found = skillFound(services, caller, info, mode, score, why);
    if (found && g.kinds.has(found.kind)) out.push({ ...found, lexical });
  }
  return out;
}

/** The candidate of one memory note: its place and the day it was saved (in `zone`, the person's) with its age. */
export function noteFound(item: KnowledgeItem, now: number, score: number, why: readonly string[], zone: string | undefined): Found {
  const place = `memory · ${item.scope}${item.pinned ? ' · pinned' : ''}`;
  return {
    id: `note:${item.id}`, kind: 'note', authority: 'hint', title: item.title, route: place,
    version: `r${item.recordedAt.toString(36)}`, score, why: [...why, savedText(item.recordedAt, now, zone)].join(' · '),
    origin: place, ...(item.description ? { description: item.description } : {}),
  };
}

export async function noteCandidates(services: RuntimeServices, caller: FindCaller, g: Gather): Promise<Found[]> {
  if (!g.kinds.has('note')) return [];
  // The whole tree: the caller asked with its own words; code names no part of memory for it (owner's rule (f)).
  const hits = await services.knowledge.search({ text: g.query, folders: [''], conversationId: caller.conversationId, kinds: NOTE_KINDS, limit: g.limit });
  const now = services.clock.now();
  const zone = profileZone(services);
  return hits.flatMap((hit, rank) => {
    const { score, why, lexical } = scoreOf(g, `${hit.item.title} ${hit.item.description ?? ''} ${hit.item.body}`, { semantic: hit.why.includes('similar meaning'), rank });
    return score < MIN_SCORE ? [] : [{ ...noteFound(hit.item, now, score, why, zone), lexical }];
  });
}

export async function referenceCandidates(services: RuntimeServices, _caller: FindCaller, g: Gather): Promise<Found[]> {
  if (!g.kinds.has('reference')) return [];
  const hits = await findReferences(services.knowledge, { text: g.query, limit: Math.min(5, g.limit) });
  const now = services.clock.now();
  const zone = profileZone(services);
  return hits.flatMap((hit, rank) => {
    const { score, why, lexical } = scoreOf(g, `${hit.item.title} ${hit.item.description ?? ''} ${hit.item.body}`, { semantic: hit.why.includes('similar meaning'), rank });
    if (score < MIN_SCORE) return [];
    return [{ ...noteFound(hit.item, now, score, why, zone), kind: 'reference' as const, route: 'references', origin: 'reference', lexical }];
  });
}
