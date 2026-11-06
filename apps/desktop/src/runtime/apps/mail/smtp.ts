// B-053 track D: sending one message over SMTP submission (RFC 6409) – implicit TLS (465) or STARTTLS (587), EHLO,
// AUTH PLAIN or LOGIN, MAIL FROM / RCPT TO (each recipient judged), DATA with dot-stuffing, QUIT. Multi-line replies.
// A reply code becomes a user-safe sentence (the server's own text is never passed on); a refused login throws
// ReconnectNeeded; a failure after the message bytes went out is McpTransportError(sent: true) – it may have gone.
// Owns: one submission dialogue per call. Never: logs a command (AUTH carries the password) or the message.

import type * as net from 'node:net';
import type { MailServer } from '../../../shared/model/apps.ts';
import { McpTransportError, ReconnectNeeded } from '../types.ts';
import { LOGIN_REFUSED } from './imap.ts';
import { ByteReader, openSocket, socketError, upgradeSocket, writeAll, type MailSockets } from './socket.ts';

export const SMTP_TIMEOUT_MS = 60_000;

export interface SmtpReply { code: number; lines: string[] }

/** A refusal by the SMTP server (message user-safe, code kept). */
export class SmtpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.name = 'SmtpError'; this.code = code; }
}

export function smtpMessage(code: number, stage: 'connect' | 'auth' | 'from' | 'rcpt' | 'data' | 'other', who = ''): string {
  if (code === 421) return 'The mail server is not available right now – try again later.';
  if (code >= 450 && code < 460) return 'The mail server could not take the message right now – try again later.';
  if (code === 552 || code === 523) return 'The message is too large for the mail server.';
  if (stage === 'rcpt') return `The mail server refused the recipient ${who} (SMTP ${code}).`;
  if (stage === 'from') return `The mail server refused the sender address (SMTP ${code}) – it must be the mailbox's own address.`;
  if (stage === 'data') return `The mail server refused the message (SMTP ${code}) – it may look like spam or break a rule of the server.`;
  return `The mail server refused the request (SMTP ${code}).`;
}

/** Dot-stuffing (RFC 5321 4.5.2) with CRLF line ends and the final ".". */
export function dotStuff(raw: Buffer): Buffer {
  let text = raw.toString('latin1').replace(/\r?\n/g, '\r\n');
  if (!text.endsWith('\r\n')) text += '\r\n';
  text = text.replace(/^\./, '..').replace(/\r\n\./g, '\r\n..');
  return Buffer.from(`${text}.\r\n`, 'latin1');
}

class SmtpSession {
  reader: ByteReader;
  socket: net.Socket;
  private readonly server: MailServer;
  private readonly timeoutMs: number;
  constructor(socket: net.Socket, server: MailServer, timeoutMs: number) {
    this.socket = socket;
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.reader = new ByteReader(socket);
  }

  async reply(): Promise<SmtpReply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new McpTransportError(`${this.server.host} did not answer in time.`, false)), this.timeoutMs); });
    try { return await Promise.race([this.readReply(), timeout]); } finally { clearTimeout(timer); }
  }

  private async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.reader.line();
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) throw new McpTransportError(`${this.server.host} did not answer like a mail server.`, false);
      lines.push(m[3]);
      if (m[2] !== '-') return { code: Number(m[1]), lines };
      if (lines.length > 500) throw new McpTransportError(`${this.server.host} did not answer like a mail server.`, false);
    }
  }

  async send(line: string): Promise<SmtpReply> {
    await writeAll(this.socket, `${line}\r\n`);
    return this.reply();
  }
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const addr = (address: string) => `<${address.replace(/[<>\s\r\n]/g, '')}>`;

function ehloName(socket: net.Socket): string {
  const ip = socket.localAddress?.replace(/^::ffff:/, '');
  if (!ip) return '[127.0.0.1]';
  return ip.includes(':') ? `[IPv6:${ip}]` : `[${ip}]`;
}

