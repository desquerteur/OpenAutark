// B-053 track D test fixture: an in-process IMAP server on 127.0.0.1:0 (node:net, plain TCP – the tests pass a TLS
// seam that returns plain sockets). Enough of RFC 3501 for the client: greeting with or without capabilities,
// STARTTLS (a no-op upgrade), LOGIN, AUTHENTICATE PLAIN (SASL-IR or continuation), LIST with special-use
// attributes, SELECT/EXAMINE, UID SEARCH (ALL FROM TO SUBJECT TEXT X-GM-RAW SEEN UNSEEN FLAGGED UNFLAGGED SINCE
// BEFORE CHARSET), UID FETCH (ENVELOPE with the subject as a literal, FLAGS, INTERNALDATE, RFC822.SIZE, BODY[]
// partial), FETCH by sequence, UID STORE, UID MOVE / COPY / EXPUNGE, APPEND (synchronizing or LITERAL+), CREATE,
// IDLE/DONE, NOOP, LOGOUT. `deliver()` adds mail and pushes EXISTS.
// B-059: message sets with ranges ("3:5", "7:*" – "*" is the highest, so "9:*" past the end names the newest),
// SEARCH UID <set>, and BODY.PEEK[HEADER.FIELDS (…)] (only those header lines, then the blank line; NO with
// refuseHeaderFetch).
// Owns: that fake. Never: listens on anything but 127.0.0.1.

import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FakeMessage { uid: number; flags: Set<string>; raw: Buffer; date: Date }
export interface FakeFolder { name: string; attrs: string[]; uidValidity: number; uidNext: number; messages: FakeMessage[] }
export interface FakeImapOptions {
  user?: string; password?: string;
  /** Capabilities (default: IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN MOVE UIDPLUS IDLE SPECIAL-USE). */
  caps?: string[];
  /** Capabilities only after CAPABILITY (not in the greeting). */
  quietGreeting?: boolean;
}

const DEFAULT_CAPS = ['IMAP4rev1', 'LITERAL+', 'SASL-IR', 'AUTH=PLAIN', 'MOVE', 'UIDPLUS', 'IDLE', 'SPECIAL-USE'];

