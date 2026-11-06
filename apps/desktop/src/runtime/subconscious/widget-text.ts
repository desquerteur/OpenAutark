// Deterministic DE/EN extractors for to-do widgets (F05, used by widget-fill.ts): what a typed
// to-do text itself says – an option list (bullet lines, a list after a colon, "A, B or C"
// ending a question), the first link, a teleprompter script ("Script:" or a quoted passage),
// how a reminder repeats, an amount with its currency and form field labels.
// Owns: those pure text rules. Never: I/O or model calls, guesses beyond the text, or a
// credential field (a password, code, key or card number the person would type into a plain
// to-do – its answer is stored as text, not in the vault).

import { LIMITS } from '../../shared/blocks/catalog.ts';
import { normalizeAmount } from '../../shared/blocks/coerce.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { foldText } from '../../shared/text/normalize.ts';
import { stripUrls } from '../tasks/widgets.ts';

const BULLET = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+(.+?)\s*$/;
const COLON_LIST = /(?<!\d):(?!\d)\s*(.+)$/;
const MAX_ITEMS = 20;
/**
 * What a credential field asks for (folded DE/EN text, plurals too): a password, PIN, TAN, code
 * or key that opens an account, a payment card's number or security code, a recovery phrase.
 * A postcode, a discount code or a customer number is no credential.
 */
const CREDENTIAL = new RegExp(`\\b(${[
  'passw(?:ord|ort)\\w*', 'kennwort\\w*', 'passcodes?', 'passphrases?', 'pins?', 'puks?', 'tans?', 'secrets?', 'geheim\\w*',
  'tokens?', 'credentials?', 'zugangsdaten', 'anmeldedaten', 'login (?:data|details)', '2fa', 'mfa', 'otp', 'totp', 'cvc2?', 'cvv2?',
  '(?:api|private|secret|access|license|licence|product|recovery|ssh|wi-?fi|network) ?keys?',
  '(?:wlan|wi-?fi|netzwerk|lizenz|produkt|zugangs|privat)-?schlussel\\w*',
  '(?:security|verification|recovery|backup|one[- ]?time|login|access|auth\\w*|sms|unlock|2fa|mfa) ?codes?',
  '(?:sicherheits|bestatigungs|zugangs|einmal|wiederherstellungs|freischalt|anmelde|entsperr|aktivierungs)-?codes?',
  'security questions?', 'sicherheitsfragen?', '(?:seed|recovery) phrases?',
  'card ?numbers?', 'credit cards?', 'kreditkart\\w*', 'kartennummer\\w*',
].join('|')})\\b`);

/** The first link of the text, without trailing punctuation or an unbalanced bracket. */
export function firstUrl(text: string): string | undefined {
  let url = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(text)?.[0];
  while (url && /[.,;:!?)\]]$/.test(url)) {
    const last = url.at(-1)!;
    const open = last === ')' ? '(' : last === ']' ? '[' : undefined;
    if (open && url.split(open).length > url.split(last).length - 1) break; // "…/Foo_(bar)" keeps its bracket
    url = url.slice(0, -1);
  }
  return url;
}

/** A list the text gives: two or more bullet lines, else the items after a colon ("Pack: passport, charger and tickets"). */
export function listIn(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const bullets = lines.map((line) => BULLET.exec(line)?.[1]).filter((item): item is string => Boolean(item));
  if (bullets.length >= 2) return clip(bullets);
  for (const line of lines) {
    const after = COLON_LIST.exec(stripUrls(line))?.[1];
    const items = after ? splitList(after) : [];
    if (items.length >= 2) return clip(items);
  }
  return undefined;
}

/** Options the text names: a list, else the alternatives ending its question ("Blue or green?", "the red one or the blue one?"). */
export function optionsIn(text: string): string[] | undefined {
  const list = listIn(text);
  if (list) return list.slice(0, LIMITS.choiceOptions).map(capitalize);
  const line = stripUrls(text.split(/\r?\n/)[0] ?? '');
  const match = /^(.*\S)\s+(?:or|oder)\s+([^,;:?!.]+?)\s*(?:[?!.]|$)/i.exec(line);
  if (!match || match[1].endsWith(',')) return undefined; // ", or wait?" joins clauses, not options
  const right = match[2].trim().split(/\s+/);
  if (right.length > 3) return undefined;
  const left = match[1].split(/\s*,\s*/).map((part) => part.trim().split(/\s+/).slice(-right.length).join(' ')).filter(Boolean);
  const options = [...left, right.join(' ')].map((option) => option.replace(/^(?:between|zwischen)\s+/i, ''));
  return options.length >= 2 ? options.slice(0, LIMITS.choiceOptions).map(capitalize) : undefined;
}

