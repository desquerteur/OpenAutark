// B-053 track D: a small IMAP4rev1/rev2 client (RFC 3501 / RFC 9051) – greeting, STARTTLS, CAPABILITY,
// LOGIN or AUTHENTICATE PLAIN (SASL-IR when offered), one tagged command at a time from a queue (each with its
// own timeout), literals out (LITERAL+ / LITERAL- non-synchronizing when offered, else waiting for "+") and in
// (via imap-parse.ts), IDLE with DONE, LOGOUT. Untagged EXISTS / EXPUNGE / BYE also go to `onUntagged`.
// A command that got no answer rejects with McpTransportError(sent: true) and ends the connection.
// Owns: the protocol state of one connection. Never: logs a command line (LOGIN carries the password).

import type * as net from 'node:net';
import type { MailServer } from '../../../shared/model/apps.ts';
import { McpTransportError, ReconnectNeeded } from '../types.ts';
import { astring, LITERAL_END, parseResponse, type ImapArg, type ImapResponse, type RawResponse, type Untagged } from './imap-parse.ts';
import { ByteReader, openSocket, socketError, upgradeSocket, writeAll, type MailSockets } from './socket.ts';

export const IMAP_TIMEOUT_MS = 60_000;
/** Response codes of a temporary login refusal (RFC 5530) – the password may well be right. */
const TEMPORARY_LOGIN = /^(UNAVAILABLE|INUSE|LIMIT|SERVERBUG)/i;
export const LOGIN_REFUSED = 'The mail server refused the login – check the address and the app password.';

export interface ImapOptions {
  sockets?: MailSockets;
  timeoutMs?: number;
  /** Every untagged response (EXISTS during IDLE, BYE …). */
  onUntagged?: (response: Untagged) => void;
  /** The connection ended (error, BYE or close). */
  onClose?: () => void;
}

/** A NO / BAD answer to a command (text clipped; the caller turns it into a tool error). */
export class ImapCommandError extends Error {
  readonly status: 'NO' | 'BAD';
  readonly code?: string;
  constructor(status: 'NO' | 'BAD', code: string | undefined, text: string) {
    super(text.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160) || `The mail server answered ${status}.`);
    this.name = 'ImapCommandError';
    this.status = status;
    this.code = code;
  }
}

export interface ImapResult { untagged: Untagged[]; code?: string; text: string }

interface Pending {
  tag: string;
  untagged: Untagged[];
  resolve: (result: ImapResult) => void;
  reject: (error: Error) => void;
  /** One-shot: the "+" a synchronizing literal waits for. */
  cont?: (text: string) => void;
  /** Every other "+" (IDLE started, a SASL challenge). */
  onCont?: (text: string) => void;
}

interface RunOptions { timeoutMs?: number; onCont?: (text: string) => void }

async function readRaw(reader: ByteReader): Promise<RawResponse> {
  const chunks: RawResponse = [];
  for (;;) {
    const line = await reader.line();
    chunks.push(line);
    const m = LITERAL_END.exec(line);
    if (!m) return chunks;
    chunks.push(await reader.bytes(Number(m[1])));
  }
}

export class ImapClient {
  caps = new Set<string>();
  private reader: ByteReader;
  private tagN = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private current: Pending | undefined;
  private closed = false;

  private socket: net.Socket;
  private readonly server: MailServer;
  private readonly opts: ImapOptions;

  private constructor(socket: net.Socket, server: MailServer, opts: ImapOptions) {
    this.socket = socket;
    this.server = server;
    this.opts = opts;
    this.reader = new ByteReader(socket);
  }

  /** Connects, reads the greeting, upgrades with STARTTLS when asked, and knows the capabilities. */
  static async open(server: MailServer, opts: ImapOptions = {}): Promise<ImapClient> {
    const socket = await openSocket(server, opts.sockets);
    const client = new ImapClient(socket, server, opts);
    try {
      await client.start();
      return client;
    } catch (error) {
      client.destroy();
      throw error instanceof McpTransportError || error instanceof ImapCommandError ? error : socketError(error, server.host);
    }
  }