const header = (raw: Buffer, name: string): string | undefined => {
  const head = raw.toString('utf8').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  return new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head)?.[1];
};
const q = (value: string | undefined) => value === undefined ? 'NIL' : `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
function addr(value: string | undefined): string {
  if (!value) return 'NIL';
  const list = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^@>]+)@([^>]+)>\s*$/.exec(part) ?? /^\s*()([^@\s]+)@(\S+)\s*$/.exec(part);
    return m ? `(${m[1] ? q(m[1]) : 'NIL'} NIL ${q(m[2])} ${q(m[3])})` : '';
  }).filter(Boolean);
  return list.length ? `(${list.join('')})` : 'NIL';
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const searchDay = (value: string): Date => {
  const m = /^(\d{1,2})-([a-z]{3})-(\d{4})$/i.exec(value);
  if (!m) return new Date(Number.NaN);
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
};
/** A message set ("1,3:5,7:*") contains `n`; "*" is `max` (RFC 3501: a range is taken in either order). */
function inSet(n: number, set: string, max: number): boolean {
  return set.split(',').some((part) => {
    const [a, b = a] = part.split(':').map((x) => (x === '*' ? max : Number(x)));
    return n >= Math.min(a, b) && n <= Math.max(a, b);
  });
}
const internal = (d: Date) => `"${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000"`;

/** Command tokens: atoms, quoted strings, literals (already read), parenthesised lists as raw text. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ') { i++; continue; }
    if (text[i] === '"') { let s = ''; i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; s += text[i++]; } i++; out.push(s); continue; }
    if (text[i] === '(') { let depth = 0; const start = i; do { if (text[i] === '(') depth++; if (text[i] === ')') depth--; i++; } while (depth && i < text.length); out.push(text.slice(start, i)); continue; }
    if (text[i] === '\u0001') { const end = text.indexOf('\u0002', i); out.push(text.slice(i + 1, end)); i = end + 1; continue; }
    const start = i;
    let depth = 0;
    while (i < text.length && (depth || text[i] !== ' ')) { if (text[i] === '[') depth++; if (text[i] === ']') depth--; i++; }
    out.push(text.slice(start, i));
  }
  return out;
}

export class FakeImap {
  readonly folders = new Map<string, FakeFolder>();
  readonly log: string[] = [];
  readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly idlers = new Map<Socket, { tag: string; folder: string }>();
  private readonly selected = new Map<Socket, string>();
  port = 0;
  caps: string[];
  /** APPEND answers NO (a full mailbox). */
  refuseAppend = false;
  /** B-059: a FETCH of BODY.PEEK[HEADER.FIELDS …] answers NO (the connection stays open). */
  refuseHeaderFetch = false;

  readonly opts: FakeImapOptions;

  constructor(opts: FakeImapOptions = {}) {
    this.opts = opts;
    this.caps = opts.caps ?? DEFAULT_CAPS;
    for (const [name, attrs] of [['INBOX', []], ['Drafts', ['\\Drafts']], ['Sent Items', ['\\Sent']], ['Papierkorb', []], ['Spam', ['\\Junk']], ['Archiv', ['\\Archive']], ['Projekte', ['\\Noselect']], ['Entw&APw-rfe', []]] as Array<[string, string[]]>) {
      this.folders.set(name, { name, attrs, uidValidity: 7000 + this.folders.size, uidNext: 1, messages: [] });
    }
    this.server = createServer((socket) => this.serve(socket));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  add(folder: string, raw: Buffer | string, flags: string[] = [], date = new Date('2026-10-27T08:15:00Z')): FakeMessage {
    const f = this.folders.get(folder)!;
    const message = { uid: f.uidNext++, flags: new Set(flags), raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, '\r\n')), date };
    f.messages.push(message);
    return message;
  }

  /** New mail: added to the folder; every connection that has it selected hears EXISTS. */
  deliver(folder: string, raw: Buffer | string): void {
    this.add(folder, raw);
    const count = this.folders.get(folder)!.messages.length;
    for (const [socket, name] of this.selected) if (name === folder) socket.write(`* ${count} EXISTS\r\n`);
  }

  idling(): number { return this.idlers.size; }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => { this.sockets.delete(socket); this.idlers.delete(socket); this.selected.delete(socket); });
    socket.on('error', () => undefined);
    socket.write(this.opts.quietGreeting ? '* OK fake ready\r\n' : `* OK [CAPABILITY ${this.caps.join(' ')}] fake ready\r\n`);
    let buf = Buffer.alloc(0);
    let line = '';
    let need = 0;
    let pendingAuth: string | undefined;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need > 0) {
          if (buf.length < need) return;
          line += `\u0001${buf.subarray(0, need).toString('utf8')}\u0002`;
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const at = buf.indexOf('\r\n');
        if (at < 0) return;
        const part = buf.subarray(0, at).toString('utf8');
        buf = buf.subarray(at + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(part);
        if (lit) {
          line += part.slice(0, lit.index);
          need = Number(lit[1]);
          if (!lit[2]) socket.write('+ go ahead\r\n');
          continue;
        }
        const full = line + part;
        line = '';
        if (pendingAuth) { const tag = pendingAuth; pendingAuth = undefined; this.finishAuth(socket, tag, full); continue; }
        if (this.idlers.has(socket)) { if (full === 'DONE') { const { tag } = this.idlers.get(socket)!; this.idlers.delete(socket); socket.write(`${tag} OK IDLE done\r\n`); } continue; }
        const r = this.command(socket, full);
        if (r === 'auth') pendingAuth = full.split(' ')[0];
      }
    });
  }

  private finishAuth(socket: Socket, tag: string, b64: string): void {
    const [, user, password] = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
    socket.write(this.checkLogin(user, password) ? `${tag} OK [CAPABILITY ${this.caps.join(' ')}] logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
  }

  private checkLogin(user: string, password: string): boolean {
    return user === (this.opts.user ?? 'me@example.com') && password === (this.opts.password ?? 'app-pass');
  }

  private command(socket: Socket, full: string): 'auth' | undefined {
    const t = tokens(full);
    const tag = t[0];
    let cmd = (t[1] ?? '').toUpperCase();
    let args = t.slice(2);
    let uid = false;
    if (cmd === 'UID') { uid = true; cmd = `${(args[0] ?? '').toUpperCase()}`; args = args.slice(1); }
    this.log.push(cmd === 'LOGIN' || cmd === 'AUTHENTICATE' ? `${uid ? 'UID ' : ''}${cmd} <hidden>` : `${uid ? 'UID ' : ''}${cmd} ${args.join(' ')}`.trim());
    const okLine = (text = 'done') => socket.write(`${tag} OK ${text}\r\n`);
    const folderName = () => this.selected.get(socket) ?? '';
    const folder = () => this.folders.get(folderName());
    switch (cmd) {
      case 'CAPABILITY': socket.write(`* CAPABILITY ${this.caps.join(' ')}\r\n`); okLine(); return;
      case 'STARTTLS': okLine('begin TLS'); return;
      case 'NOOP': okLine(); return;
      case 'LOGOUT': socket.write('* BYE bye\r\n'); okLine(); socket.end(); return;
      case 'LOGIN': socket.write(this.checkLogin(args[0], args[1]) ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); return;
      case 'AUTHENTICATE':
        if (args[1]) { this.finishAuth(socket, tag, args[1]); return; }
        socket.write('+ \r\n');
        return 'auth';
      case 'LIST':
        for (const f of this.folders.values()) socket.write(`* LIST (${['\\HasNoChildren', ...f.attrs].join(' ')}) "/" ${q(f.name)}\r\n`);
        okLine(); return;
      case 'SELECT': case 'EXAMINE': {
        const f = this.folders.get(args[0]);
        if (!f) { socket.write(`${tag} NO no such folder\r\n`); return; }
        this.selected.set(socket, f.name);
        socket.write(`* ${f.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${f.uidValidity}] ok\r\n* OK [UIDNEXT ${f.uidNext}] ok\r\n`);
        okLine(`[READ-${cmd === 'SELECT' ? 'WRITE' : 'ONLY'}] selected`); return;
      }
      case 'SEARCH': {
        const top = Math.max(0, ...folder()!.messages.map((m) => m.uid));
        const found = folder()!.messages.filter((m) => this.matches(m, args, top)).map((m) => m.uid);
        socket.write(`* SEARCH${found.map((n) => ` ${n}`).join('')}\r\n`); okLine(); return;
      }
      case 'FETCH': {
        if (this.refuseHeaderFetch && /HEADER\.FIELDS/i.test(args.join(' '))) { socket.write(`${tag} NO fetch failed\r\n`); return; }
        const f = folder()!;
        const max = uid ? Math.max(0, ...f.messages.map((m) => m.uid)) : f.messages.length;
        f.messages.forEach((m, i) => {
          if (!inSet(uid ? m.uid : i + 1, args[0], max)) return;
          const pieces = [`* ${i + 1} FETCH (`, ...this.fetchItems(m, args.slice(1).join(' ')), ')\r\n'];
          socket.write(Buffer.concat(pieces.map((p) => typeof p === 'string' ? Buffer.from(p, 'utf8') : p)));
        });
        okLine(); return;
      }
      case 'STORE': {
        const m = folder()!.messages.find((x) => x.uid === Number(args[0]));
        const flags = args[2].replace(/[()]/g, '').split(' ').filter(Boolean);
        if (m) for (const flag of flags) if (args[1].startsWith('+')) m.flags.add(flag); else m.flags.delete(flag);
        okLine(); return;
      }
      case 'MOVE': case 'COPY': {
        if (cmd === 'MOVE' && !this.caps.includes('MOVE')) { socket.write(`${tag} BAD unknown command\r\n`); return; }
        const from = folder()!;
        const to = this.folders.get(args[1]);
        const m = from.messages.find((x) => x.uid === Number(args[0]));
        if (!to || !m) { socket.write(`${tag} NO [TRYCREATE] no such folder\r\n`); return; }
        const copy = this.add(to.name, m.raw, [...m.flags]);
        const code = `[COPYUID ${to.uidValidity} ${m.uid} ${copy.uid}]`;
        if (cmd === 'MOVE') { from.messages.splice(from.messages.indexOf(m), 1); socket.write(`* OK ${code} moved\r\n`); okLine(); }
        else okLine(`${code} copied`);
        return;
      }
      case 'EXPUNGE': {
        const f = folder()!;
        f.messages = f.messages.filter((m) => !(m.flags.has('\\Deleted') && (!uid || m.uid === Number(args[0]))));
        okLine(); return;
      }
      case 'APPEND': {
        if (this.refuseAppend) { socket.write(`${tag} NO [OVERQUOTA] quota exceeded\r\n`); return; }
        const f = this.folders.get(args[0]);
        if (!f) { socket.write(`${tag} NO [TRYCREATE] no such folder\r\n`); return; }
        const m = this.add(f.name, Buffer.from(args[args.length - 1], 'utf8'), args[1].replace(/[()]/g, '').split(' ').filter(Boolean));
        okLine(`[APPENDUID ${f.uidValidity} ${m.uid}] appended`); return;
      }
      case 'CREATE':
        this.folders.set(args[0], { name: args[0], attrs: [], uidValidity: 9000 + this.folders.size, uidNext: 1, messages: [] });
        okLine(); return;
      case 'IDLE': this.idlers.set(socket, { tag, folder: folderName() }); socket.write('+ idling\r\n'); return;
      default: socket.write(`${tag} BAD unknown command\r\n`);
    }
    return undefined;
  }

  private matches(m: FakeMessage, args: string[], top: number): boolean {
    const text = m.raw.toString('utf8').toLowerCase();
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toUpperCase();
      const next = () => (args[++i] ?? '').toLowerCase();
      if (a === 'ALL') continue;
      if (a === 'UID') { if (!inSet(m.uid, next(), top)) return false; continue; }
      if (a === 'CHARSET') { i++; continue; }
      if (a === 'UNSEEN' && m.flags.has('\\Seen')) return false;
      if (a === 'SEEN' && !m.flags.has('\\Seen')) return false;
      if (a === 'FLAGGED' && !m.flags.has('\\Flagged')) return false;
      if (a === 'UNFLAGGED' && m.flags.has('\\Flagged')) return false;
      if (['FROM', 'TO', 'SUBJECT'].includes(a)) { const v = next(); if (!(header(m.raw, a.toLowerCase()) ?? '').toLowerCase().includes(v)) return false; }
      if (a === 'TEXT' || a === 'X-GM-RAW') { if (!text.includes(next())) return false; }
      if (a === 'SINCE') { if (m.date < searchDay(next())) return false; }
      if (a === 'BEFORE') { if (m.date >= searchDay(next())) return false; }
    }
    return true;
  }

  private fetchItems(m: FakeMessage, items: string): Array<string | Buffer> {
    const out: string[] = [`UID ${m.uid}`];
    if (/FLAGS/.test(items)) out.push(`FLAGS (${[...m.flags].join(' ')})`);
    if (/INTERNALDATE/.test(items)) out.push(`INTERNALDATE ${internal(m.date)}`);
    if (/RFC822\.SIZE/.test(items)) out.push(`RFC822.SIZE ${m.raw.length}`);
    if (/ENVELOPE/.test(items)) {
      const subject = header(m.raw, 'subject') ?? '';
      const env = [q(header(m.raw, 'date')), `{${Buffer.byteLength(subject)}}\r\n${subject}`, addr(header(m.raw, 'from')), addr(header(m.raw, 'from')), addr(header(m.raw, 'reply-to') ?? header(m.raw, 'from')),
        addr(header(m.raw, 'to')), addr(header(m.raw, 'cc')), 'NIL', q(header(m.raw, 'in-reply-to')), q(header(m.raw, 'message-id'))];
      out.push(`ENVELOPE (${env.join(' ')})`);
    }
    const fields = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
    if (fields) {
      const names = fields[1].split(' ').filter(Boolean);
      const head = m.raw.toString('utf8').split(/\r?\n\r?\n/)[0].replace(/\r?\n(?=[ \t])/g, '\u0000').split(/\r?\n/);
      const kept = head.filter((l) => names.some((n) => l.toLowerCase().startsWith(`${n.toLowerCase()}:`))).map((l) => l.replace(/\u0000/g, '\r\n'));
      const block = Buffer.from(`${kept.map((l) => `${l}\r\n`).join('')}\r\n`, 'utf8');
      return [out.join(' '), ` BODY[HEADER.FIELDS (${names.join(' ')})] {${block.length}}\r\n`, block];
    }
    const body = /BODY\.PEEK\[\](?:<0\.(\d+)>)?/.exec(items);
    if (body) {
      const part = body[1] ? m.raw.subarray(0, Number(body[1])) : m.raw;
      return [out.join(' '), ` BODY[]${body[1] ? '<0>' : ''} {${part.length}}\r\n`, part];
    }
    return [out.join(' ')];
  }
}
