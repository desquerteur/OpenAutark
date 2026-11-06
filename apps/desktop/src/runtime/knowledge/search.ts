// The word search of memory, for when no embedder is there (never merged with vector hits): the query lexically expanded
// (query-rewrite.ts: stems, a small DE/EN vocabulary), title and description words count more than body words, a file
// holding an exact ID the query names comes first. Also the short `why` of every hit – it ends with the day the note was saved and its age
// ("saved 2026-10-04, 3 weeks ago", age.ts; the day in the person's `zone`).
// Owns: this ranking and the `why` text. Never: decides which files a turn reads (acl.ts) or calls a model.

import type { KnowledgeHit, KnowledgeItem } from '../../shared/model/knowledge.ts';
import { savedText } from './age.ts';
import { foldText } from './normalize.ts';
import { EXACT_ID_BONUS, exactId, expandQuery } from './query-rewrite.ts';

const TITLE_WEIGHT = 3;

/** The items that hold a word of `text`, best first. */
export function wordHits(items: readonly KnowledgeItem[], text: string, limit: number, now: number, zone: string | undefined): KnowledgeHit[] {
  const expanded = expandQuery(text);
  const terms = [...expanded.tokens, ...expanded.added];
  if (!terms.length) return [];
  return items
    .map((item) => {
      const title = foldText(`${item.title} ${item.description ?? ''}`);
      const body = foldText(item.body);
      const count = terms.reduce((sum, term) => sum + (title.includes(term) ? TITLE_WEIGHT : 0) + (body.includes(term) ? 1 : 0), 0);
      return { item, count, exact: expanded.ids.length > 0 && exactId(expanded.ids, `${item.title} ${item.body}`) };
    })
    .filter(({ count }) => count > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.count - a.count || b.item.recordedAt - a.item.recordedAt || (a.item.id < b.item.id ? -1 : 1))
    .slice(0, limit)
    .map(({ item, exact }, index) => ({ item, score: Number((1 / (61 + index) + (exact ? EXACT_ID_BONUS : 0)).toFixed(5)), why: wordWhy(item, expanded.tokens, now, zone) }));
}

function wordWhy(item: KnowledgeItem, tokens: readonly string[], now: number, zone: string | undefined): string {
  const haystack = foldText(`${item.title} ${item.description ?? ''} ${item.body}`);
  const matched = tokens.filter((token) => haystack.includes(token)).slice(0, 4);
  return [...(matched.length ? [`matches '${matched.join(' ')}'`] : []), savedText(item.recordedAt, now, zone)].join(' · ');
}

/** The `why` of a vector hit. */
export function vectorWhy(item: KnowledgeItem, now: number, zone: string | undefined): string {
  return `similar meaning · ${savedText(item.recordedAt, now, zone)}`;
}
