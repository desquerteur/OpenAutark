// Connectors: one lazily opened McpConnection per connector, opened once even when several calls ask at the same
// time. An http server's requests carry the headers its entry names (secret://<id> handles filled in once per
// connection; an Authorization value without a scheme gets "Bearer ") or, when it names no Authorization header, the
// OAuth header of its sign-in. A stdio server gets a small base environment (PATH, HOME …, like the MCP SDK's default –
// never the runtime's whole environment) plus its entry's env; it starts on the first use and stops after 10 minutes
// without a call (one timer, armed when its last call ends). A mailbox logs in with its password at each login and
// reports new mail of its IDLE watcher through onNewMail. close() aborts an opening handshake; retire() lets running
// calls finish on the old connection while new uses open a fresh one.
// Owns: connection slots, header/env resolution, the idle timers. Never: logs or returns a header or env value,
// keeps a value beyond the connection it is used for, or retries a call.

import type { Logger } from '../contracts.ts';
import type { MailServer } from '../../shared/model/apps.ts';
import type { Timers } from '../schedules/scheduler.ts';
import {
  McpTransportError, ReconnectNeeded,
  type AppOAuth, type Connector, type MailMark, type MailTarget, type McpConnectOptions, type McpConnection, type McpTarget, type StdioTarget,
} from './types.ts';

/** What a mailbox's IDLE watcher reports (types.ts MailTarget.onNewMail). */
export type NewMailInfo = Parameters<NonNullable<MailTarget['onNewMail']>>[0];

/** A stdio server stops after this long without a call. */
export const STDIO_IDLE_MS = 10 * 60_000;

const BASE_ENV_WINDOWS = ['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'WINDIR'];
const BASE_ENV_POSIX = ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'];

export interface ConnectionDeps {
  connect: (target: McpTarget, opts: McpConnectOptions) => Promise<McpConnection>;
  clientInfo: { name: string; version: string };
  /** `text` with every secret://<id> handle filled in from the vault (`host`: where it goes, for the log). */
  resolve(text: string, host?: string): Promise<string>;
  /** A mailbox's servers: its entry's, else looked up from the address. */
  mailServers(connector: Connector): Promise<{ imap: MailServer; smtp: MailServer; user?: string }>;
  oauth: Pick<AppOAuth, 'authHeaders'>;
  /** The current entry (a changed entry gets a fresh connection from the service). */
  connector(appId: string): Connector | undefined;
  /** The server said its tool list changed. */
  onToolsChanged(appId: string): void;
  /** A mailbox's IDLE connection saw new mail in INBOX. */
  onNewMail?(appId: string, info: NewMailInfo): void;
  /** B-059: a mailbox's IDLE high-water mark, kept by the service. */
  mark?: { get(appId: string): MailMark | undefined; set(appId: string, mark: MailMark): void };
  timers: Timers;
  idleMs?: number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  log?: Logger;
}

interface Slot {
  transport: Connector['transport'];
  pending?: Promise<McpConnection>;
  conn?: McpConnection;
  unsubscribe?: () => void;
  busy: number;
  idle?: unknown;
  /** Aborts the opening handshake (and ends the connection). */
  abort: AbortController;
  /** The entry's headers of this connection (handles filled in once). */
  fixed?: Promise<Record<string, string>>;
  /** Replaced by a fresh slot: ends when its last running use does. */
  retired?: boolean;
}

/** Sets a header, replacing any spelling of the same name ("Authorization" / "authorization"). */
export function setHeader(out: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(out)) if (key.toLowerCase() === lower) delete out[key];
  out[name] = value;
}

/** The bare host name of an address ('' when it is none). */
export function hostnameOf(value: string | undefined): string {
  if (!value) return '';
  try { return new URL(value).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; }
}

/** One value from the environment (case-insensitive on Windows, like the system). */
function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (!windows) return undefined;
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

export class AppConnections {
  private readonly d: ConnectionDeps;
  private readonly slots = new Map<string, Slot>();
  /** Retired slots that still run a call. */
  private readonly retiring = new Set<Slot>();
  private closed = false;

  constructor(deps: ConnectionDeps) { this.d = deps; }

