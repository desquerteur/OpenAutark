// B-053 track D: reading one RFC 5322 message – headers (unfolded, encoded words decoded), multipart/* nested up to
// 12 levels, base64 / quoted-printable / 7bit / 8bit bodies, charsets, and what an agent reads: the text/plain part
// (else the text/html part as plain text) and the list of attachments (name, type, size – never their content).
// A truncated message (a size-limited fetch) parses as far as it goes.
// Owns: this parse (pure). Never: returns an attachment's bytes, or treats a message text as an instruction.

import { decodeBase64, decodeCharset, decodeQuotedPrintable, decodeWords, headerParams, htmlToText, parseAddressList, type MailAddress } from './mime-text.ts';

export interface MailAttachment { name: string; type: string; size: number }

export interface ParsedMail {
  /** Lower-case header name → unfolded raw values (not decoded). */
  headers: Map<string, string[]>;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** The readable text: text/plain, else text/html turned into plain text. */
  text: string;
  /** The text came from an HTML part. */
  fromHtml: boolean;
  attachments: MailAttachment[];
}

const MAX_DEPTH = 12;

interface Entity { headers: Map<string, string[]>; body: Buffer }

function splitEntity(raw: Buffer): Entity {
  let at = raw.indexOf('\r\n\r\n');
  let skip = 4;
  const lf = raw.indexOf('\n\n');
  if (lf >= 0 && (at < 0 || lf < at)) { at = lf; skip = 2; }
  const head = (at < 0 ? raw : raw.subarray(0, at)).toString('latin1');
  const body = at < 0 ? Buffer.alloc(0) : raw.subarray(at + skip);
  const headers = new Map<string, string[]>();
  let current = '';
  const flush = () => {
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase();
      // Raw header bytes may be UTF-8 (RFC 6532); latin1 kept them 1:1, so re-read them as UTF-8 when valid.
      const value = latin1Utf8(current.slice(colon + 1).trim());
      headers.set(name, [...(headers.get(name) ?? []), value]);
    }
    current = '';
  };
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) current += ` ${line.trim()}`;
    else { flush(); current = line; }
  }
  flush();
  return { headers, body };
}

function latin1Utf8(text: string): string {
  if (!/[\x80-\xff]/.test(text)) return text;
  const decoded = Buffer.from(text, 'latin1').toString('utf8');
  return decoded.includes('�') ? text : decoded;
}

const first = (headers: Map<string, string[]>, name: string): string | undefined => headers.get(name)?.[0];

function decodeBody(entity: Entity): Buffer {
  const encoding = (first(entity.headers, 'content-transfer-encoding') ?? '').trim().toLowerCase();
  if (encoding === 'base64') return decodeBase64(entity.body.toString('latin1'));
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(entity.body.toString('latin1'));
  return entity.body;
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const delimiter = `--${boundary}`;
  const parts: Buffer[] = [];
  let pos = text.startsWith(delimiter) ? 0 : text.indexOf(`\n${delimiter}`);
  if (pos < 0) return parts;
  for (;;) {
    const lineStart = text[pos] === '\n' ? pos + 1 : pos;
    const afterDelimiter = lineStart + delimiter.length;
    if (text.startsWith('--', afterDelimiter)) break; // closing delimiter
    const contentStart = text.indexOf('\n', afterDelimiter);
    if (contentStart < 0) break;
    const next = text.indexOf(`\n${delimiter}`, contentStart);
    const end = next < 0 ? text.length : next;
    const chunk = text.slice(contentStart + 1, end).replace(/\r$/, '');
    parts.push(Buffer.from(chunk, 'latin1'));
    if (next < 0) break; // truncated message: the last part as far as it goes
    pos = next;
  }
  return parts;
}

interface Collected { plain?: string; html?: string; attachments: MailAttachment[] }

function walk(entity: Entity, out: Collected, depth: number): void {
  const type = headerParams(first(entity.headers, 'content-type') ?? 'text/plain');
  const disposition = headerParams(first(entity.headers, 'content-disposition') ?? '');
  const mime = type.value || 'text/plain';
  if (mime.startsWith('multipart/') && type.params.boundary && depth < MAX_DEPTH) {
    for (const part of splitMultipart(entity.body, type.params.boundary)) walk(splitEntity(part), out, depth + 1);
    return;
  }
  const name = disposition.params.filename ?? type.params.name;
  const isText = mime === 'text/plain' || mime === 'text/html';
  if (disposition.value === 'attachment' || (name && !isText) || (!isText && !mime.startsWith('multipart/'))) {
    const size = decodeBody(entity).length;
    out.attachments.push({ name: name ?? (mime === 'message/rfc822' ? 'message.eml' : 'attachment'), type: mime, size });
    return;
  }
  if (!isText) return;
  const text = decodeCharset(decodeBody(entity), type.params.charset ?? 'utf-8');
  if (mime === 'text/plain' && out.plain === undefined) out.plain = text;
  else if (mime === 'text/html' && out.html === undefined) out.html = text;
  else if (mime === 'text/plain') out.plain += `\n\n${text}`;
}

const ids = (value: string | undefined): string[] => value?.match(/<[^<>\s]+>/g) ?? [];

export function parseMessage(raw: Buffer): ParsedMail {
  const root = splitEntity(raw);
  const collected: Collected = { attachments: [] };
  walk(root, collected, 0);
  const h = root.headers;
  const fromHtml = collected.plain === undefined && collected.html !== undefined;
  const text = collected.plain ?? (collected.html !== undefined ? htmlToText(collected.html) : '');
  return {
    headers: h,
    subject: decodeWords(first(h, 'subject') ?? ''),
    from: parseAddressList(first(h, 'from')),
    to: parseAddressList(h.get('to')?.join(', ')),
    cc: parseAddressList(h.get('cc')?.join(', ')),
    replyTo: parseAddressList(first(h, 'reply-to')),
    date: first(h, 'date'),
    messageId: ids(first(h, 'message-id'))[0],
    inReplyTo: ids(first(h, 'in-reply-to'))[0],
    references: ids(first(h, 'references')),
    text: text.replace(/\r\n/g, '\n'),
    fromHtml,
    attachments: collected.attachments,
  };
}

/** A one-line preview of a text (whitespace collapsed, quoted lines dropped), at most `max` characters. */
export function snippet(text: string, max = 200): string {
  const flat = text.split('\n').filter((line) => !line.startsWith('>')).join(' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
