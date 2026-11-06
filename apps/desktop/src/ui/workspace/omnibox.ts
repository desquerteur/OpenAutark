// The address field's suggestions, like Chrome's omnibox: what Enter opens for the typed text – the address, or a Google
// search for words (shared/api/workspace-browser.ts omniboxUrl) –, then open tabs ("Switch to this tab") and history
// entries that hold every typed word, best first. A word matches best at the start of the host (www. aside), then at the
// start of a part of the host or of a word of the title, then anywhere in host or title, then in the path; an open tab
// gets a small lift and a history entry its frecency (visits, and how recent its last visit is). One word that is no
// address but the start of a known host ("git" → github.com) puts that host's entry first, so Enter goes there as in
// Chrome (the first row is always the highlighted one, so the person sees where Enter goes). Each address shows once: an
// open tab replaces its history row.
// Owns: that ranking. Never: fetches, renders or opens anything.

import { omniboxUrl, SEARCH_URL, type HistoryEntry } from '../../shared/api/workspace-browser.ts';

export type SuggestionKind = 'go' | 'search' | 'tab' | 'history';
export interface Suggestion { kind: SuggestionKind; url: string; title: string; tabId?: string }
export interface OpenTab { id: string; url: string; title: string }
export const SUGGESTIONS_MAX = 8;
const DAY_MS = 86_400_000;

/** What Enter opens for the text as typed; undefined when it cannot open (a refused address – the field says why). */
export function typedSuggestion(text: string): Suggestion | undefined {
  const typed = text.trim();
  if (!typed) return undefined;
  try {
    const url = omniboxUrl(typed);
    return url.startsWith(SEARCH_URL) ? { kind: 'search', url, title: typed.replace(/^\?\s*/, '') } : { kind: 'go', url, title: url };
  } catch { return undefined; }
}

/** How well an address and title hold every word (0: one word is missing). */
export function matchScore(words: readonly string[], url: string, title: string): number {
  let host: string;
  let rest: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    rest = `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch { return 0; }
  const name = title.toLowerCase();
  const titleWords = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let score = 0;
  for (const word of words) {
    if (host.startsWith(word)) score += 6;
    else if (host.split('.').some((part) => part.startsWith(word)) || titleWords.some((part) => part.startsWith(word))) score += 3;
    else if (host.includes(word) || name.includes(word)) score += 1.5;
    else if (rest.includes(word)) score += 1;
    else return 0;
  }
  return score;
}

/** Visits and recency of a history entry (a visit today counts about two, one a week ago a quarter). */
function frecency(entry: HistoryEntry, now: number): number {
  return Math.log2(1 + entry.visits) + 2 / (1 + Math.max(0, now - entry.at) / DAY_MS);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** The rows under the field for `input` (the first is what Enter opens); `current`: the tab the field belongs to (no "switch" to itself). */
export function rankSuggestions(input: string, history: readonly HistoryEntry[], tabs: readonly OpenTab[], now: number, current?: string): Suggestion[] {
  const text = input.trim();
  if (!text) return [];
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ score: number; item: Suggestion }> = [];
  const visited = new Map(history.map((entry) => [entry.url, entry]));
  const open = new Set<string>();
  for (const tab of tabs) {
    if (tab.id === current || !/^https?:\/\//i.test(tab.url)) continue;
    const score = matchScore(words, tab.url, tab.title);
    const known = visited.get(tab.url);
    if (score > 0) { scored.push({ score: score + 2 + (known ? frecency(known, now) : 0), item: { kind: 'tab', url: tab.url, title: tab.title || tab.url, tabId: tab.id } }); open.add(tab.url); }
  }
  for (const entry of history) {
    if (open.has(entry.url)) continue; // an open tab shows it: "Switch to this tab" instead
    const score = matchScore(words, entry.url, entry.title);
    if (score > 0) scored.push({ score: score + frecency(entry, now), item: { kind: 'history', url: entry.url, title: entry.title || entry.url } });
  }
  scored.sort((a, b) => b.score - a.score);
  const typed = typedSuggestion(text);
  const out: Suggestion[] = [];
  const urls = new Set<string>();
  const tabIds = new Set<string>();
  const add = (item: Suggestion) => {
    if (out.length >= SUGGESTIONS_MAX) return;
    if (item.kind === 'tab') { if (tabIds.has(item.tabId!)) return; tabIds.add(item.tabId!); }
    else { if (urls.has(item.url)) return; urls.add(item.url); }
    out.push(item);
  };
  // one word, no address: the start of a known host goes first (Enter opens it)
  const best = scored[0]?.item;
  const known = typed?.kind === 'search' && words.length === 1 && !text.startsWith('?') && best && hostOf(best.url).startsWith(words[0]!);
  if (known && best) add(best);
  if (typed) add(typed);
  for (const { item } of scored) add(item);
  return out;
}