  /** Runs `work` on the connector's connection (opened when needed); a stdio server's idle timer waits while it runs. */
  async use<T>(connector: Connector, work: (conn: McpConnection) => Promise<T>): Promise<T> {
    const slot = this.slotOf(connector);
    slot.busy += 1;
    this.clearIdle(slot);
    try {
      return await work(await this.connection(connector, slot));
    } finally {
      slot.busy -= 1;
      if (this.slots.get(connector.id) === slot) {
        if (!slot.conn && !slot.pending && slot.busy === 0) this.slots.delete(connector.id); // the opening failed: nothing held
        else this.armIdle(connector.id, slot);
      } else if (slot.retired && slot.busy === 0) {
        void this.shut(slot);
      }
    }
  }

  /** Ends the connection now (stdio: the server stops; an opening handshake is aborted). The next use opens a new one. */
  async close(appId: string): Promise<void> {
    const slot = this.slots.get(appId);
    if (!slot) return;
    this.slots.delete(appId);
    await this.shut(slot);
  }

  /** New uses open a fresh connection; the current one ends once its running calls are done. */
  async retire(appId: string): Promise<void> {
    const slot = this.slots.get(appId);
    if (!slot) return;
    this.slots.delete(appId);
    if (slot.busy === 0) { await this.shut(slot); return; }
    slot.retired = true;
    this.clearIdle(slot);
    this.retiring.add(slot);
  }

  /** Shutdown: every connection ends; uses fail until reopen(). */
  async closeAll(): Promise<void> {
    this.closed = true;
    const retiring = [...this.retiring];
    await Promise.all([...[...this.slots.keys()].map((id) => this.close(id)), ...retiring.map((slot) => this.shut(slot))]);
  }

  reopen(): void { this.closed = false; }

  /** The request headers of an http server: its entry's headers, else the sign-in's Authorization header. */
  async headers(appId: string, slot?: Slot): Promise<Record<string, string>> {
    const connector = this.d.connector(appId);
    if (!connector) throw new ReconnectNeeded('This connector is gone from its file.');
    const fixed = slot ? (slot.fixed ??= this.fixedHeaders(connector)) : this.fixedHeaders(connector);
    let out: Record<string, string>;
    try { out = { ...(await fixed) }; } catch (error) {
      if (slot?.fixed === fixed) slot.fixed = undefined; // read again by the next request
      throw error;
    }
    if (!Object.keys(out).some((name) => name.toLowerCase() === 'authorization')) {
      for (const [name, value] of Object.entries(await this.d.oauth.authHeaders(appId, connector.url))) setHeader(out, name, value);
    }
    return out;
  }

  private async fixedHeaders(connector: Connector): Promise<Record<string, string>> {
    const host = hostnameOf(connector.url);
    const out: Record<string, string> = {};
    for (const [name, raw] of Object.entries(connector.headers ?? {})) {
      const value = await this.d.resolve(raw, host);
      setHeader(out, name, name.toLowerCase() === 'authorization' && !/^[A-Za-z]+ \S/.test(value) ? `Bearer ${value}` : value);
    }
    return out;
  }

  /** The environment of a stdio server: the base variables, then its own (handles filled in). */
  async env(connector: Connector): Promise<Record<string, string>> {
    const windows = this.d.platform === 'win32';
    const out: Record<string, string> = {};
    for (const name of windows ? BASE_ENV_WINDOWS : BASE_ENV_POSIX) {
      const value = envValue(this.d.env, name, windows);
      if (value !== undefined) out[name] = value;
    }
    for (const [name, value] of Object.entries(connector.env ?? {})) out[name] = await this.d.resolve(value);
    return out;
  }

  private slotOf(connector: Connector): Slot {
    let slot = this.slots.get(connector.id);
    if (!slot) {
      slot = { transport: connector.transport, busy: 0, abort: new AbortController() };
      this.slots.set(connector.id, slot);
    }
    return slot;
  }

