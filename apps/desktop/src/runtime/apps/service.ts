// Connectors: the service that turns the files in <data>/connectors (connectors.ts) into live connections and agent
// tools. start() moves the old Settings › Apps records into the files once, applies the files and watches the folder
// (the data folder watcher, owner of the entry 'connectors'). Applying: a new or changed entry connects and lists its
// tools ('connecting' → 'ok', tools registered as `app.<id>.<tool>` for every agent); an entry that is gone loses its
// tools, connection and sign-in; "disabled": true unregisters its tools ('off'). At start an entry whose tool list is
// cached (kv 'tools:<id>', same content) registers it without starting or calling a server. AF-005: an entry whose only
// change is its "agents" list keeps its connection and tools – who may use them is read at offer and call time
// (agent-access.ts, tools.ts).
// Sign-in: an http server that answers 401 starts the MCP sign-in in the system browser ('waiting' with the page) when
// the entry was just added or changed in the file or apps.reconnect asks for it – never on a plain start (then it says
// 'signin' and how to start it). A server that allows no sign-in, a refused key or a refused mail login say so ('signin').
// A call that meets an expired sign-in tries once more on a refreshed access token. Every change writes status.json
// and emits 'apps.changed' {id}. Mailboxes are held open and wake their agent on new mail (mail-upkeep.ts, mail-wake.ts).
// Owns: the live state per connector, the tool host, sign-ins. Never: logs or returns a token, header or env value,
// writes mcp.json / mail.json after the one-time move, or polls.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { AppStatus, ConnectedApp } from '../../shared/model/apps.ts';
import type { Timers } from '../schedules/scheduler.ts';
import type { ToolDef } from '../tools/types.ts';
import { connectorAllows, sameAgents } from './agent-access.ts';
import { CONNECTORS_DIR, ensureFiles, migrateRecords, readConnectors, STATUS_FILE, writeStatus } from './connectors.ts';
import { AppConnections } from './connections.ts';
import type { AppsDeps } from './deps.ts';
import { MailUpkeep } from './mail-upkeep.ts';
import { addressOf, clip, errorText, hasAuthorization, signInText } from './texts.ts';
import { cleanServerText } from './tools-schema.ts';
import { appToolDefs } from './tools.ts';
import {
  McpAuthRequired, McpTransportError, OAuthUnsupported, ReconnectNeeded,
  type AppsService, type AppToolHost, type Connector, type MailMark, type McpCallResult, type McpToolDef, type OAuthStart,
} from './types.ts';

interface Item {
  connector: Connector;
  status: AppStatus;
  error?: string;
  tools: McpToolDef[];
  registered: string[];
  signIn?: OAuthStart;
  /** The newest attempt: an older one's result is dropped. */
  gen: number;
  /** The refused access token was dropped once since the last success. */
  renewed?: boolean;
}

interface AttemptMode {
  /** A 401 may open the browser sign-in. */
  signIn: boolean;
  /** Right after a completed sign-in: a 401 again ends in 'signin'. */
  afterSignIn?: boolean;
}

/** A server's tools/list_changed lists the tools again after this pause (a burst ends in one listing). */
export const RELIST_MS = 2_000;
const TOOL_NAMES_SHOWN = 40;
const HANDLE = /secret:\/\/([A-Za-z0-9_-]{1,128})/g;

