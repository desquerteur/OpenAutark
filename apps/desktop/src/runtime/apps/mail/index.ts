// B-053 track D (N5): the front door of mail. connectMail() checks the mailbox (IMAP login, folder list) and returns
// an in-process McpConnection with the fixed mail tools (tools.ts; behaviour in actions.ts) – the service keeps it
// like any MCP connection. With target.onNewMail it also starts the IDLE watcher (idle.ts). mailAutoconfig() finds
// the servers for an address (autoconfig.ts). No npm dependency: IMAP, SMTP and MIME are our own code.
// Owns: that wiring and the connection's lifetime. Never: logs or returns the password, or a message to a log.

import { McpTransportError, type McpCallResult, type McpConnectOptions, type McpConnection, type McpServerInfo, type McpToolDef, type MailTarget } from '../types.ts';
import { runMailTool } from './actions.ts';
import { NewMailWatcher, type WatcherOptions } from './idle.ts';
import { Mailbox } from './mailbox.ts';
import type { NetConnect, TlsConnect } from './socket.ts';
import { MAIL_TOOLS } from './tools.ts';

export { mailAutoconfig, parseAutoconfigXml, presetFor, MICROSOFT_UNSUPPORTED, type MailConfig, type MailConfigResult, type MxResolver } from './autoconfig.ts';
export { MAIL_TOOLS } from './tools.ts';
export { LOGIN_REFUSED } from './imap.ts';
export type { NetConnect, TlsConnect } from './socket.ts';

export const MAIL_PROTOCOL = 'workforce-mail/1';

export type MailConnectOptions = McpConnectOptions & {
  /** Test seams: TLS and plain TCP sockets (default node:tls / node:net). */
  tls?: TlsConnect;
  net?: NetConnect;
  /** Test seam: IDLE renewal and reconnect timing. */
  watcher?: Pick<WatcherOptions, 'reidleMs' | 'backoffMinMs' | 'backoffMaxMs'>;
};

class MailConnection implements McpConnection {
  readonly info: McpServerInfo = { name: 'mail', version: '1', protocolVersion: MAIL_PROTOCOL };
  private closed = false;
  private readonly mailbox: Mailbox;
  private readonly target: MailTarget;
  private readonly sockets: { tls?: TlsConnect; net?: NetConnect };
  private readonly timeoutMs: number | undefined;
  private readonly watcher: NewMailWatcher | undefined;

  constructor(parts: { mailbox: Mailbox; target: MailTarget; sockets: { tls?: TlsConnect; net?: NetConnect }; timeoutMs?: number; watcher?: NewMailWatcher }) {
    this.mailbox = parts.mailbox;
    this.target = parts.target;
    this.sockets = parts.sockets;
    this.timeoutMs = parts.timeoutMs;
    this.watcher = parts.watcher;
  }

  async listTools(): Promise<McpToolDef[]> { return MAIL_TOOLS.map((tool) => structuredClone(tool)); }

  async callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult> {
    if (this.closed) throw new McpTransportError('The mail connection was closed.', false);
    opts?.signal?.throwIfAborted();
    // One action at a time per mailbox: a parallel call's SELECT must not redirect this call's UID commands.
    return this.mailbox.exclusive(() => {
      if (this.closed) throw new McpTransportError('The mail connection was closed.', false);
      opts?.signal?.throwIfAborted();
      return runMailTool({ mailbox: this.mailbox, target: this.target, sockets: this.sockets, timeoutMs: opts?.timeoutMs ?? this.timeoutMs }, name, args ?? {});
    });
  }

  onToolsChanged(): () => void { return () => undefined; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    await this.mailbox.close();
  }
}

/** Opens the mailbox (rejects with ReconnectNeeded on a refused login, McpTransportError when unreachable). */
export async function connectMail(target: MailTarget, opts: MailConnectOptions): Promise<McpConnection> {
  const sockets = { tls: opts.tls, net: opts.net };
  const mailbox = new Mailbox(target, { sockets, timeoutMs: opts.timeoutMs });
  try {
    await mailbox.folders();
  } catch (error) {
    await mailbox.close().catch(() => undefined);
    throw error;
  }
  const watcher = target.onNewMail ? new NewMailWatcher(target, { sockets, timeoutMs: opts.timeoutMs, ...opts.watcher }) : undefined;
  watcher?.start();
  const connection = new MailConnection({ mailbox, target, sockets, timeoutMs: opts.timeoutMs, watcher });
  opts.signal?.addEventListener('abort', () => { void connection.close(); }, { once: true });
  return connection;
}