/** A teleprompter script: the text after "Script:" (or "Text:" at a line start), else a quoted passage. */
export function scriptIn(text: string): string | undefined {
  const marked = /\b(?:script|skript|teleprompter)\s*:\s*([\s\S]+)$/i.exec(text) ?? /(?:^|\n)[ \t]*text\s*:\s*([\s\S]+)$/i.exec(text);
  const quoted = /["“„«»]([^"“”„«»]{12,})["”“«»]/.exec(text);
  return (marked?.[1] ?? quoted?.[1])?.trim().slice(0, 8000) || undefined;
}

/** How a reminder repeats ("every day", "werktags", "every Monday"). */
export function repeatIn(text: string): 'daily' | 'weekdays' | 'weekly' | undefined {
  const folded = foldText(text);
  if (/\b(every weekday|weekdays|on weekdays|werktags|wochentags|montags bis freitags)\b/.test(folded)) return 'weekdays';
  if (/\b(every day|each day|daily|every (morning|evening|night)|taglich|jeden (tag|morgen|abend))\b/.test(folded)) return 'daily';
  const day = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)';
  if (new RegExp(`\\b(every week|weekly|wochentlich|jede woche|(every|jeden) ${day})\\b`).test(folded)) return 'weekly';
  return undefined;
}

/** An amount with its currency ("49,90 €", "$30", "EUR 120"). */
export function amountIn(text: string): { value: number; currency: string } | undefined {
  const match = /(?:[€$£]|\b(?:eur|usd|gbp|chf)\b)\s?\d(?:[\d.,]*\d)?|\d(?:[\d.,]*\d)?\s?(?:[€$£]|(?:eur|euros?|usd|dollars?|gbp|chf)\b)/i.exec(text);
  const amount = match ? normalizeAmount(match[0].replace(/euros?/i, 'EUR').replace(/dollars?/i, 'USD')) : undefined;
  return amount && amount.value > 0 ? amount : undefined;
}

const FIELD_KINDS: Array<[RegExp, string]> = [
  [/\b(phone|telefon\w*|mobile|handy)\b/, 'text'], [/e-?mail/, 'email'], [/\b(date|datum|birthday|geburtstag|geburtsdatum)\b/, 'date'],
  [/\b(time|uhrzeit)\b/, 'time'], [/\b(url|website|webseite|homepage|link)\b/, 'url'],
  // A count or an amount; "passport number" or "Kundennummer" is an identifier (text).
  [/\b(number of|anzahl|count|how many|wie viele|age|alter|amount|betrag|menge|quantity)\b/, 'number'],
  [/\b(notes?|notizen?|comments?|kommentar\w*|message|nachricht|description|beschreibung)\b/, 'longtext'],
];

/** Form fields from a list in the text ("Fill in: name, email and birthday") – labels and a kind, never a credential. */
export function fieldsIn(text: string): Array<{ label: string; kind: string }> | undefined {
  const labels = [...new Set(listIn(text) ?? [])].filter((label) => !isCredential(label));
  if (!labels.length) return undefined;
  return labels.map((label) => ({ label: capitalize(label), kind: FIELD_KINDS.find(([pattern]) => pattern.test(foldText(label)))?.[1] ?? 'text' }));
}

/** A label that asks for a password, PIN, code or key (never a plain form field). */
export function isCredential(label: string): boolean {
  return CREDENTIAL.test(foldText(label));
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function splitList(raw: string): string[] {
  const parts = raw.split(/\s*[,;]\s*/);
  parts.push(...(parts.pop() ?? '').split(/\s+(?:and|or|und|oder|&)\s+/i));
  return parts.map((part) => part.replace(/[.!?]+$/, '').trim()).filter(Boolean);
}

function clip(items: string[]): string[] {
  return items.slice(0, MAX_ITEMS).map((item) => excerpt(item, 120));
}
