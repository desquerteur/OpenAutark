// Reads a password export (owner 29.10.2026: import
// the browser's passwords once, so the catalog starts full): the CSV of Chrome, Edge, Brave, Opera, Vivaldi, Firefox,
// Safari / Apple Passwords, Bitwarden, 1Password, KeePass(XC), LastPass, Dashlane, Proton Pass, NordPass – any CSV whose
// header names a password column – and Bitwarden's unencrypted JSON (logins and cards). The columns are found by their
// names, so an unknown manager with usual names works too. Owner 04.11.2026: a .env file and a flat JSON object of text
// values (shared/model/key-values.ts) give one single value per secret; a plain setting (isSecretPair) or a value too
// short to mask (MIN_SECRET_CHARS) counts as skipped. Owner 04.11.2026: the app's own export (secrets/export.ts – Chrome's
// columns plus kind, description, tags, route and a card's number, expiry, cvc, holder) comes back whole: a login, a card
// (kind card with a number) or a single secret of its kind (its value under password), each with its description, tags
// (split at ';') and route – so a second company needs no renaming.
// Owns: CSV parsing (quotes, "" escapes, line breaks in fields, BOM, "," ";" or tab), the column and format detection and
// a clean item per row. A URL keeps only scheme, host and path (a query or fragment may hold a token).
// Never: logs, returns or keeps anything beyond the parsed items (the caller writes them into the vault at once).

import { ENV_FORMAT, JSON_FORMAT, isSecretPair, parseKeyValues, type KeyValue } from '../../shared/model/key-values.ts';
import { SECRET_ROUTE, type SecretInfo } from '../../shared/model/security.ts';
import { SECRET_KINDS } from './groups.ts';
import { MIN_SECRET_CHARS } from './redact.ts';

/** What the app's own export carries beside the values (secrets/export.ts); absent in every other format. */
export interface ImportedMeta {
  description?: string;
  tags?: string[];
  route?: string;
}

export interface ImportedLogin extends ImportedMeta {
  type: 'login';
  name?: string;
  url?: string;
  username?: string;
  password: string;
  totp?: string;
  notes?: string;
  folder?: string;
}

export interface ImportedCard extends ImportedMeta {
  type: 'card';
  name?: string;
  holder?: string;
  number: string;
  expiry?: string;
  cvc?: string;
  notes?: string;
  folder?: string;
}

/** One name and its value of a .env or JSON file – or a single secret of the app's own export (with its kind and site): a single secret named after it. */
export interface ImportedValue extends ImportedMeta {
  type: 'value';
  name: string;
  value: string;
  kind?: SecretInfo['kind'];
  url?: string;
}

export type ImportedItem = ImportedLogin | ImportedCard | ImportedValue;

export interface ParsedExport {
  /** Where it came from, as the person knows it ("Chrome", "Firefox", "Bitwarden", ".env file" …). */
  format: string;
  items: ImportedItem[];
  /** Rows that hold no password (or no card number) or are not logins; pairs that are plain settings or too short. */
  skipped: number;
}

/** A larger text is refused (an export of thousands of logins is far smaller). */
export const MAX_IMPORT_CHARS = 5 * 1024 * 1024;
/** At most this many rows are read. */
export const MAX_IMPORT_ROWS = 10_000;
/** The format of a CSV with a password column that no known browser or password manager wrote (e.g. a project's users.csv). */
export const GENERIC_EXPORT = 'a password export';
/** The format of the app's own export (secrets/export.ts). */
export const OWN_EXPORT = 'Autark export';
/** The columns only that export has together (any other CSV with a password column is no export of ours). */
const OWN_COLUMNS = ['totp', 'kind', 'description', 'tags', 'route'];

const COLUMNS = {
  name: ['name', 'title', 'account', 'item name', 'entry'],
  url: ['url', 'login_uri', 'uri', 'website', 'web site', 'login url', 'origin', 'origin_url', 'urls', 'hostname', 'site'],
  username: ['username', 'login_username', 'user name', 'login', 'login name', 'user', 'email', 'e-mail', 'username1'],
  password: ['password', 'login_password', 'pass', 'passwort', 'kennwort'],
  totp: ['totp', 'login_totp', 'otpauth', 'otp', 'otpsecret', 'otp secret', 'otpurl', 'one-time password', '2fa', 'mfa'],
  notes: ['note', 'notes', 'extra', 'comment', 'comments', 'notiz', 'notizen'],
  folder: ['folder', 'group', 'grouping', 'category', 'vault', 'collection'],
  type: ['type', 'item type'],
  kind: ['kind'],
  description: ['description'],
  tags: ['tags'],
  route: ['route'],
  number: ['number'],
  expiry: ['expiry'],
  cvc: ['cvc'],
  holder: ['holder'],
} as const;

