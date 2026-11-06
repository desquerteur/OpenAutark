// B-053 track D: writing one RFC 5322 message – From/To/Cc (display names quoted or RFC 2047 encoded), Subject
// (encoded words when not ASCII), Date, Message-ID, In-Reply-To, References (folded), MIME-Version, a text/plain
// UTF-8 quoted-printable body and an optional text/html alternative; and the reply fields (Re: subject, who to,
// threading ids, the quoted original). Bcc never goes into the headers (SMTP carries it). CRLF line ends throughout.
// B-059: a mail sent in a run a mail started carries "Auto-Submitted: auto-replied" (RFC 3834; loops.ts).
// Owns: these builders (pure apart from the random Message-ID). Never: puts a header value in without stripping CR/LF.

import { randomBytes } from 'node:crypto';
import type { MailAddress } from './mime-text.ts';
import type { ParsedMail } from './mime.ts';

export interface OutgoingMail {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  messageId?: string;
  /** B-059: sent in a run a mail started – "Auto-Submitted: auto-replied" (RFC 3834), so auto-responders stay silent. */
  autoReplied?: boolean;
}

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 B words (UTF-8), each ≤ 75 characters, never splitting a character. */
export function encodeWords(value: string): string {
  const text = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

export function formatMailbox(a: MailAddress): string {
  const address = oneLine(a.address).replace(/[<>,;\s]/g, '');
  const name = a.name ? oneLine(a.name) : '';
  if (!name) return address;
  if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeWords(name)} <${address}>`;
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]*$/.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/["\\]/g, (c) => `\\${c}`)}" <${address}>`;
}

/** Folds a header at spaces so lines stay ≤ 78 characters where possible. */
function fold(name: string, value: string): string {
  const words = value.split(' ');
  const lines: string[] = [];
  let line = `${name}:`;
  for (const word of words) {
    if (line.length + 1 + word.length > 78 && line.length > name.length + 1) { lines.push(line); line = ` ${word}`; }
    else line += ` ${word}`;
  }
  lines.push(line);
  return lines.join('\r\n');
}

/** Quoted-printable (RFC 2045) of UTF-8 text with CRLF line ends and soft breaks at 76. */
export function encodeQuotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let encoded = '';
    let width = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      const piece = plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (width + piece.length > 75) { encoded += '=\r\n'; width = 0; }
      encoded += piece;
      width += piece.length;
    }
    out.push(encoded);
  }
  return out.join('\r\n');
}

export const mailDate = (date: Date): string => date.toUTCString().replace(/GMT$/, '+0000');

export function newMessageId(from: string): string {
  const domain = /@([A-Za-z0-9.-]+)$/.exec(from)?.[1] ?? 'workforce.local';
  return `<${Date.now().toString(36)}.${randomBytes(9).toString('hex')}@${domain}>`;
}

const textPart = (type: string, text: string): string =>
  `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(text)}\r\n`;

/** The message bytes and its Message-ID. */
export function buildMessage(mail: OutgoingMail): { raw: Buffer; messageId: string } {
  const messageId = mail.messageId ?? newMessageId(mail.from.address);
  const headers = [
    `From: ${formatMailbox(mail.from)}`,
    fold('To', mail.to.map(formatMailbox).join(', ')),
    ...(mail.cc?.length ? [fold('Cc', mail.cc.map(formatMailbox).join(', '))] : []),
    fold('Subject', encodeWords(mail.subject)),
    `Date: ${mailDate(mail.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${oneLine(mail.inReplyTo)}`] : []),
    ...(mail.references?.length ? [fold('References', mail.references.map(oneLine).join(' '))] : []),
    ...(mail.autoReplied ? ['Auto-Submitted: auto-replied'] : []),
    'MIME-Version: 1.0',
  ];
  let body: string;
  if (mail.html === undefined) {
    body = textPart('text/plain', mail.text);
  } else {
    const boundary = `=_wf_${randomBytes(12).toString('hex')}`;
    body = `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`
      + `--${boundary}\r\n${textPart('text/plain', mail.text)}--${boundary}\r\n${textPart('text/html', mail.html)}--${boundary}--\r\n`;
  }
  return { raw: Buffer.from(`${headers.join('\r\n')}\r\n${body}`, 'utf8'), messageId };
}

// ------------------------------------------------------------------ replies

export const replySubject = (subject: string): string => /^\s*(re|aw|sv|antw)\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;

/** Who a reply goes to: Reply-To (else From); with `all`, the other To/Cc too – never the own address twice. */
export function replyRecipients(original: ParsedMail, own: string, all: boolean): { to: MailAddress[]; cc: MailAddress[] } {
  const me = own.toLowerCase();
  const seen = new Set<string>([me]);
  const keep = (list: MailAddress[]) => list.filter((a) => { const k = a.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const primary = original.replyTo.length ? original.replyTo : original.from;
  const fromMe = primary.every((a) => a.address.toLowerCase() === me);
  // Replying to one's own sent mail goes to its recipients.
  const to = keep(fromMe ? original.to : primary);
  const cc = all ? keep([...(fromMe ? [] : original.to), ...original.cc]) : [];
  return { to, cc };
}

/** The threading fields of a reply (RFC 5322 3.6.4). */
export function replyThreading(original: ParsedMail): { inReplyTo?: string; references: string[] } {
  if (!original.messageId) return { references: original.references.slice(-20) };
  return { inReplyTo: original.messageId, references: [...original.references.slice(-19), original.messageId] };
}

/** The reply text with the original quoted below ("On <date>, <name> wrote:"), the quote at most 8,000 characters. */
export function quoteOriginal(text: string, original: ParsedMail): string {
  const who = original.from[0]?.name ?? original.from[0]?.address ?? 'someone';
  const quoted = original.text.slice(0, 8_000).split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
  return `${text.trimEnd()}\n\nOn ${original.date ?? 'an earlier date'}, ${who} wrote:\n${quoted}\n`;
}
