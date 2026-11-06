// B-053 track D: what each mail tool does (tools.ts names them) – search, read, folders, draft, send, reply, move,
// mark, create_folder, delete – on the Mailbox (IMAP) and over SMTP, and the results: a short text summary for the
// agent plus structuredContent. Once SMTP accepted a message, nothing after it (the Sent copy, the \Answered flag)
// can fail the call: those become notes, so a sent message is never reported as unsent and sent twice.
// B-059 (loops.ts): search and read say when a message was sent automatically (auto-reply, newsletter, bounce …);
// a call of a run a mail started (AUTO_REPLY_ARG) sends with "Auto-Submitted: auto-replied", so other auto-responders stay silent.
// Owns: the tool behaviour. Never: returns an attachment's bytes, a header value of the login, or a password.

import type { McpCallResult, MailTarget } from '../types.ts';
import { astring, flagsOf, parseEnvelope, searchDate, str, type ImapArg, type ImapValue } from './imap-parse.ts';
import { MailError, messageId, type Folder, type Mailbox, type MessageRef } from './mailbox.ts';
import { buildMessage, quoteOriginal, replyRecipients, replySubject, replyThreading } from './mime-build.ts';
import { decodeWords, formatAddress, parseAddressList, type MailAddress } from './mime-text.ts';
import { parseMessage, snippet, type ParsedMail } from './mime.ts';
import { sendMail, SmtpError } from './smtp.ts';
import type { MailSockets } from './socket.ts';
import { AUTO_REPLY_ARG, automaticMail } from './loops.ts';

export interface MailContext { mailbox: Mailbox; target: MailTarget; sockets?: MailSockets; timeoutMs?: number }
type Args = Record<string, unknown>;

const READ_LIMIT = 50 * 1024;
const FETCH_LIMIT = 2 * 1024 * 1024;
const SUMMARY_ITEMS = 'FLAGS ENVELOPE INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.8192>';

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

const ok = (text: string, structuredContent: unknown): McpCallResult => ({ content: [{ type: 'text', text }], structuredContent });

function text(args: Args, key: string, required = false, max = 1_000_000): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') { if (required) throw new MailError(`${key} is missing.`); return undefined; }
  if (typeof value !== 'string') throw new MailError(`${key} must be text.`);
  if (value.length > max) throw new MailError(`${key} is too long.`);
  return value;
}

function addressArg(args: Args, key: string, required = false): MailAddress[] {
  const value = args[key];
  const items = value === undefined || value === null || value === '' ? [] : Array.isArray(value) ? value : [value];
  if (items.some((v) => typeof v !== 'string')) throw new MailError(`${key} must be addresses.`);
  const list: MailAddress[] = [];
  for (const item of items as string[]) {
    const parsed = parseAddressList(item);
    if ((item.trim() && !parsed.length) || parsed.some((a) => !EMAIL.test(a.address))) throw new MailError(`${key} has something that is not an email address.`);
    list.push(...parsed);
  }
  if (required && !list.length) throw new MailError(`${key} needs at least one address.`);
  if (list.length > 100) throw new MailError(`${key} has more than 100 addresses.`);
  return list;
}

const isoDate = (...values: Array<string | undefined>): string | undefined => {
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$1 $2 $3'));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
};

const names = (list: Array<{ name?: string; address: string }>): string => list.map((a) => formatAddress({ address: a.address, ...(a.name ? { name: decodeWords(a.name) } : {}) })).join(', ');

export interface Summary { id: string; date?: string; from: string; to: string; subject: string; snippet: string; unread: boolean; flagged: boolean; size?: number; automatic?: string }

function summaryOf(folder: string, validity: number, uid: number, row: Map<string, ImapValue>): Summary {
  const env = parseEnvelope(row.get('ENVELOPE'));
  const flags = flagsOf(row.get('FLAGS')).map((f) => f.toUpperCase());
  const body = row.get('BODY[]');
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(str(body) ?? '', 'utf8');
  const parsed = raw.length ? parseMessage(raw) : undefined;
  const automatic = automaticMail(parsed?.headers ?? new Map(), env.from[0]?.address); // B-059 (headers past 8 KB: best effort)
  return {
    id: messageId(folder, validity, uid), date: isoDate(env.date, str(row.get('INTERNALDATE'))),
    from: names(env.from), to: names(env.to), subject: decodeWords(env.subject ?? ''),
    snippet: parsed ? snippet(parsed.text) : '', unread: !flags.includes('\\SEEN'), flagged: flags.includes('\\FLAGGED'),
    size: Number(str(row.get('RFC822.SIZE'))) || undefined, ...(automatic ? { automatic } : {}),
  };
}

