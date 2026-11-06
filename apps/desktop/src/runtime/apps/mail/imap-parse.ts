// B-053 track D: reading IMAP responses (RFC 3501 / RFC 9051). A response arrives as chunks – text lines and the
// literals ({n} or {n+}) between them – and becomes a tagged status, a continuation or an untagged response with
// its values tokenized: atoms (with [section] and <partial> kept whole), quoted strings with escapes, literals as
// Buffers, NIL as null and nested lists. Plus ENVELOPE → addresses, the modified UTF-7 of mailbox names (RFC 3501
// 5.1.3), and how a command argument goes on the wire (atom, quoted string or literal).
// Owns: this grammar (pure). Never: trusts a server value beyond its shape.

export type ImapValue = string | Buffer | null | ImapValue[];
/** Text lines and the literals that followed them, in order: string, Buffer, string, Buffer, …, string. */
export type RawResponse = Array<string | Buffer>;

export interface Tagged { kind: 'tagged'; tag: string; status: 'OK' | 'NO' | 'BAD'; code?: string; text: string }
export interface Continuation { kind: 'cont'; text: string }
export interface Untagged { kind: 'untagged'; type: string; num?: number; values: ImapValue[]; code?: string; text?: string }
export type ImapResponse = Tagged | Continuation | Untagged;

const STATUS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);
export const LITERAL_END = /\{(\d{1,10})\+?\}$/;

class Cursor {
  ci = 0;
  pos: number;
  readonly chunks: RawResponse;
  constructor(chunks: RawResponse, start: number) { this.chunks = chunks; this.pos = start; }
  get s(): string { const c = this.chunks[this.ci]; return typeof c === 'string' ? c : ''; }
}

function readQuoted(cur: Cursor): string {
  const s = cur.s;
  let out = '';
  let i = cur.pos + 1;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { out += s[++i]; continue; }
    if (ch === '"') { i++; break; }
    out += ch;
  }
  cur.pos = i;
  return out;
}

function readAtom(cur: Cursor): string {
  const s = cur.s;
  let depth = 0;
  let i = cur.pos;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ' ' || ch === '(' || ch === ')')) break;
  }
  const atom = s.slice(cur.pos, i);
  cur.pos = i;
  return atom;
}

function readList(cur: Cursor, nested: boolean, depth = 0): ImapValue[] {
  const out: ImapValue[] = [];
  if (depth > 64) return out;
  for (;;) {
    const s = cur.s;
    while (cur.pos < s.length && s[cur.pos] === ' ') cur.pos++;
    if (cur.pos >= s.length) return out; // end of the response (an unclosed list is taken as closed)
    const ch = s[cur.pos];
    if (ch === ')') { cur.pos++; if (nested) return out; continue; }
    if (ch === '(') { cur.pos++; out.push(readList(cur, true, depth + 1)); continue; }
    if (ch === '"') { out.push(readQuoted(cur)); continue; }
    if (ch === '{' || ch === '~') {
      const literal = cur.chunks[cur.ci + 1];
      if (/^~?\{\d{1,10}\+?\}$/.test(s.slice(cur.pos)) && Buffer.isBuffer(literal)) {
        out.push(literal);
        cur.ci += 2;
        cur.pos = 0;
        continue;
      }
    }
    const atom = readAtom(cur);
    if (!atom) { cur.pos++; continue; }
    out.push(atom.toUpperCase() === 'NIL' ? null : atom);
  }
}

/** Tokenizes values starting at `start` in the first text line. */
export function parseValues(chunks: RawResponse, start = 0): ImapValue[] {
  return readList(new Cursor(chunks, start), false);
}

function statusParts(rest: string): { code?: string; text: string } {
  if (!rest.startsWith('[')) return { text: rest };
  const end = rest.indexOf(']');
  if (end < 0) return { text: rest };
  return { code: rest.slice(1, end), text: rest.slice(end + 1).trim() };
}