  private async connection(connector: Connector, slot: Slot): Promise<McpConnection> {
    if (this.closed) throw new McpTransportError('The connections are closed.', false);
    if (slot.conn) return slot.conn;
    if (!slot.pending) {
      const id = connector.id;
      slot.pending = this.open(connector, slot).then((conn) => {
        if ((this.slots.get(id) !== slot && !slot.retired) || this.closed || slot.abort.signal.aborted) {
          void conn.close().catch(() => {});
          throw new McpTransportError('The connection was closed.', false);
        }
        slot.conn = conn;
        slot.pending = undefined;
        slot.unsubscribe = conn.onToolsChanged(() => { if (this.slots.get(id) === slot) this.d.onToolsChanged(id); });
        return conn;
      }, (error: unknown) => {
        if (this.slots.get(id) === slot) slot.pending = undefined; // the next use tries again
        if (slot.abort.signal.aborted) throw new McpTransportError('The connection was closed.', false);
        throw error;
      });
    }
    return slot.pending;
  }

  private async open(connector: Connector, slot: Slot): Promise<McpConnection> {
    const options: McpConnectOptions = { clientInfo: this.d.clientInfo, signal: slot.abort.signal };
    if (connector.transport === 'http') {
      if (!connector.url) throw new McpTransportError('The connector has no "url".', false);
      const id = connector.id;
      return this.d.connect({ kind: 'http', url: connector.url, headers: () => this.headers(id, slot) }, options);
    }
    if (connector.transport === 'mail') return this.d.connect(await this.mailTarget(connector), options);
    if (!connector.command) throw new McpTransportError('The connector has no "command".', false);
    const target: StdioTarget = { kind: 'stdio', command: connector.command, args: [...(connector.args ?? [])], env: await this.env(connector) };
    if (connector.cwd) target.cwd = connector.cwd;
    this.d.log?.info('connector server starts', { appId: connector.id });
    return this.d.connect(target, options);
  }

  /** A mailbox: its servers, the login (password filled in at each login), new mail reported while it holds IDLE. */
  private async mailTarget(connector: Connector): Promise<MailTarget> {
    const mail = connector.mail;
    if (!mail) throw new McpTransportError('The mailbox has no address.', false);
    const servers = await this.d.mailServers(connector);
    const id = connector.id;
    return {
      kind: 'mail', address: mail.address, imap: { ...servers.imap }, smtp: { ...servers.smtp },
      login: async () => {
        const current = this.d.connector(id)?.mail ?? mail;
        let password: string;
        try { password = await this.d.resolve(current.password, servers.imap.host); } catch {
          throw new ReconnectNeeded(`The password of ${connector.name} is missing – put it into mail.json.`);
        }
        return { user: current.user ?? servers.user ?? current.address, password };
      },
      onNewMail: (info) => { try { this.d.onNewMail?.(id, info); } catch { /* the wake is best effort */ } },
      ...(this.d.mark ? { mark: { get: () => this.d.mark?.get(id), set: (m: MailMark) => this.d.mark?.set(id, m) } } : {}),
    };
  }

  /** Ends one slot's connection (an opening one is aborted; its then-handler closes what still arrives). */
  private async shut(slot: Slot): Promise<void> {
    this.retiring.delete(slot);
    this.clearIdle(slot);
    slot.unsubscribe?.();
    slot.unsubscribe = undefined;
    const conn = slot.conn;
    slot.conn = undefined;
    slot.fixed = undefined;
    await conn?.close().catch(() => { /* already gone */ }); // first: the abort below would close it without waiting
    if (!slot.abort.signal.aborted) slot.abort.abort(new McpTransportError('The connection was closed.', false));
  }

  private clearIdle(slot: Slot): void {
    if (slot.idle === undefined) return;
    this.d.timers.clear(slot.idle);
    slot.idle = undefined;
  }

  /** A stdio server without a running call stops after the idle time (http keeps its session: nothing runs). */
  private armIdle(appId: string, slot: Slot): void {
    if (slot.transport !== 'stdio' || slot.busy > 0) return;
    this.clearIdle(slot);
    slot.idle = this.d.timers.set(() => {
      slot.idle = undefined;
      if (this.slots.get(appId) !== slot || slot.busy > 0) return;
      this.d.log?.info('connector server stops after idle time', { appId });
      void this.close(appId);
    }, this.d.idleMs ?? STDIO_IDLE_MS);
  }
}