const line = (s: Summary, i: number): string =>
  `${i + 1}. ${s.date?.slice(0, 16).replace('T', ' ') ?? '?'} · ${s.from || '?'} → ${s.to || '?'} · "${s.subject}"${s.unread ? ' · unread' : ''}${s.flagged ? ' · flagged' : ''}${s.automatic ? ` · automatic (${s.automatic})` : ''}\n   id: ${s.id}${s.snippet ? `\n   ${s.snippet}` : ''}`;

async function search(ctx: MailContext, args: Args): Promise<McpCallResult> {
  const mb = ctx.mailbox;
  const folder = await mb.folder(text(args, 'folder') ?? 'INBOX');
  const validity = await mb.select(folder);
  const c: ImapArg[] = [];
  const query = text(args, 'query', false, 500);
  if (query) c.push(...(mb.caps.has('X-GM-EXT-1') ? ['X-GM-RAW', astring(query)] : ['TEXT', astring(query)]));
  for (const key of ['from', 'to', 'subject'] as const) { const v = text(args, key, false, 300); if (v) c.push(key.toUpperCase(), astring(v)); }
  if (args.unread === true) c.push('UNSEEN'); else if (args.unread === false) c.push('SEEN');
  if (args.flagged === true) c.push('FLAGGED'); else if (args.flagged === false) c.push('UNFLAGGED');
  for (const key of ['since', 'before'] as const) {
    const v = text(args, key, false, 40);
    if (!v) continue;
    const d = searchDate(v);
    if (!d) throw new MailError(`${key} must be a date like 2026-10-29.`);
    c.push(key.toUpperCase(), d);
  }
  const limit = Math.min(50, Math.max(1, Number.isInteger(args.limit) ? Number(args.limit) : 20));
  const uids = (await mb.searchUids(c)).sort((a, b) => b - a);
  const newest = uids.slice(0, limit);
  const rows = await mb.fetch(newest, SUMMARY_ITEMS);
  const messages = newest.filter((uid) => rows.has(uid)).map((uid) => summaryOf(folder.name, validity, uid, rows.get(uid)!));
  const head = uids.length ? `${uids.length} message${uids.length === 1 ? '' : 's'} in ${folder.name}${uids.length > messages.length ? `, the newest ${messages.length}` : ''}:` : `No messages in ${folder.name} match.`;
  return ok([head, ...messages.map(line)].join('\n'), { folder: folder.name, total: uids.length, messages });
}

async function fetchFull(ctx: MailContext, ref: MessageRef): Promise<{ parsed: ParsedMail; flags: string[]; truncated: boolean }> {
  const rows = await ctx.mailbox.fetch([ref.uid], `FLAGS RFC822.SIZE BODY.PEEK[]<0.${FETCH_LIMIT}>`);
  const row = rows.get(ref.uid);
  if (!row) throw new MailError('That message is gone (moved or deleted) – search again.');
  const body = row.get('BODY[]');
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(str(body) ?? '', 'utf8');
  const size = Number(str(row.get('RFC822.SIZE'))) || raw.length;
  return { parsed: parseMessage(raw), flags: flagsOf(row.get('FLAGS')).map((f) => f.toUpperCase()), truncated: size > raw.length };
}

function clipBytes(value: string, max: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= max) return { text: value, clipped: false };
  return { text: Buffer.from(value, 'utf8').subarray(0, max).toString('utf8').replace(/�$/, ''), clipped: true };
}