  get isOpen(): boolean { return !this.closed; }
  has(cap: string): boolean { return this.caps.has(cap.toUpperCase()); }

  private async start(): Promise<void> {
    const greeting = parseResponse(await this.withTimeout(readRaw(this.reader)));
    if (greeting.kind !== 'untagged' || (greeting.type !== 'OK' && greeting.type !== 'PREAUTH')) throw new McpTransportError(`${this.server.host} did not greet like a mail server.`, false);
    this.takeCaps(greeting.code);
    if (this.server.tls === 'starttls') {
      await writeAll(this.socket, 'S0 STARTTLS\r\n');
      for (;;) {
        const r = parseResponse(await this.withTimeout(readRaw(this.reader)));
        if (r.kind !== 'tagged') continue;
        if (r.status !== 'OK') throw new McpTransportError(`${this.server.host} does not offer an encrypted connection (STARTTLS).`, false);
        break;
      }
      this.reader.detach();
      this.socket = await upgradeSocket(this.socket, this.server, this.opts.sockets);
      this.reader = new ByteReader(this.socket);
      this.caps.clear();
    }
    void this.loop();
    if (!this.caps.size) await this.capability();
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const ms = this.opts.timeoutMs ?? IMAP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new McpTransportError(`${this.server.host} did not answer in time.`, false)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private takeCaps(code: string | undefined): void {
    if (!code || !/^CAPABILITY /i.test(code)) return;
    this.caps = new Set(code.split(' ').slice(1).map((c) => c.toUpperCase()));
  }

  private async loop(): Promise<void> {
    try {
      for (;;) this.dispatch(parseResponse(await readRaw(this.reader)));
    } catch {
      this.fail(this.closed ? new McpTransportError('The mail connection was closed.', false) : socketError(this.reader.closedWith, this.server.host, true));
    }
  }

  private dispatch(r: ImapResponse): void {
    const pending = this.current;
    if (r.kind === 'cont') {
      const cont = pending?.cont;
      if (pending) pending.cont = undefined;
      if (cont) cont(r.text); else pending?.onCont?.(r.text);
      return;
    }
    if (r.kind === 'untagged') {
      if (r.type === 'CAPABILITY') this.caps = new Set(r.values.map((c) => String(c).toUpperCase()));
      if (r.code) this.takeCaps(r.code);
      pending?.untagged.push(r);
      if (r.type === 'BYE') this.closed = true;
      this.opts.onUntagged?.(r);
      return;
    }
    if (!pending || r.tag !== pending.tag) return;
    this.current = undefined;
    this.takeCaps(r.code);
    if (r.status === 'OK') pending.resolve({ untagged: pending.untagged, code: r.code, text: r.text });
    else pending.reject(new ImapCommandError(r.status, r.code, r.text));
  }

  private fail(error: Error): void {
    const wasOpen = !this.closed;
    this.closed = true;
    const pending = this.current;
    this.current = undefined;
    pending?.reject(error);
    this.socket.destroy();
    if (wasOpen || pending) this.opts.onClose?.();
  }

  destroy(): void { this.closed = true; this.socket.destroy(); }

  /** Runs one command after the ones before it. `parts` are joined by spaces; literals are sent as literals. */
  command(parts: ImapArg[], options: RunOptions = {}): Promise<ImapResult> {
    const run = () => this.runNow(parts, options);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runNow(parts: ImapArg[], options: RunOptions): Promise<ImapResult> {
    if (this.closed) throw new McpTransportError('The mail connection was closed.', false);
    const tag = `W${++this.tagN}`;
    let sentAny = false;
    let settled = false;
    const done = new Promise<ImapResult>((resolve, reject) => {
      this.current = { tag, untagged: [], onCont: options.onCont, resolve: (r) => { settled = true; resolve(r); }, reject: (e) => { settled = true; reject(e); } };
    });
    done.catch(() => undefined);
    const ms = options.timeoutMs ?? this.opts.timeoutMs ?? IMAP_TIMEOUT_MS;
    const timer = ms > 0 ? setTimeout(() => this.fail(new McpTransportError(`${this.server.host} did not answer in time.`, sentAny)), ms) : undefined;
    try {
      let text = `${tag}`;
      const nonSync = (n: number) => this.has('LITERAL+') || (this.has('LITERAL-') && n <= 4096);
      for (const part of parts) {
        if (typeof part === 'string') { text += ` ${part}`; continue; }
        const n = part.literal.length;
        const sync = !nonSync(n);
        const waitCont = sync ? this.continuation() : undefined;
        await writeAll(this.socket, `${text} {${n}${sync ? '' : '+'}}\r\n`);
        sentAny = true;
        if (waitCont) await Promise.race([waitCont, done]);
        if (settled) return await done; // a NO instead of "+"
        await writeAll(this.socket, part.literal);
        text = '';
      }
      await writeAll(this.socket, `${text}\r\n`);
      sentAny = true;
      return await done;
    } catch (error) {
      if (!settled && !(error instanceof ImapCommandError)) this.fail(error instanceof McpTransportError ? error : socketError(error, this.server.host, sentAny));
      throw error instanceof Error && (error instanceof McpTransportError || error instanceof ImapCommandError) ? error : socketError(error, this.server.host, sentAny);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The next "+" of the running command. */
  private continuation(): Promise<string> {
    return new Promise((resolve) => { if (this.current) this.current.cont = resolve; });
  }

  async capability(): Promise<void> { await this.command(['CAPABILITY']); }

  /** Logs in (AUTHENTICATE PLAIN when offered, else LOGIN). A refusal throws ReconnectNeeded. */
  async login(user: string, password: string): Promise<void> {
    let result: ImapResult;
    try {
      if (this.has('AUTH=PLAIN')) {
        const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64');
        let asked = 0;
        result = this.has('SASL-IR')
          ? await this.command(['AUTHENTICATE PLAIN', token])
          : await this.command(['AUTHENTICATE PLAIN'], { onCont: () => { void writeAll(this.socket, `${asked++ ? '*' : token}\r\n`).catch(() => undefined); } });
      } else {
        if (this.has('LOGINDISABLED')) throw new McpTransportError(`${this.server.host} does not allow a password login here.`, false);
        result = await this.command(['LOGIN', astring(user), astring(password)]);
      }
    } catch (error) {
      // RFC 5530: only a refused password asks for a new one; [UNAVAILABLE] and the like are temporary (tried again).
      if (error instanceof ImapCommandError && TEMPORARY_LOGIN.test(error.code ?? '')) throw new McpTransportError(`${this.server.host} cannot sign in right now – try again later.`, false);
      if (error instanceof ImapCommandError) throw new ReconnectNeeded(LOGIN_REFUSED);
      throw error;
    }
    if (!/^CAPABILITY /i.test(result.code ?? '')) await this.capability();
  }

  /** Enters IDLE; resolves once the server confirmed with "+". `stop()` sends DONE and waits for the tagged end;
   *  `ended` resolves when IDLE ends either way (DONE answered, or the connection dropped). */
  async idle(): Promise<{ stop: () => Promise<void>; ended: Promise<void> }> {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const run = this.command(['IDLE'], { timeoutMs: 0, onCont: () => started() });
    const ended = run.then(() => undefined, () => undefined);
    await Promise.race([ready, run]);
    const stop = async () => {
      if (this.closed) return;
      await writeAll(this.socket, 'DONE\r\n').catch(() => undefined);
      await this.withTimeout(run).catch(() => this.fail(new McpTransportError(`${this.server.host} did not answer in time.`, false)));
    };
    return { stop, ended };
  }

  async logout(): Promise<void> {
    if (this.closed) return;
    try { await this.command(['LOGOUT'], { timeoutMs: 5_000 }); } catch { /* closing anyway */ }
    this.destroy();
  }
}