export function parseResponse(chunks: RawResponse): ImapResponse {
  const line = typeof chunks[0] === 'string' ? chunks[0] : '';
  if (line.startsWith('+')) return { kind: 'cont', text: line.slice(1).trim() };
  if (line.startsWith('* ')) {
    const m = /^\* (?:(\d+) )?([A-Za-z0-9.-]+)(?: |$)/.exec(line);
    if (!m) return { kind: 'untagged', type: '', values: [] };
    const type = m[2].toUpperCase();
    const num = m[1] === undefined ? undefined : Number(m[1]);
    const restAt = m[0].length;
    if (STATUS.has(type) && num === undefined) return { kind: 'untagged', type, values: [], ...statusParts(line.slice(restAt)) };
    if (type === 'CAPABILITY' || type === 'ENABLED') return { kind: 'untagged', type, values: line.slice(restAt).split(' ').filter(Boolean) };
    return { kind: 'untagged', type, num, values: parseValues(chunks, restAt) };
  }
  const m = /^(\S+) (OK|NO|BAD)(?: |$)(.*)$/i.exec(line);
  if (!m) return { kind: 'tagged', tag: line.split(' ')[0] ?? '', status: 'BAD', text: '' };
  return { kind: 'tagged', tag: m[1], status: m[2].toUpperCase() as Tagged['status'], ...statusParts(m[3]) };
}

// ------------------------------------------------------------------ values

export const str = (value: ImapValue | undefined): string | undefined =>
  value === null || value === undefined || Array.isArray(value) ? undefined : Buffer.isBuffer(value) ? value.toString('utf8') : value;

/** FETCH (KEY value KEY value …) → map with upper-case keys; a partial `BODY[]<0>` becomes `BODY[]`. */
export function fetchMap(values: ImapValue[]): Map<string, ImapValue> {
  const list = Array.isArray(values[0]) ? values[0] : values;
  const out = new Map<string, ImapValue>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = str(list[i]);
    if (key) out.set(key.toUpperCase().replace(/<\d+>$/, '').replace('BODY.PEEK', 'BODY'), list[i + 1]);
  }
  return out;
}

export interface ImapAddress { name?: string; address: string }
export interface Envelope {
  date?: string; subject?: string; from: ImapAddress[]; sender: ImapAddress[]; replyTo: ImapAddress[];
  to: ImapAddress[]; cc: ImapAddress[]; bcc: ImapAddress[]; inReplyTo?: string; messageId?: string;
}

function addresses(value: ImapValue | undefined): ImapAddress[] {
  if (!Array.isArray(value)) return [];
  const out: ImapAddress[] = [];
  for (const a of value) {
    if (!Array.isArray(a)) continue;
    const mailbox = str(a[2]);
    const host = str(a[3]);
    if (!mailbox || !host) continue; // group start/end markers
    const name = str(a[0]);
    out.push(name ? { name, address: `${mailbox}@${host}` } : { address: `${mailbox}@${host}` });
  }
  return out;
}

/** ENVELOPE values (names and subject still RFC 2047 encoded – mime.ts decodes them). */
export function parseEnvelope(value: ImapValue | undefined): Envelope {
  const v = Array.isArray(value) ? value : [];
  return {
    date: str(v[0]), subject: str(v[1]), from: addresses(v[2]), sender: addresses(v[3]), replyTo: addresses(v[4]),
    to: addresses(v[5]), cc: addresses(v[6]), bcc: addresses(v[7]), inReplyTo: str(v[8]), messageId: str(v[9]),
  };
}

export const flagsOf = (value: ImapValue | undefined): string[] =>
  Array.isArray(value) ? value.map((f) => str(f)).filter((f): f is string => !!f) : [];

// ------------------------------------------------------------------ modified UTF-7 (mailbox names)

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_all, b64: string) => {
    if (b64 === '') return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

export function encodeMailboxName(name: string): string {
  return name.replace(/&/g, '\u0000').replace(/[^\x20-\x7e\u0000]+/g, (run) => {
    const bytes = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) bytes.writeUInt16BE(run.charCodeAt(i), i * 2);
    return `&${bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  }).replace(/\u0000/g, '&-');
}

// ------------------------------------------------------------------ arguments

/** A command part: raw protocol text, or a string that must travel as a literal. */
export type ImapArg = string | { literal: Buffer };

/** A string argument: quoted when it is printable ASCII, else a literal (UTF-8 bytes). */
export function astring(value: string): ImapArg {
  if (/^[\x20-\x7e]*$/.test(value)) return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  return { literal: Buffer.from(value.replace(/[\r\n]+/g, ' '), 'utf8') };
}

export const mailboxArg = (name: string): ImapArg => astring(encodeMailboxName(name));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** SEARCH date (d-Mon-yyyy) from 'YYYY-MM-DD' or any Date-parsable text; undefined when it is no date. */
export function searchDate(value: string): string | undefined {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}