async function read(ctx: MailContext, args: Args): Promise<McpCallResult> {
  const ref = await ctx.mailbox.locate(args.id);
  const { parsed, flags, truncated } = await fetchFull(ctx, ref);
  const body = clipBytes(parsed.text, READ_LIMIT);
  const date = isoDate(parsed.date);
  const attachments = parsed.attachments;
  const automatic = automaticMail(parsed.headers, parsed.from[0]?.address);
  const parts = [
    `From: ${names(parsed.from)}`, `To: ${names(parsed.to)}`, ...(parsed.cc.length ? [`Cc: ${names(parsed.cc)}`] : []),
    `Date: ${date ?? parsed.date ?? '?'}`, `Subject: ${parsed.subject}`,
    ...(automatic ? [`Sent automatically (${automatic}) – it needs no reply.`] : []), '',
    body.text + (body.clipped || truncated ? '\n[… the message is longer; this is the first part]' : ''),
    ...(attachments.length ? ['', `Attachments (${attachments.length}${truncated ? ', maybe more' : ''}): ${attachments.map((a) => `${a.name} (${a.type}, ${a.size} bytes)`).join('; ')}`] : []),
  ];
  return ok(parts.join('\n'), {
    id: messageId(ref.folder.name, ref.uidValidity, ref.uid), from: names(parsed.from), to: names(parsed.to), cc: names(parsed.cc),
    date, subject: parsed.subject, unread: !flags.includes('\\SEEN'), flagged: flags.includes('\\FLAGGED'),
    text: body.text, truncated: body.clipped || truncated, fromHtml: parsed.fromHtml, attachments, ...(automatic ? { automatic } : {}),
  });
}

async function folders(ctx: MailContext): Promise<McpCallResult> {
  const list = await ctx.mailbox.folders(true);
  const rows = list.map((f) => ({ name: f.name, role: f.use, selectable: f.selectable }));
  return ok(rows.map((f) => `${f.name}${f.role ? ` (${f.role})` : ''}${f.selectable ? '' : ' – container only'}`).join('\n') || 'No folders.', { folders: rows });
}

async function ensure(ctx: MailContext, use: 'drafts' | 'sent' | 'trash', fallback: string): Promise<Folder> {
  return (await ctx.mailbox.special(use)) ?? ctx.mailbox.create(fallback);
}

const storesSent = (target: MailTarget): boolean => /(^|\.)(gmail|googlemail)\.com$/i.test(target.smtp.host);

async function original(ctx: MailContext, id: unknown): Promise<{ ref: MessageRef; parsed: ParsedMail }> {
  const ref = await ctx.mailbox.locate(id);
  return { ref, parsed: (await fetchFull(ctx, ref)).parsed };
}

async function deliver(ctx: MailContext, raw: Buffer, recipients: MailAddress[], after: () => Promise<void>): Promise<string[]> {
  const notes: string[] = [];
  let result: { accepted: string[]; rejected: string[] };
  try {
    result = await sendMail({ server: ctx.target.smtp, login: await ctx.target.login(), from: ctx.target.address, to: recipients.map((a) => a.address), raw, sockets: ctx.sockets, timeoutMs: ctx.timeoutMs });
  } catch (error) {
    if (error instanceof SmtpError) throw new MailError(`Not sent: ${error.message}`);
    throw error;
  }
  if (result.rejected.length) notes.push(`Not delivered to: ${result.rejected.join(', ')}.`);
  try { await after(); } catch { notes.push('The reply mark on the original could not be set.'); }
  if (!storesSent(ctx.target)) {
    try { await ctx.mailbox.append(await ensure(ctx, 'sent', 'Sent'), raw, ['\\Seen']); } catch { notes.push('Sent, but the copy in the Sent folder could not be saved.'); }
  }
  return notes;
}

async function compose(ctx: MailContext, args: Args, mode: 'draft' | 'send' | 'reply'): Promise<McpCallResult> {
  const own = { address: ctx.target.address };
  let to: MailAddress[];
  let cc: MailAddress[];
  let bcc: MailAddress[] = [];
  let subject: string;
  let body = text(args, 'text', true, 500_000)!;
  let thread: { inReplyTo?: string; references: string[] } = { references: [] };
  let answered: MessageRef | undefined;
  if (mode === 'reply') {
    const orig = await original(ctx, args.id);
    ({ to, cc } = replyRecipients(orig.parsed, own.address, args.all === true));
    if (!to.length) throw new MailError('The message has no address to reply to.');
    subject = replySubject(orig.parsed.subject);
    body = quoteOriginal(body, orig.parsed);
    thread = replyThreading(orig.parsed);
    answered = orig.ref;
  } else {
    to = addressArg(args, 'to', true);
    cc = addressArg(args, 'cc');
    if (mode === 'send') bcc = addressArg(args, 'bcc');
    subject = text(args, 'subject', false, 1_000) ?? '';
    if (args.replyTo !== undefined) {
      const orig = await original(ctx, args.replyTo);
      thread = replyThreading(orig.parsed);
      answered = orig.ref;
    }
  }
  const autoReplied = mode !== 'draft' && args[AUTO_REPLY_ARG] === true; // B-059: a run a mail started
  const { raw, messageId: mid } = buildMessage({ from: own, to, cc, subject, text: body, ...thread, ...(autoReplied ? { autoReplied } : {}) });
  const summary = { to: names(to), cc: names(cc), bcc: names(bcc), subject, messageId: mid };
  if (mode === 'draft') {
    const id = await ctx.mailbox.append(await ensure(ctx, 'drafts', 'Drafts'), raw, ['\\Draft', '\\Seen']);
    return ok(`Draft saved in Drafts: "${subject}" to ${summary.to}.${id ? ` id: ${id}` : ''}`, { ...summary, id, saved: true });
  }
  const notes = await deliver(ctx, raw, [...to, ...cc, ...bcc], async () => {
    if (mode === 'send' || !answered) return;
    await ctx.mailbox.locate(messageId(answered.folder.name, answered.uidValidity, answered.uid));
    await ctx.mailbox.store(answered, '+', ['\\Answered', '\\Seen']); // handled: the next unread search leaves it out
  });
  return ok([`Sent "${subject}" to ${summary.to}${cc.length ? `, cc ${summary.cc}` : ''}${bcc.length ? `, bcc ${summary.bcc}` : ''}.`, ...notes].join(' '), { ...summary, sent: true, notes });
}

