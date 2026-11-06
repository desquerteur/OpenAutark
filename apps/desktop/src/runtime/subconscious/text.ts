// Text heuristics: query composition from a long focus text, lexical relevance of a candidate and token similarity for
// de-duplication. All deterministic and cheap (no models).
// Owns: those rules. Never: I/O.

import { foldText, searchTokens } from '../knowledge/normalize.ts';

/** Salient search tokens of a long text: frequent, longer and recent words first (max `max`). */
export function queryTokens(text: string, max = 12): string[] {
  const tokens = searchTokens(text).filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  if (tokens.length <= max) return tokens;
  const folded = foldText(text);
  const recentFrom = Math.floor(folded.length * 0.7);
  const scored = tokens.map((token, order) => {
    let count = 0;
    for (let index = folded.indexOf(token); index >= 0; index = folded.indexOf(token, index + token.length)) count++;
    const recent = folded.lastIndexOf(token) >= recentFrom ? 1.5 : 0;
    return { token, order, score: Math.min(count, 4) + (token.length >= 6 ? 1 : 0) + recent };
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, max).map((entry) => entry.token);
}

/** Share of query tokens (up to 4 counted) that prefix-match a word of the candidate text. */
export function lexicalRelevance(query: string[], candidate: string): number {
  if (!query.length) return 0;
  const words = searchTokens(candidate);
  let matched = 0;
  for (const token of query) if (words.some((word) => word.startsWith(token))) matched++;
  return Math.min(1, matched / Math.min(query.length, 4));
}

/** Long words of the scripts that separate their words (a Chinese or Thai run is a whole clause, no word). */
const LONG_WORD = /(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])\p{L}){5,}/gu;
const STEM = 5;
const MIN_WORDS = 5;

/** The share of `text`'s long words that `source` holds, by their first letters (an ending is no other word); undefined for a text too short to say. */
export function knownShare(source: string, text: string): number | undefined {
  const words = new Set(text.toLowerCase().match(LONG_WORD) ?? []);
  if (words.size < MIN_WORDS) return undefined;
  const plain = source.toLowerCase();
  return [...words].filter((word) => plain.includes(word.slice(0, STEM))).length / words.size;
}

/** Word similarity at which a saved entry clearly covers a new text: it is corrected, not duplicated. */
export const COVERS = 0.6;

/** Jaccard similarity of the folded token sets (0..1). */
export function similarity(a: string, b: string): number {
  const left = new Set(searchTokens(a));
  const right = new Set(searchTokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

