// Where a search query's words occur in a text (lib/mark.tsx draws them): case-insensitive, words of
// two or more characters, overlapping hits merged, in text order. A query word that starts a word of
// the text is marked only there ("la" marks "Launch plan" once, not also inside "plan"); one found
// only inside words is marked where it is.
// Owns: the ranges. Never: markup.

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** [start, end) ranges of the query's words in `text`, merged and sorted. */
export function markRanges(text: string, query: string): Array<[number, number]> {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter((word) => word.length >= 2))];
  if (!words.length || !text) return [];
  const lower = text.toLowerCase();
  const found: Array<[number, number]> = [];
  for (const word of words) {
    const all: Array<[number, number]> = [];
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) all.push([at, at + word.length]);
    const starts = all.filter(([at]) => at === 0 || !WORD_CHAR.test(text[at - 1]));
    found.push(...(starts.length ? starts : all));
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
