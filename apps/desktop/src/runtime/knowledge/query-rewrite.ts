// Lexical query expansion for knowledge search (free, no model): the query's tokens (prefix match) plus
// light stems of inflected words ("Rechnungen" also finds "Rechnung"), an exact phrase for every ID-like
// token ("INV-2024-0042" as the sequence inv 2024 0042, so the exact ID outranks rows that share one of its
// parts) and a small German/English work vocabulary ("Rechnung" <-> "invoice") for mixed-language stores.
// Owns: these expansion rules. Never: calls a model or stores a query.

import { foldText, searchTokens } from './normalize.ts';

export interface ExpandedQuery {
  /** FTS5 MATCH expression (undefined: nothing searchable). */
  match?: string;
  tokens: string[];
  /** ID-like tokens of the query as typed. */
  ids: string[];
  /** Expansion terms added to the query's own tokens (stems and vocabulary). */
  added: string[];
}

/** Pairs of German / English work words (folded); each side finds the other. */
const VOCABULARY: ReadonlyArray<readonly [string, string]> = [
  ['rechnung', 'invoice'], ['kunde', 'customer'], ['kunde', 'client'], ['angebot', 'quote'], ['angebot', 'offer'], ['vertrag', 'contract'],
  ['termin', 'appointment'], ['besprechung', 'meeting'], ['aufgabe', 'task'], ['fehler', 'error'], ['fehler', 'bug'], ['hochladen', 'upload'],
  ['herunterladen', 'download'], ['bild', 'image'], ['datei', 'file'], ['ordner', 'folder'], ['konto', 'account'], ['zahlung', 'payment'],
  ['preis', 'price'], ['steuer', 'tax'], ['bericht', 'report'], ['entwurf', 'draft'], ['veroeffentlichen', 'publish'], ['einstellung', 'setting'],
  ['anleitung', 'guide'], ['schritt', 'step'], ['webseite', 'website'], ['nutzer', 'user'], ['mitarbeiter', 'employee'], ['projekt', 'project'],
  ['frist', 'deadline'], ['ziel', 'goal'], ['lieferant', 'supplier'], ['bestellung', 'order'], ['versand', 'shipping'], ['umsatz', 'revenue'],
  ['ausgabe', 'expense'], ['beleg', 'receipt'], ['vorlage', 'template'], ['schnitt', 'edit'], ['aufnahme', 'recording'], ['untertitel', 'subtitle'],
  ['zusammenfassung', 'summary'], ['speichern', 'save'], ['loeschen', 'delete'], ['suche', 'search'], ['einrichtung', 'setup'], ['anmeldung', 'login'],
];

const LOOKUP = (() => {
  const map = new Map<string, string[]>();
  for (const [a, b] of VOCABULARY) {
    map.set(a, [...(map.get(a) ?? []), b]);
    map.set(b, [...(map.get(b) ?? []), a]);
  }
  return map;
})();

const SUFFIXES = ['ungen', 'ing', 'ies', 'en', 'er', 'es', 'ed', 'e', 's', 'n'];

/** A light stem: the longest common inflection suffix removed, at least 4 letters kept. */
export function stem(token: string): string {
  if (token.length < 5 || /\d/.test(token)) return token;
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return suffix === 'ungen' ? `${token.slice(0, -suffix.length)}ung` : token.slice(0, -suffix.length);
  }
  return token;
}

/** Tokens that look like identifiers: letters and digits mixed, or long digit runs, as typed. */
export function idTokens(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_.:/#-]*[A-Za-z0-9]/g)) {
    const value = match[0];
    const mixed = /\d/.test(value) && /[A-Za-z]/.test(value) && value.length >= 4;
    if (mixed || /^\d{5,}$/.test(value) || (/[-_.:/#]/.test(value) && /\d/.test(value) && value.length >= 5)) out.add(value);
  }
  return [...out].slice(0, 4);
}

const quote = (term: string) => `"${term.replace(/"/g, '')}"`;

export function expandQuery(text: string, options: { maxTokens?: number } = {}): ExpandedQuery {
  const tokens = searchTokens(text).slice(0, options.maxTokens ?? 16);
  const ids = idTokens(text);
  if (!tokens.length) return { tokens, ids, added: [] };
  const terms = new Set(tokens);
  const added: string[] = [];
  const add = (term: string) => {
    if (term.length < 3 || terms.has(term) || tokens.some((token) => term.startsWith(token))) return;
    terms.add(term);
    added.push(term);
  };
  for (const token of tokens) {
    add(stem(token));
    for (const other of LOOKUP.get(token) ?? LOOKUP.get(stem(token)) ?? LOOKUP.get(token.replace(/s$/, '')) ?? []) add(other);
  }
  const parts = [...terms].slice(0, 28).map((term) => `${quote(term)}*`);
  for (const id of ids) {
    const words = foldText(id).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length > 1) parts.unshift(quote(words.join(' ')));
  }
  return { match: parts.join(' OR '), tokens, ids, added };
}

/** Does `text` contain one of the query's IDs as the same word sequence ("INV-2024-0042" ~ "inv 2024 0042")? */
export function exactId(ids: readonly string[], text: string): boolean {
  if (!ids.length) return false;
  const words = ` ${foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;
  return ids.some((id) => words.includes(` ${foldText(id).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `));
}

/** Rank bonus of a row that holds the exact ID the query asks for. */
export const EXACT_ID_BONUS = 1 / 61;