async function move(ctx: MailContext, args: Args): Promise<McpCallResult> {
  const ref = await ctx.mailbox.locate(args.id);
  const to = await ctx.mailbox.folder(text(args, 'folder', true, 200)!);
  if (!to.selectable) throw new MailError(`${to.name} cannot hold messages.`);
  const id = await ctx.mailbox.move(ref, to);
  return ok(`Moved to ${to.name}.${id ? ` New id: ${id}` : ''}`, { folder: to.name, id });
}

async function mark(ctx: MailContext, args: Args): Promise<McpCallResult> {
  if (typeof args.read !== 'boolean' && typeof args.flagged !== 'boolean') throw new MailError('Say read and/or flagged (true or false).');
  const ref = await ctx.mailbox.locate(args.id);
  const done: string[] = [];
  if (typeof args.read === 'boolean') { await ctx.mailbox.store(ref, args.read ? '+' : '-', ['\\Seen']); done.push(args.read ? 'read' : 'unread'); }
  if (typeof args.flagged === 'boolean') { await ctx.mailbox.store(ref, args.flagged ? '+' : '-', ['\\Flagged']); done.push(args.flagged ? 'flagged' : 'not flagged'); }
  return ok(`Marked ${done.join(' and ')}.`, { read: args.read, flagged: args.flagged });
}

async function createFolder(ctx: MailContext, args: Args): Promise<McpCallResult> {
  const folder = await ctx.mailbox.create(text(args, 'name', true, 200)!);
  return ok(`Created the folder ${folder.name}.`, { folder: folder.name });
}

async function remove(ctx: MailContext, args: Args): Promise<McpCallResult> {
  const ref = await ctx.mailbox.locate(args.id);
  const trash = await ensure(ctx, 'trash', 'Trash');
  if (trash.wire !== ref.folder.wire) {
    await ctx.mailbox.locate(args.id);
    const id = await ctx.mailbox.move(ref, trash);
    return ok(`Moved to ${trash.name}.${id ? ` id: ${id}` : ''}`, { folder: trash.name, id, permanent: false });
  }
  const gone = await ctx.mailbox.expunge(ref);
  return ok(gone ? 'Deleted for good (it was in Trash).' : 'Marked as deleted; the server removes it when the folder is cleaned up.', { permanent: true, expunged: gone });
}

export async function runMailTool(ctx: MailContext, name: string, args: Args): Promise<McpCallResult> {
  try {
    switch (name) {
      case 'search': return await search(ctx, args);
      case 'read': return await read(ctx, args);
      case 'folders': return await folders(ctx);
      case 'draft': case 'send': case 'reply': return await compose(ctx, args, name);
      case 'move': return await move(ctx, args);
      case 'mark': return await mark(ctx, args);
      case 'create_folder': return await createFolder(ctx, args);
      case 'delete': return await remove(ctx, args);
      default: return { content: [{ type: 'text', text: `There is no mail tool "${name.slice(0, 40)}".` }], isError: true };
    }
  } catch (error) {
    if (error instanceof MailError) return { content: [{ type: 'text', text: error.message }], isError: true };
    throw error;
  }
}
