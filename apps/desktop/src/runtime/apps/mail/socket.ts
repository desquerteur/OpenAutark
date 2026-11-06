// B-053 track D: the wire under IMAP and SMTP – opening a mail server's socket (implicit TLS, or plain TCP that the
// protocol upgrades with STARTTLS), the test seams for both, and a byte reader that hands out CRLF lines and exact
// byte counts (IMAP literals) with limits. A loopback server (Proton Bridge on 127.0.0.1) may use its self-signed
// certificate; every other host needs a valid one. Errors become user-safe McpTransportErrors (host name only).
// Owns: sockets, TLS upgrade, the reader. Never: logs or keeps a byte that went over the wire.

import * as net from 'node:net';
import * as tls from 'node:tls';
import type { MailServer } from '../../../shared/model/apps.ts';
import { McpTransportError } from '../types.ts';

/** Test seam for TLS: implicit TLS gets host/port; a STARTTLS upgrade gets the plain `socket` to wrap. */
export type TlsConnect = (options: { host: string; port: number; socket?: net.Socket; servername: string; rejectUnauthorized: boolean }) => net.Socket;
/** Test seam for plain TCP (STARTTLS servers). */
export type NetConnect = (options: { host: string; port: number }) => net.Socket;
export interface MailSockets { tls?: TlsConnect; net?: NetConnect }

export const CONNECT_TIMEOUT_MS = 20_000;
const MAX_LINE = 8 * 1024 * 1024;
const MAX_BYTES = 48 * 1024 * 1024;

export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1';

const defaultTls: TlsConnect = (o) => tls.connect(o.socket
  ? { socket: o.socket, servername: net.isIP(o.servername) ? undefined : o.servername, rejectUnauthorized: o.rejectUnauthorized } // an IP is no TLS name (RFC 6066)
  : { host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.servername, rejectUnauthorized: o.rejectUnauthorized });
const defaultNet: NetConnect = (o) => net.connect({ host: o.host, port: o.port });

/** A socket failure as the person reads it. */
export function socketError(error: unknown, host: string, sent = false): McpTransportError {
  if (error instanceof McpTransportError) return error;
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new McpTransportError(`The mail server ${host} was not found.`, sent);
  if (code === 'ECONNREFUSED') return new McpTransportError(`${host} refused the connection.`, sent);
  if (code === 'ETIMEDOUT') return new McpTransportError(`${host} did not answer in time.`, sent);
  if (/CERT|SELF_SIGNED|VERIFY|ALTNAME/.test(code)) return new McpTransportError(`The certificate of ${host} is not valid.`, sent);
  if (code === 'ECONNRESET' || code === 'EPIPE') return new McpTransportError(`${host} closed the connection.`, sent);
  return new McpTransportError(`The connection to ${host} failed.`, sent);
}

function ready(socket: net.Socket, host: string, timeoutMs: number): Promise<net.Socket> {
  const secure = socket instanceof tls.TLSSocket;
  if (!secure && !socket.connecting && !socket.destroyed) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const done = (error?: unknown) => {
      clearTimeout(timer);
      socket.off(secure ? 'secureConnect' : 'connect', ok);
      socket.off('error', fail);
      if (error === undefined) { resolve(socket); return; }
      socket.destroy();
      reject(socketError(error, host));
    };
    const ok = () => done();
    const fail = (error: unknown) => done(error ?? new Error('closed'));
    const timer = setTimeout(() => done({ code: 'ETIMEDOUT' }), timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', ok);
    socket.once('error', fail);
  });
}

/** Opens the server's socket: TLS right away for 'implicit', plain TCP for 'starttls' (the caller upgrades). */
export function openSocket(server: MailServer, sockets: MailSockets = {}, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  let socket: net.Socket;
  try {
    socket = server.tls === 'implicit'
      ? (sockets.tls ?? defaultTls)({ host: server.host, port: server.port, servername: server.host, rejectUnauthorized: !isLoopback(server.host) })
      : (sockets.net ?? defaultNet)({ host: server.host, port: server.port });
  } catch (error) {
    return Promise.reject(socketError(error, server.host));
  }
  socket.setKeepAlive?.(true, 60_000);
  return ready(socket, server.host, timeoutMs);
}

/** Wraps a plain socket in TLS after the server agreed to STARTTLS. */
export function upgradeSocket(socket: net.Socket, server: MailServer, sockets: MailSockets = {}, timeoutMs = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
  let secure: net.Socket;
  try {
    secure = (sockets.tls ?? defaultTls)({ host: server.host, port: server.port, socket, servername: server.host, rejectUnauthorized: !isLoopback(server.host) });
  } catch (error) {
    return Promise.reject(socketError(error, server.host));
  }
  return ready(secure, server.host, timeoutMs);
}

/** Buffered reader over a socket: CRLF lines (UTF-8) and exact byte counts, one waiter at a time. */
export class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended: Error | undefined;
  private waiter: (() => void) | undefined;
  private readonly onData = (chunk: Buffer) => { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; this.wake(); };
  private readonly onEnd = () => { this.ended ??= new Error('closed'); this.wake(); };
  private readonly onError = (error: Error) => { this.ended = error; this.wake(); };

  private readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  /** Why the socket ended (undefined while open). */
  get closedWith(): Error | undefined { return this.ended; }

  /** Stops reading this socket (before a TLS upgrade wraps it). Bytes not read yet are dropped. */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
  }

  private wake(): void { const w = this.waiter; this.waiter = undefined; w?.(); }

  private wait(): Promise<void> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  /** The next line without its CRLF (a bare LF is accepted). */
  async line(): Promise<string> {
    for (;;) {
      const at = this.buf.indexOf(10);
      if (at >= 0) {
        const end = at > 0 && this.buf[at - 1] === 13 ? at - 1 : at;
        const text = this.buf.subarray(0, end).toString('utf8');
        this.buf = this.buf.subarray(at + 1);
        return text;
      }
      if (this.buf.length > MAX_LINE) throw new Error('line too long');
      await this.wait();
    }
  }

  /** Exactly `n` bytes. */
  async bytes(n: number): Promise<Buffer> {
    if (n > MAX_BYTES) throw new Error('literal too large');
    while (this.buf.length < n) await this.wait();
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/** Writes to the socket; resolves once the bytes are handed to the OS (or rejects when the socket is gone). */
export function writeAll(socket: net.Socket, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || !socket.writable) { reject(new Error('closed')); return; }
    socket.write(data, (error) => { if (error) reject(error); else resolve(); });
  });
}
