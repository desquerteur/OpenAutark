// Text normalization for full-text search (German-aware) and keyword matching.
// Owns: folding text to a canonical search form (ä→ae, ö→oe, ü→ue, ß→ss, other diacritics
// stripped, lowercase) and building safe FTS5 MATCH expressions from free text.
// Never: stores anything. Note: src/shared/text had no exported normalizer when this module was
// written, so the folding lives here; move it to shared/text if the UI ever needs the same rule.
//
// Why fold at index AND query time: FTS5 `remove_diacritics 2` turns "ü" into "u", but German
// users type "Mueller" as often as "Müller". Folding both sides to "mueller" makes the two
// spellings meet; plain "Muller" (rare) is lost, which is the better trade.

const UMLAUTS: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss', 'ẞ': 'ss' };

/** Lowercase, German umlaut folding, diacritics removed, whitespace collapsed. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[äöüßẞ]/g, char => UMLAUTS[char] ?? char)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Small DE/EN stopword list: dropped from search queries only (never from the index). */
const STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder', 'aber',
  'ist', 'sind', 'war', 'mit', 'fuer', 'von', 'auf', 'aus', 'bei', 'nach', 'wie', 'was', 'wer', 'wo', 'ich',
  'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'mir', 'dich', 'dir', 'uns', 'zu', 'im', 'in', 'am', 'an',
  'ja', 'ok', 'okay', 'yes', 'nicht', 'noch', 'auch', 'so', 'dann', 'mal', 'bitte', 'kannst', 'koennen', 'kann', 'soll', 'sollst',
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'with', 'for', 'of', 'on', 'at', 'to', 'in',
  'it', 'this', 'that', 'what', 'how', 'who', 'i', 'you', 'we', 'me', 'my', 'your', 'please', 'can', 'could',
]);

/** Tokens of a folded text (letters/digits, ≥ 2 chars), stopwords removed. */
export function searchTokens(text: string): string[] {
  const tokens = foldText(text).split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

/**
 * Builds an FTS5 MATCH expression: every token quoted (no operator injection) with prefix
 * match, joined by OR so partial overlap still ranks (bm25 orders the results).
 * Returns undefined when the text has no searchable token.
 */
export function ftsQuery(text: string, options: { maxTokens?: number } = {}): string | undefined {
  const tokens = searchTokens(text).slice(0, options.maxTokens ?? 16);
  if (tokens.length === 0) return undefined;
  return tokens.map(token => `"${token.replace(/"/g, '')}"*`).join(' OR ');
}

/** True when `text` contains any of the folded keywords (word-prefix match). */
export function containsKeyword(foldedText: string, keywords: readonly string[]): boolean {
  for (const keyword of keywords) {
    const index = foldedText.indexOf(keyword);
    if (index < 0) continue;
    const before = index === 0 ? ' ' : foldedText[index - 1];
    if (!/[\p{L}\p{N}]/u.test(before)) return true;
  }
  return false;
}
