// German-aware text folding for search (FTS5 indexes and queries) and fuzzy name matching.
// Owns: the one folding rule used everywhere text is indexed or compared ("Straße" = "strasse",
// "Müller" = "muller"), the FTS5 MATCH query builder and a plain-text snippet helper.
// Never: imports anything outside src/shared; never changes stored originals (fold copies only).

/** Lowercase, ß→ss, NFKD and strip combining marks. Stable: fold(fold(x)) === fold(x). */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
}

/** Folded word tokens (letters/digits), in order. */
export function tokens(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Safe FTS5 MATCH expression from free user text: every token becomes a quoted prefix term
 * ("ann"* "video"*), implicitly AND-ed. Returns '' when nothing searchable remains, so callers
 * can skip the query. Quoting neutralizes FTS operators typed by users (AND, NEAR, -, :, *).
 */
export function ftsQuery(text: string, maxTokens = 12): string {
  return tokens(text)
    .slice(0, maxTokens)
    .map(token => `"${token.replace(/"/g, '')}"*`)
    .join(' ');
}

/** True when every folded token of `query` prefixes some word of `text` (client-side filter). */
export function matchesQuery(text: string, query: string): boolean {
  const wanted = tokens(query);
  if (!wanted.length) return true;
  const words = tokens(text);
  return wanted.every(token => words.some(word => word.startsWith(token)));
}

/**
 * Short excerpt of the ORIGINAL text around the first word that matches a query token.
 * Works on originals (unlike FTS5 snippet(), which would show the folded index text).
 */
export function snippet(text: string, query: string, radius = 8): string {
  const wanted = tokens(query);
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (!words.length || !words[0]) return '';
  let hit = words.findIndex(word => {
    const folded = tokens(word);
    return folded.some(part => wanted.some(token => part.startsWith(token)));
  });
  if (hit < 0) hit = 0;
  const from = Math.max(0, hit - radius);
  const to = Math.min(words.length, hit + radius + 1);
  return (from > 0 ? '…' : '') + words.slice(from, to).join(' ') + (to < words.length ? '…' : '');
}