type Column = keyof typeof COLUMNS;

/** The usual export file names and the browser they stand for (Chromium browsers share one format). */
const FILE_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/edge/i, 'Microsoft Edge'], [/brave/i, 'Brave'], [/opera/i, 'Opera'], [/vivaldi/i, 'Vivaldi'], [/arc\b/i, 'Arc'],
  [/chrome|google/i, 'Chrome'], [/firefox|logins\.csv/i, 'Firefox'], [/safari|apple|icloud/i, 'Safari / Apple Passwords'],
  [/bitwarden/i, 'Bitwarden'], [/1password/i, '1Password'], [/keepass/i, 'KeePass'], [/lastpass/i, 'LastPass'],
  [/dashlane/i, 'Dashlane'], [/proton/i, 'Proton Pass'], [/nordpass/i, 'NordPass'],
];

const clean = (value: string | undefined): string | undefined => {
  const text = value?.replace(/\u0000/g, '').trim();
  return text ? text : undefined;
};

/** Scheme, host and path of a URL (no query, fragment or user info); an app id (android://…@com.app) as "android app com.app". */
export function safeUrl(value: string | undefined): string | undefined {
  const raw = clean(value);
  if (!raw || /\s/.test(raw)) return undefined;
  const app = /^android:\/\/[^@]*@([a-z0-9_.]+)\/?/i.exec(raw);
  if (app) return `android app ${app[1]}`;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname || (!url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('['))) return undefined;
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${path}`.slice(0, 300);
  } catch {
    return undefined;
  }
}

/** The delimiter of the header line (outside quotes): ",", ";" or a tab. */
function delimiterOf(text: string): string {
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }
  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

/** RFC 4180 rows: quoted fields with "" escapes and line breaks; CRLF or LF; a leading BOM dropped; empty lines skipped. */
export function parseCsv(input: string, maxRows = MAX_IMPORT_ROWS + 1): string[][] {
  const text = input.replace(/^﻿/, '');
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0].trim()) rows.push(row);
    row = [];
    field = '';
  };
  while (i < text.length && rows.length < maxRows) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (char === '"') { quoted = false; i++; continue; }
      field += char; i++; continue;
    }
    if (char === '"' && !field.trim()) { field = ''; quoted = true; i++; continue; }
    if (char === delimiter) { row.push(field); field = ''; i++; continue; }
    if (char === '\r' || char === '\n') { endRow(); i += char === '\r' && text[i + 1] === '\n' ? 2 : 1; continue; }
    field += char; i++;
  }
  if (rows.length < maxRows && (field || row.length)) endRow();
  return rows;
}

/** Which column holds what (the first header naming it; "username" before "email"). */
function columnsOf(header: string[]): Partial<Record<Column, number>> {
  const names = header.map((name) => name.trim().toLowerCase().replace(/^"|"$/g, ''));
  const out: Partial<Record<Column, number>> = {};
  for (const column of Object.keys(COLUMNS) as Column[]) {
    for (const wanted of COLUMNS[column]) {
      const index = names.indexOf(wanted);
      if (index >= 0 && !Object.values(out).includes(index)) { out[column] = index; break; }
    }
  }
  return out;
}

/** The format a CSV header stands for (the file name names a Chromium browser, which all share one header). */
function formatOf(header: string[], fileName = ''): string {
  const names = new Set(header.map((name) => name.trim().toLowerCase()));
  const byFile = FILE_NAMES.find(([pattern]) => pattern.test(fileName))?.[1];
  if (OWN_COLUMNS.every((name) => names.has(name))) return OWN_EXPORT;
  if (names.has('login_uri') || names.has('login_password')) return 'Bitwarden';
  if (names.has('guid') || names.has('httprealm') || names.has('formactionorigin')) return 'Firefox';
  if (names.has('username2') || names.has('otpsecret')) return 'Dashlane';
  if (names.has('grouping') || (names.has('extra') && names.has('fav'))) return 'LastPass';
  if (names.has('cardholdername')) return 'NordPass';
  if (names.has('vault') && names.has('email')) return 'Proton Pass';
  if (names.has('archived') && names.has('otpauth')) return '1Password';
  if (names.has('otpauth')) return 'Safari / Apple Passwords';
  if (names.has('group') && names.has('title')) return 'KeePass';
  const chromium = names.has('name') && names.has('url') && names.has('username') && names.has('password') && names.size <= 5;
  if (chromium) return byFile && !/firefox|safari|bitwarden|1password|keepass|lastpass|dashlane|proton|nordpass/i.test(byFile) ? byFile : 'Chrome, Edge or Brave';
  return byFile ?? GENERIC_EXPORT;
}

/** The description, tags (split at ';') and route of a row – a route only when it can name a file. */
function metaOf(get: (column: 'description' | 'tags' | 'route') => string | undefined): ImportedMeta {
  const description = get('description');
  const tags = get('tags')?.split(';').map((tag) => tag.trim()).filter(Boolean);
  const route = get('route')?.toLowerCase();
  return {
    ...(description ? { description } : {}), ...(tags?.length ? { tags } : {}),
    ...(route && SECRET_ROUTE.test(route) && !route.endsWith('-rejected') ? { route } : {}),
  };
}

function fromCsv(text: string, fileName?: string): ParsedExport {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The file is empty.');
  const [header, ...body] = rows;
  const columns = columnsOf(header);
  if (columns.password === undefined) throw new Error('No password column found. Export the passwords as CSV (or Bitwarden JSON) and choose that file.');
  if (body.length > MAX_IMPORT_ROWS) throw new Error(`The file has more than ${MAX_IMPORT_ROWS} entries.`);
  const get = (row: string[], column: Column) => (columns[column] === undefined ? undefined : clean(row[columns[column]!]));
  const items: ImportedItem[] = [];
  let skipped = 0;
  for (const row of body) {
    const type = get(row, 'type')?.toLowerCase();
    const kind = get(row, 'kind')?.toLowerCase();
    const password = columns.password === undefined ? undefined : row[columns.password]; // a password keeps its spaces
    const name = get(row, 'name')?.slice(0, 120);
    const notes = get(row, 'notes');
    const meta = metaOf((column) => get(row, column));
    const number = get(row, 'number');
    if (kind === 'card' && number) {
      const [expiry, cvc, holder] = [get(row, 'expiry'), get(row, 'cvc'), get(row, 'holder')];
      items.push({ type: 'card', number, ...(name ? { name } : {}), ...(holder ? { holder } : {}), ...(expiry ? { expiry } : {}), ...(cvc ? { cvc } : {}), ...(notes ? { notes } : {}), ...meta });
      continue;
    }
    if (kind && (SECRET_KINDS as readonly string[]).includes(kind)) { // a single secret of the app's own export
      if (!name || !password?.trim()) { skipped++; continue; }
      const url = safeUrl(get(row, 'url'));
      items.push({ type: 'value', name, value: password.replace(/\u0000/g, ''), kind: kind as SecretInfo['kind'], ...(url ? { url } : {}), ...meta });
      continue;
    }
    if ((type && type !== 'login' && type !== '1' && type !== 'password') || !password?.trim()) { skipped++; continue; }
    const url = safeUrl(get(row, 'url'));
    const item: ImportedLogin = { type: 'login', password: password.replace(/\u0000/g, ''), ...meta };
    const username = get(row, 'username');
    const totp = get(row, 'totp');
    const folder = get(row, 'folder');
    if (name) item.name = name;
    if (url) item.url = url;
    if (username) item.username = username.slice(0, 320);
    if (totp) item.totp = totp;
    if (notes) item.notes = notes;
    if (folder) item.folder = folder.slice(0, 80);
    items.push(item);
  }
  return { format: formatOf(header, fileName), items, skipped };
}

interface BitwardenItem {
  type?: number; name?: string; notes?: string | null; folderId?: string | null;
  login?: { username?: string | null; password?: string | null; totp?: string | null; uris?: Array<{ uri?: string | null }> | null } | null;
  card?: { cardholderName?: string | null; number?: string | null; expMonth?: string | null; expYear?: string | null; code?: string | null } | null;
}

function fromBitwardenJson(data: { encrypted?: boolean; items?: BitwardenItem[]; folders?: Array<{ id?: string; name?: string }> }): ParsedExport {
  if (data.encrypted) throw new Error('This Bitwarden export is encrypted. Export it again as "JSON" or ".csv" (not the encrypted format).');
  const folders = new Map((data.folders ?? []).map((folder) => [folder.id, folder.name]));
  const items: ImportedItem[] = [];
  let skipped = 0;
  for (const entry of (data.items ?? []).slice(0, MAX_IMPORT_ROWS)) {
    const folder = clean(entry.folderId ? folders.get(entry.folderId) ?? undefined : undefined);
    const name = clean(entry.name ?? undefined)?.slice(0, 120);
    const notes = clean(entry.notes ?? undefined);
    if (entry.type === 1 && entry.login?.password) {
      const url = safeUrl(entry.login.uris?.find((uri) => clean(uri.uri ?? undefined))?.uri ?? undefined);
      const username = clean(entry.login.username ?? undefined);
      const totp = clean(entry.login.totp ?? undefined);
      items.push({ type: 'login', password: entry.login.password, ...(name ? { name } : {}), ...(url ? { url } : {}), ...(username ? { username: username.slice(0, 320) } : {}), ...(totp ? { totp } : {}), ...(notes ? { notes } : {}), ...(folder ? { folder } : {}) });
    } else if (entry.type === 3 && clean(entry.card?.number ?? undefined)) {
      const card = entry.card!;
      const month = clean(card.expMonth ?? undefined);
      const year = clean(card.expYear ?? undefined);
      const expiry = month && year ? `${month.padStart(2, '0')}/${year.slice(-2)}` : undefined;
      const holder = clean(card.cardholderName ?? undefined);
      const cvc = clean(card.code ?? undefined);
      items.push({ type: 'card', number: clean(card.number ?? undefined)!, ...(name ? { name } : {}), ...(holder ? { holder } : {}), ...(expiry ? { expiry } : {}), ...(cvc ? { cvc } : {}), ...(notes ? { notes } : {}), ...(folder ? { folder } : {}) });
    } else skipped++;
  }
  return { format: 'Bitwarden', items, skipped };
}

/**
 * The secrets of a .env or JSON file. Skipped: a plain setting – the vault would mask it in everything agents read – and a
 * value shorter than MIN_SECRET_CHARS (it cannot be masked, and the vault would cut it out of the entry's tag and description).
 */
function fromPairs(pairs: KeyValue[], format: string): ParsedExport {
  if (pairs.length > MAX_IMPORT_ROWS) throw new Error(`The file has more than ${MAX_IMPORT_ROWS} entries.`);
  const items: ImportedValue[] = pairs.filter((pair) => pair.value.trim().length >= MIN_SECRET_CHARS && isSecretPair(pair)).map((pair) => ({ type: 'value' as const, name: pair.name.slice(0, 120), value: pair.value }));
  return { format, items, skipped: pairs.length - items.length };
}

/** The items of an export file's text (`fileName` names the browser of a Chromium CSV). Throws a person-readable Error. */
export function parseExport(text: string, fileName?: string): ParsedExport {
  if (text.length > MAX_IMPORT_CHARS) throw new Error('The file is too large (at most 5 MB).');
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{')) {
    let data: unknown;
    try { data = JSON.parse(trimmed); } catch { throw new Error('The JSON file could not be read.'); }
    if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) return fromBitwardenJson(data as Parameters<typeof fromBitwardenJson>[0]);
    const pairs = parseKeyValues(trimmed);
    if (pairs) return fromPairs(pairs, JSON_FORMAT);
    throw new Error('This JSON file is no Bitwarden export and no list of names with text values. Export the passwords as CSV and choose that file.');
  }
  if (/^<\?xml|^<KeePassFile/i.test(trimmed)) throw new Error('KeePass XML is not read. In KeePass or KeePassXC export as CSV and choose that file.');
  const pairs = parseKeyValues(text);
  return pairs ? fromPairs(pairs, ENV_FORMAT) : fromCsv(text, fileName);
}