const realTimers: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Apps implements AppsService {
  readonly host: AppToolHost;
  private readonly d: AppsDeps;
  private readonly items = new Map<string, Item>();
  private readonly connections: AppConnections;
  private readonly timers: Timers;
  private readonly relistTimers = new Map<string, unknown>();
  private readonly mail: MailUpkeep;
  private readonly background = new Set<Promise<unknown>>();
  private problems: string[] = [];
  private statusTimer: unknown;
  private unwatch?: () => void;
  private stopped = false;

  constructor(deps: AppsDeps) {
    this.d = deps;
    this.timers = deps.timers ?? realTimers;
    this.connections = new AppConnections({
      connect: deps.connect, clientInfo: deps.clientInfo, oauth: deps.oauth,
      resolve: (text, host) => this.resolve(text, host),
      mailServers: (connector) => this.mail.serversOf(connector),
      connector: (id) => this.items.get(id)?.connector,
      onToolsChanged: (id) => this.relist(id),
      onNewMail: (id, info) => this.mail.notice(id, info),
      mark: { get: (id) => deps.kv.get<MailMark>(`mailmark:${id}`), set: (id, mark) => deps.kv.set(`mailmark:${id}`, { validity: mark.validity, next: mark.next }) },
      timers: this.timers, idleMs: deps.idleMs, env: deps.env ?? process.env, platform: deps.platform ?? process.platform, log: deps.services.log,
    });
    this.mail = new MailUpkeep({
      timers: this.timers, connections: this.connections, stopped: () => this.stopped, connected: (id) => this.connected(id),
      needsSignIn: (id) => { const item = this.items.get(id); if (item?.status === 'ok') this.set(item, { status: 'signin', error: signInText(item.connector) }); },
      track: (work) => this.track(work), autoconfig: deps.mailAutoconfig, onNewMail: deps.onNewMail, log: deps.services.log,
    });
    this.host = {
      state: (appId) => { const item = this.items.get(appId); return item ? { connector: item.connector, status: item.status, ...(item.error ? { error: item.error } : {}) } : undefined; },
      call: (appId, tool, args, signal) => this.call(appId, tool, args, signal),
    };
  }

  start(): void {
    this.stopped = false;
    this.connections.reopen();
    try {
      const moved = migrateRecords(this.d.dataDir, this.d.kv);
      if (moved) this.d.services.log?.info('connected apps moved into the connector files', { moved });
      ensureFiles(this.d.dataDir);
    } catch (error) {
      this.d.services.log?.warn('connector files could not be prepared', { error: error instanceof Error ? error.message : 'error' });
    }
    this.apply(true);
    this.unwatch = this.d.services.rootWatcher?.register(CONNECTORS_DIR, (event) => {
      if (event.parts?.[0]?.toLowerCase() === STATUS_FILE) return; // our own report
      if (!this.stopped) this.apply(false);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = undefined;
    for (const handle of this.relistTimers.values()) this.timers.clear(handle);
    this.relistTimers.clear();
    this.mail.stop();
    for (const id of this.items.keys()) this.endSignIn(id);
    try { this.d.oauth.close(); } catch { /* best effort */ }
    await this.connections.closeAll();
    if (this.statusTimer !== undefined) { this.timers.clear(this.statusTimer); this.statusTimer = undefined; this.writeStatus(); }
  }

  list(): ConnectedApp[] {
    return [...this.items.values()].map((item) => {
      const app: ConnectedApp = {
        id: item.connector.id, name: item.connector.name, transport: item.connector.transport, address: addressOf(item.connector),
        status: item.status, tools: item.registered.length,
        toolNames: item.tools.slice(0, TOOL_NAMES_SHOWN).map((tool) => cleanServerText(tool.title ?? tool.annotations?.title ?? tool.name, 80) || String(tool.name).slice(0, 80)),
      };
      if (item.error && (item.status === 'error' || item.status === 'signin')) app.error = item.error;
      if (item.signIn && item.status === 'waiting') app.signInUrl = item.signIn.authUrl;
      if (item.connector.agents) app.agents = [...item.connector.agents];
      return app;
    });
  }

  /** Connectors whose tools this agent gets now (AF-005: those whose "agents" list names its id, or that have none). */
  usableBy(agentId: string): string[] {
    return [...this.items.values()]
      .filter((item) => (item.status === 'ok' || item.status === 'connecting') && item.registered.length > 0 && connectorAllows(item.connector, { id: agentId }))
      .map((item) => item.connector.id);
  }

  async reconnect(id: string): Promise<ConnectedApp> {
    const item = this.items.get(id);
    if (!item) throw new WorkforceError('not_found', `No connector "${id}" – see <data>/connectors/status.json for the ids.`, { details: { id } });
    if (!item.connector.enabled) throw new WorkforceError('conflict', `${item.connector.name} is turned off ("disabled": true in its file).`);
    this.endSignIn(id);
    await this.connections.retire(id); // a running agent call ends on the old connection
    await this.attempt(id, { signIn: true });
    const app = this.list().find((entry) => entry.id === id);
    if (!app) throw new WorkforceError('not_found', 'The connector was removed.');
    return app;
  }

  /** Test seam and shutdown: resolves once background work (connects, sign-ins, listings) is done. */
  async idle(): Promise<void> {
    do {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.allSettled([...this.background]);
    } while (this.background.size);
  }

  // ------------------------------------------------------------------ applying the files

  private apply(atStart: boolean): void {
    let read: ReturnType<typeof readConnectors>;
    try { read = readConnectors(this.d.dataDir); } catch (error) {
      this.d.services.log?.warn('connector files could not be read', { error: error instanceof Error ? error.name : 'error' });
      return;
    }
    const problemsBefore = this.problems.join('\n');
    this.problems = read.problems;
    const seen = new Set<string>();
    for (const connector of read.connectors) {
      seen.add(connector.id);
      const prev = this.items.get(connector.id);
      if (prev && prev.connector.fingerprint === connector.fingerprint && prev.connector.name === connector.name) {
        if (!sameAgents(prev.connector.agents, connector.agents)) { prev.connector = connector; this.changed(connector.id); } // AF-005: who, not how
        continue;
      }
      if (prev) this.drop(prev, false);
      const cached = this.d.kv.get<{ fingerprint?: string; tools?: McpToolDef[] }>(`tools:${connector.id}`);
      const tools = cached?.fingerprint === connector.fingerprint && Array.isArray(cached.tools) ? cached.tools.filter((tool) => tool && typeof tool.name === 'string') : [];
      const item: Item = { connector, status: connector.enabled ? 'ok' : 'off', tools, registered: [], gen: 0 };
      this.items.set(connector.id, item);
      this.changed(connector.id);
      if (!connector.enabled) continue;
      if (tools.length) this.register(item);
      if (atStart && tools.length) this.mail.hold(connector.id);
      else this.track(this.attempt(connector.id, { signIn: !atStart }));
    }
    for (const item of [...this.items.values()]) {
      if (seen.has(item.connector.id)) continue;
      this.drop(item, true);
      this.items.delete(item.connector.id);
      this.changed(item.connector.id);
    }
    // a changed entry already scheduled it (changed()); unchanged files write nothing – the folder's own change event after
    // writing status.json would otherwise rewrite it every ~2 s while idle
    if (atStart || this.problems.join('\n') !== problemsBefore) this.scheduleStatus();
  }

  /** Ends everything a connector holds; `removed`: its sign-in grant and tool cache go too. */
  private drop(item: Item, removed: boolean): void {
    const id = item.connector.id;
    item.gen += 1;
    this.endSignIn(id);
    const relist = this.relistTimers.get(id);
    if (relist !== undefined) { this.timers.clear(relist); this.relistTimers.delete(id); }
    this.mail.forget(id);
    this.unregister(item);
    void this.connections.close(id);
    if (!removed) return;
    this.d.kv.delete(`tools:${id}`);
    this.d.kv.delete(`mailmark:${id}`);
    void this.d.oauth.forget(id).catch(() => this.d.services.log?.warn('connector sign-in was not revoked', { appId: id }));
  }

  // ------------------------------------------------------------------ connecting and signing in

  /** Opens the connector and lists its tools; on failure says what it needs (and may start a sign-in). */
  private async attempt(id: string, how: AttemptMode): Promise<void> {
    const item = this.items.get(id);
    if (!item?.connector.enabled || this.stopped) return;
    const gen = ++item.gen;
    this.set(item, { status: 'connecting' });
    try {
      const tools = await this.connections.use(item.connector, (conn) => conn.listTools());
      if (!this.current(item, gen)) return;
      item.renewed = false;
      item.tools = tools;
      this.d.kv.set(`tools:${id}`, { fingerprint: item.connector.fingerprint, tools });
      this.register(item);
      this.set(item, { status: 'ok' });
      this.d.services.log?.info('connector connected', { appId: id, tools: tools.length });
      this.mail.hold(id);
    } catch (error) {
      if (!this.current(item, gen)) return;
      await this.connections.retire(id);
      await this.failed(item, gen, error, how);
    }
  }

  private async failed(item: Item, gen: number, error: unknown, how: AttemptMode): Promise<void> {
    const connector = item.connector;
    if (error instanceof McpAuthRequired) {
      if (this.renewOnce(item, error)) return this.attempt(connector.id, how); // a refreshed access token first (once)
      if (how.afterSignIn) return this.set(item, { status: 'signin', error: `The sign-in did not give access to ${connector.name}. Try again.` });
      if (!how.signIn || connector.transport !== 'http' || hasAuthorization(connector)) return this.set(item, { status: 'signin', error: signInText(connector) });
      return this.beginSignIn(item, gen, error);
    }
    if (error instanceof ReconnectNeeded) return this.set(item, { status: 'signin', error: clip(error.message) || signInText(connector) });
    this.d.services.log?.warn('connector failed', { appId: connector.id, error: error instanceof Error ? error.name : 'error' });
    this.set(item, { status: 'error', error: errorText(error, connector.name) });
  }

  /** Starts the browser sign-in ('waiting'); its end connects again ('ok') or says what is missing ('signin'). */
  private async beginSignIn(item: Item, gen: number, challenge: McpAuthRequired): Promise<void> {
    const { id, name, url } = item.connector;
    if (!url) return;
    this.endSignIn(id);
    let start: OAuthStart;
    try {
      start = await this.d.oauth.begin({ appId: id, resourceUrl: url, challenge, appName: name });
    } catch (error) {
      if (!this.current(item, gen)) return;
      if (error instanceof OAuthUnsupported) return this.set(item, { status: 'signin', error: 'This server allows no sign-in from here – put a key into its "headers" (Authorization).' });
      this.d.services.log?.warn('connector sign-in did not start', { appId: id, error: error instanceof Error ? error.name : 'error' });
      const reason = error instanceof WorkforceError || error instanceof McpTransportError ? clip(error.message) : '';
      return this.set(item, { status: 'error', error: reason || `The sign-in to ${name} could not start.` });
    }
    if (!this.current(item, gen)) { start.cancel(); return; }
    item.signIn = start;
    this.set(item, { status: 'waiting' });
    start.done.then(() => this.signedIn(item, start), (error: unknown) => this.signInEnded(item, start, error));
    try { await this.d.openExternal(start.authUrl); } catch {
      this.d.services.log?.warn('connector sign-in page did not open', { appId: id }); // status.json names the page
    }
  }

  private signedIn(item: Item, start: OAuthStart): void {
    if (item.signIn !== start) return;
    item.signIn = undefined;
    item.renewed = false;
    this.track(this.attempt(item.connector.id, { signIn: false, afterSignIn: true }));
  }

  private signInEnded(item: Item, start: OAuthStart, error: unknown): void {
    if (item.signIn !== start) return; // cancelled or replaced: already handled
    item.signIn = undefined;
    const reason = error instanceof Error && error.message ? clip(error.message) : '';
    this.set(item, { status: 'signin', error: reason || `The sign-in to ${item.connector.name} did not finish.` });
  }

  private endSignIn(id: string): void {
    const item = this.items.get(id);
    const start = item?.signIn;
    if (!item || !start) return;
    item.signIn = undefined;
    try { start.cancel(); } catch { /* already ended */ }
  }

  /** A 401 with a stored grant: drops the access token once (true), so a refresh comes next. */
  private renewOnce(item: Item, error: unknown): boolean {
    if (!(error instanceof McpAuthRequired) || error.status !== 401 || item.renewed) return false;
    if (!this.d.oauth.invalidate || !this.d.oauth.hasGrant(item.connector.id) || hasAuthorization(item.connector)) return false;
    item.renewed = true;
    this.d.oauth.invalidate(item.connector.id);
    return true;
  }

  // ------------------------------------------------------------------ the tool host

  private async call(appId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal, retried = false): Promise<McpCallResult> {
    const item = this.items.get(appId);
    if (!item) throw new WorkforceError('not_found', 'This connector is no longer in its file.');
    if (!item.connector.enabled) throw new WorkforceError('unavailable', `${item.connector.name} is turned off.`);
    try {
      const result = await this.connections.use(item.connector, (conn) => conn.callTool(tool, args, signal ? { signal } : undefined));
      item.renewed = false;
      if (item.status === 'error' || item.status === 'signin') this.set(item, { status: 'ok' });
      return result;
    } catch (error) {
      if (error instanceof McpAuthRequired || error instanceof ReconnectNeeded) {
        await this.connections.close(appId);
        if (!retried && this.renewOnce(item, error)) return this.call(appId, tool, args, signal, true);
        if (item.status !== 'waiting') this.set(item, { status: 'signin', error: signInText(item.connector) });
      } else if (error instanceof McpTransportError) {
        await this.connections.close(appId); // the next call opens a new connection
        this.mail.hold(appId); // keeps a mailbox's new-mail watcher alive (it closed with it)
      }
      throw error;
    }
  }

  private register(item: Item): void {
    this.unregister(item);
    let defs: ToolDef[] = [];
    try { defs = appToolDefs(item.connector, item.tools, this.host); } catch (error) {
      this.d.services.log?.warn('connector tools were not converted', { appId: item.connector.id, error: error instanceof Error ? error.name : 'error' });
    }
    for (const def of defs) {
      try { this.d.services.tools.register(def); item.registered.push(def.name); } catch {
        this.d.services.log?.warn('connector tool was not registered', { appId: item.connector.id });
      }
    }
  }

  private unregister(item: Item): void {
    for (const name of item.registered) this.d.services.tools.unregister?.(name);
    item.registered = [];
  }

  /** tools/list_changed: one listing RELIST_MS after the last notice. */
  private relist(id: string): void {
    if (this.stopped || this.relistTimers.has(id)) return;
    this.relistTimers.set(id, this.timers.set(() => {
      this.relistTimers.delete(id);
      const item = this.items.get(id);
      if (!item?.connector.enabled || this.stopped) return;
      this.track(this.connections.use(item.connector, (conn) => conn.listTools()).then((tools) => {
        if (this.items.get(id) !== item || JSON.stringify(tools) === JSON.stringify(item.tools)) return;
        item.tools = tools;
        this.d.kv.set(`tools:${id}`, { fingerprint: item.connector.fingerprint, tools });
        this.register(item);
        this.changed(id);
      }, (error: unknown) => this.d.services.log?.warn('connector tools were not listed again', { appId: id, error: error instanceof Error ? error.name : 'error' })));
    }, RELIST_MS));
  }

  // ------------------------------------------------------------------ mail

  /** The connector while it is on and connected (mail-wake.ts checks again before a wake). */
  connected(id: string): Connector | undefined {
    const item = this.items.get(id);
    return item?.connector.enabled && item.status === 'ok' ? item.connector : undefined;
  }

  // ------------------------------------------------------------------ helpers

  /** `text` with every secret://<id> handle filled in from the vault (the runtime's own use). */
  private async resolve(text: string, host?: string): Promise<string> {
    const ids = [...new Set([...text.matchAll(HANDLE)].map((match) => match[1]))];
    if (!ids.length) return text;
    const values = new Map<string, string>();
    for (const id of ids) {
      try { values.set(id, await this.d.services.secrets.use(id, SYSTEM_ID, host || undefined)); } catch {
        throw new ReconnectNeeded(`secret://${id} is not in the secrets catalog – save it there first (secrets.save).`);
      }
    }
    return text.replace(HANDLE, (match, id: string) => values.get(id) ?? match);
  }

  private current(item: Item, gen: number): boolean {
    return !this.stopped && item.gen === gen && this.items.get(item.connector.id) === item;
  }

  private set(item: Item, changes: { status: AppStatus; error?: string }): void {
    item.status = changes.status;
    if (changes.error) item.error = changes.error; else delete item.error;
    this.changed(item.connector.id);
  }

  private changed(id: string): void {
    try { this.d.services.bus.emit('apps.changed', { id }); } catch { /* a listener's problem */ }
    this.scheduleStatus();
  }

  private scheduleStatus(): void {
    if (this.statusTimer !== undefined || this.stopped) return;
    this.statusTimer = this.timers.set(() => { this.statusTimer = undefined; this.writeStatus(); }, 200);
  }

  private writeStatus(): void {
    writeStatus(this.d.dataDir, this.list(), this.problems, this.d.now ? this.d.now() : Date.now());
  }

  private track(work: Promise<unknown>): void {
    this.background.add(work);
    void work.catch(() => { /* reported in the state */ }).finally(() => this.background.delete(work));
  }
}

