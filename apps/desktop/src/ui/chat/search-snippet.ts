// The text of a message hit in the chat list's search (ChatList.tsx): the message as written
// (plainPreview), cut so the first searched word sits near the start of the two lines the hit shows –
// a long message shows where it matched, not its opening. Without a visible match (the runtime folds
// accents and matches word starts) the runtime's own snippet is used.
// Owns: the window. Never: what matches (lib/mark-ranges.ts) or the markup (lib/mark.tsx).

import { plainPreview } from '../lib/format.ts';
import { markRanges } from '../lib/mark-ranges.ts';

/** Characters before the first hit at most (two 13 px lines in the sidebar hold about 70). */
const LEAD = 24;
const MAX = 160;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The hit's text: from a word boundary shortly before the first match ("…" in front), at most 160 characters. */
export function hitSnippet(body: string, query: string, fallback: string): string {
  const plain = plainPreview(body, 4000);
  const first = markRanges(plain, query)[0];
  if (!first) return clip(plainPreview(fallback, MAX), MAX);
  if (first[0] <= LEAD) return clip(plain, MAX);
  const space = plain.indexOf(' ', first[0] - LEAD);
  const start = space !== -1 && space < first[0] ? space + 1 : first[0] - LEAD;
  return `…${clip(plain.slice(start), MAX - 1)}`;
}
