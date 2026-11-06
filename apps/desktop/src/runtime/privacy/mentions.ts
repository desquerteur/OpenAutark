// Does a text still mention a forgotten fact? Used for what the context ledger holds (context/ledger/forget.ts).
// A text mentions it when it holds one of the fact's exact IDs (invoice numbers, codes …), or – for
// a fact with at least LONG distinctive words – 60 % of them; a shorter fact needs all of its
// distinctive words ("User prefers dark mode" must not match every summary that says user and mode).
// Owns: that rule. Never: reads or
// deletes anything itself, or keeps the forgotten text beyond the call.

import { foldText, searchTokens } from '../knowledge/normalize.ts';
import { exactId, idTokens } from '../knowledge/query-rewrite.ts';

const SHARE = 0.6;
/** From this many distinctive words on, SHARE of them suffice. */
const LONG = 6;
const MIN_WORD = 4;

export interface Fingerprint {
  ids: string[];
  words: string[];
}

/** The distinctive parts of a fact's versions (title + body). */
export function fingerprint(texts: readonly string[]): Fingerprint {
  const ids = new Set<string>();
  const words = new Set<string>();
  for (const text of texts) {
    for (const id of idTokens(text)) ids.add(id);
    for (const token of searchTokens(text)) if (token.length >= MIN_WORD && !/^\d+$/.test(token)) words.add(token);
  }
  return { ids: [...ids].slice(0, 8), words: [...words].slice(0, 40) };
}

/** True when `text` mentions the fingerprinted fact (see header). */
export function mentions(text: string, print: Fingerprint): boolean {
  if (!text.trim()) return false;
  if (print.ids.length && exactId(print.ids, text)) return true;
  if (!print.words.length) return false;
  const present = new Set(foldText(text).split(/[^\p{L}\p{N}]+/u));
  const hits = print.words.filter((word) => present.has(word)).length;
  return print.words.length >= LONG ? hits / print.words.length >= SHARE : hits === print.words.length;
}