/** Sends `raw` to `to` (all recipients, Bcc included). Rejects with SmtpError, ReconnectNeeded or McpTransportError. */
export async function sendMail(input: {
  server: MailServer;
  login: { user: string; password: string };
  from: string;
  to: string[];
  raw: Buffer;
  sockets?: MailSockets;
  timeoutMs?: number;
}): Promise<{ accepted: string[]; rejected: string[] }> {
  const { server } = input;
  const timeoutMs = input.timeoutMs ?? SMTP_TIMEOUT_MS;
  const socket = await openSocket(server, input.sockets);
  const s = new SmtpSession(socket, server, timeoutMs);
  let dataSent = false;
  try {
    const greeting = await s.reply();
    if (greeting.code !== 220) throw new SmtpError(greeting.code, smtpMessage(greeting.code, 'connect'));
    let ehlo = await s.send(`EHLO ${ehloName(socket)}`);
    if (ehlo.code !== 250) throw new SmtpError(ehlo.code, smtpMessage(ehlo.code, 'connect'));
    if (server.tls === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new McpTransportError(`${server.host} does not offer an encrypted connection (STARTTLS).`, false);
      const ok = await s.send('STARTTLS');
      if (ok.code !== 220) throw new McpTransportError(`${server.host} does not offer an encrypted connection (STARTTLS).`, false);
      s.reader.detach();
      s.socket = await upgradeSocket(socket, server, input.sockets);
      s.reader = new ByteReader(s.socket);
      ehlo = await s.send(`EHLO ${ehloName(socket)}`);
      if (ehlo.code !== 250) throw new SmtpError(ehlo.code, smtpMessage(ehlo.code, 'connect'));
    }
    const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l))?.toUpperCase().split(/[ =]/).slice(1) ?? [];
    const { user, password } = input.login;
    let authed: SmtpReply;
    if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
      authed = await s.send(`AUTH PLAIN ${b64(`\u0000${user}\u0000${password}`)}`);
    } else {
      authed = await s.send('AUTH LOGIN');
      if (authed.code === 334) authed = await s.send(b64(user));
      if (authed.code === 334) authed = await s.send(b64(password));
    }
    if (authed.code === 535 || authed.code === 534 || authed.code === 530) throw new ReconnectNeeded(LOGIN_REFUSED);
    if (authed.code !== 235) throw new SmtpError(authed.code, smtpMessage(authed.code, 'auth'));

    const from = await s.send(`MAIL FROM:${addr(input.from)}`);
    if (from.code !== 250) throw new SmtpError(from.code, smtpMessage(from.code, 'from'));
    const accepted: string[] = [];
    const rejected: string[] = [];
    let lastRefusal = 0;
    for (const rcpt of input.to) {
      const r = await s.send(`RCPT TO:${addr(rcpt)}`);
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
      else { rejected.push(rcpt); lastRefusal = r.code; }
    }
    if (!accepted.length) {
      await s.send('RSET').catch(() => undefined);
      throw new SmtpError(lastRefusal, smtpMessage(lastRefusal, 'rcpt', rejected.join(', ')));
    }
    const data = await s.send('DATA');
    if (data.code !== 354) throw new SmtpError(data.code, smtpMessage(data.code, 'data'));
    dataSent = true;
    await writeAll(s.socket, dotStuff(input.raw));
    const done = await s.reply();
    if (done.code !== 250) throw new SmtpError(done.code, smtpMessage(done.code, 'data'));
    dataSent = false; // delivered: a QUIT failure no longer matters
    await s.send('QUIT').catch(() => undefined);
    return { accepted, rejected };
  } catch (error) {
    if (error instanceof SmtpError || error instanceof ReconnectNeeded) throw error;
    if (error instanceof McpTransportError) throw dataSent ? new McpTransportError(error.message, true) : error;
    throw socketError(error, server.host, dataSent);
  } finally {
    s.socket.destroy();
  }
}
