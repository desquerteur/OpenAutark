// Connector test fakes: a KV map, a vault that remembers values, a tool registry, a recording bus, MCP servers behind a
// fake connect() (401 until the right header arrives, scripted failures, list_changed), an AppOAuth whose sign-ins the
// test completes or denies, manual timers, a data folder with the connector files and a fake data-folder watcher.
// Owns: fixtures for test/unit/apps/*.test.ts only. Never imported by src/.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { SecretInfo } from '../../../src/shared/model/security.ts';
import type { EventName } from '../../../src/shared/api/events.ts';
import type { AppsDeps } from '../../../src/runtime/apps/deps.ts';
import { Apps } from '../../../src/runtime/apps/service.ts';
import type { Timers } from '../../../src/runtime/schedules/scheduler.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import {
  McpAuthRequired, OAuthUnsupported,
  type AppKv, type AppOAuth, type McpCallResult, type McpConnection, type McpTarget, type McpToolDef, type OAuthStart,
} from '../../../src/runtime/apps/types.ts';

export class FakeKv implements AppKv {
  readonly map = new Map<string, string>();
  get<T>(key: string): T | undefined { const value = this.map.get(key); return value === undefined ? undefined : JSON.parse(value) as T; }
  set(key: string, value: unknown): void { this.map.set(key, JSON.stringify(value)); }
  delete(key: string): void { this.map.delete(key); }
  keys(prefix = ''): string[] { return [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort(); }
}

export interface VaultEntry { label: string; value: string; source?: string; tags?: string[]; description?: string }

export class FakeSecrets {
  readonly entries = new Map<string, VaultEntry>();
  readonly removed: string[] = [];
  readonly uses: Array<{ id: string; agentId: string; domain?: string }> = [];
  private n = 0;
  async save(input: { id?: string; label: string; kind: SecretInfo['kind']; value?: string; source?: string; tags?: string[]; description?: string }): Promise<SecretInfo> {
    const id = input.id ?? `sec_${++this.n}`;
    const prev = this.entries.get(id);
    this.entries.set(id, { label: input.label, value: input.value ?? prev?.value ?? '', source: input.source ?? prev?.source, tags: input.tags ?? prev?.tags, description: input.description });
    return { id, label: input.label, kind: input.kind, ...(input.source ? { source: input.source } : {}), createdAt: 0 };
  }
  async use(id: string, agentId: string, domain?: string): Promise<string> {
    this.uses.push({ id, agentId, domain });
    const entry = this.entries.get(id);
    if (!entry) throw new WorkforceError('not_found', 'Secret not found.');
    return entry.value;
  }
  remove(id: string): void { this.removed.push(id); this.entries.delete(id); }
}

export class FakeTools {
  readonly defs = new Map<string, ToolDef>();
  register(def: ToolDef): void { this.defs.set(def.name, def); }
  unregister(name: string): void { this.defs.delete(name); }
  names(): string[] { return [...this.defs.keys()].sort(); }
}

export interface FakeServer {
  tools: McpToolDef[];
  /** Answers 401 unless this header has this value. */
  requires?: { header: string; value: string };
  /** Thrown by connect (once each, in order). */
  failures?: Error[];
  /** Thrown by callTool (once each). */
  callFailures?: Error[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Headers / env the last connect sent (a mailbox: its login). */
  seen?: Record<string, string>;
  /** B-053: a mailbox's new-mail listener of the last connect (the test plays the IDLE watcher). */
  onNewMail?: (info: { count: number; from?: string; subject?: string }) => void;
}

export class FakeConnection implements McpConnection {
  readonly info = { protocolVersion: '2025-11-25', name: 'fake' };
  closed = false;
  private readonly listeners = new Set<() => void>();
  readonly server: FakeServer;
  /** The target's headers, read per request like the real client. */
  private readonly headers?: () => Promise<Record<string, string>>;
  constructor(server: FakeServer, headers?: () => Promise<Record<string, string>>) { this.server = server; this.headers = headers; }
  async listTools(): Promise<McpToolDef[]> { return this.server.tools.map((tool) => ({ ...tool })); }
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const failure = this.server.callFailures?.shift();
    if (failure) throw failure;
    if (this.headers && this.server.requires && (await this.headers())[this.server.requires.header] !== this.server.requires.value) throw new McpAuthRequired({ status: 401 });
    this.server.calls.push({ tool: name, args });
    return { content: [{ type: 'text', text: `ran ${name}` }] };
  }
  onToolsChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.closed = true; }
  toolsChanged(): void { for (const listener of this.listeners) listener(); }
}

export class FakeServers {
  readonly servers = new Map<string, FakeServer>();
  readonly opened: McpTarget[] = [];
  readonly connections: FakeConnection[] = [];
  /** Resolves pending connects only when released (single-flight checks). */
  gate?: Promise<void>;

  add(key: string, tools: string[] | McpToolDef[], extra: Partial<FakeServer> = {}): FakeServer {
    const list = tools.map((tool) => typeof tool === 'string' ? { name: tool, description: `Does ${tool}`, inputSchema: { type: 'object' } } : tool);
    const server: FakeServer = { tools: list, calls: [], ...extra };
    this.servers.set(key, server);
    return server;
  }

  readonly connect = async (target: McpTarget): Promise<McpConnection> => {
    this.opened.push(target);
    const key = target.kind === 'http' ? target.url : target.kind === 'stdio' ? target.command : target.address;
    if (this.gate) await this.gate;
    const server = this.servers.get(key);
    if (!server) throw new Error('ECONNREFUSED 10.0.0.9:443 token=leaked');
    const failure = server.failures?.shift();
    if (failure) throw failure;
    if (target.kind === 'http') {
      const headers = (await target.headers?.()) ?? {};
      server.seen = headers;
      if (server.requires && headers[server.requires.header] !== server.requires.value) throw new McpAuthRequired({ status: 401, resourceMetadata: 'https://auth.example.com/.well-known/oauth-protected-resource' });
    } else if (target.kind === 'stdio') {
      server.seen = { ...(target.env ?? {}) };
    } else {
      const login = await target.login();
      server.seen = { user: login.user, password: login.password };
      server.onNewMail = target.onNewMail;
    }
    const conn = new FakeConnection(server, target.kind === 'http' ? target.headers : undefined);
    this.connections.push(conn);
    return conn;
  };
}

export class FakeOAuth implements AppOAuth {
  readonly begins: Array<{ appId: string; resourceUrl: string; challenge: McpAuthRequired; appName: string }> = [];
  readonly grants = new Set<string>();
  readonly forgotten: string[] = [];
  readonly cancelled: string[] = [];
  unsupported = false;
  closed = false;
  private readonly open = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  async begin(input: { appId: string; resourceUrl: string; challenge: McpAuthRequired; appName: string }): Promise<OAuthStart> {
    this.begins.push(input);
    if (this.unsupported) throw new OAuthUnsupported();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    this.open.set(input.appId, { resolve: () => { this.grants.add(input.appId); resolve(); }, reject });
    return { authUrl: `https://auth.example.com/authorize?client=${input.appId}`, done, cancel: () => { this.cancelled.push(input.appId); reject(new Error('The sign-in was cancelled.')); } };
  }
  /** The person agreed in the browser. */
  complete(appId: string): void { this.open.get(appId)?.resolve(); this.open.delete(appId); }
  /** The person said no. */
  deny(appId: string): void { this.open.get(appId)?.reject(new Error('The sign-in was denied.')); this.open.delete(appId); }
  readonly invalidated: string[] = [];
  /** The access token authHeaders hands out; invalidate() makes the next one a refreshed token. */
  access = 'oauth-access';
  invalidate(appId: string): void { this.invalidated.push(appId); this.access = 'oauth-access-renewed'; }
  async authHeaders(appId: string): Promise<Record<string, string>> { return this.grants.has(appId) ? { Authorization: `Bearer ${this.access}` } : {}; }
  hasGrant(appId: string): boolean { return this.grants.has(appId); }
  async forget(appId: string): Promise<void> { this.forgotten.push(appId); this.grants.delete(appId); }
  close(): void { this.closed = true; }
}

export class ManualTimers implements Timers {
  readonly pending = new Set<{ fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown { const handle = { fn, ms }; this.pending.add(handle); return handle; }
  clear(handle: unknown): void { this.pending.delete(handle as { fn: () => void; ms: number }); }
  fireAll(): void { for (const handle of [...this.pending]) { this.pending.delete(handle); handle.fn(); } }
}

/** A fresh data folder; `write` puts a connector file, `status` reads status.json. */
export function dataFolder() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-connectors-'));
  const connectors = path.join(dir, 'connectors');
  return {
    dir,
    write(name: 'mcp.json' | 'mail.json', value: unknown): void { mkdirSync(connectors, { recursive: true }); writeFileSync(path.join(connectors, name), typeof value === 'string' ? value : JSON.stringify(value)); },
    read(name: string): unknown { return JSON.parse(readFileSync(path.join(connectors, name), 'utf8')); },
    exists(name: string): boolean { return existsSync(path.join(connectors, name)); },
  };
}

export function appsFixture(overrides: Partial<AppsDeps> = {}) {
  const kv = new FakeKv();
  const secrets = new FakeSecrets();
  const tools = new FakeTools();
  const events: Array<{ event: EventName; data: unknown }> = [];
  const bus = { emit: (event: EventName, data: unknown) => { events.push({ event, data }); } };
  const servers = new FakeServers();
  const oauth = new FakeOAuth();
  const timers = new ManualTimers();
  const browser: string[] = [];
  const data = dataFolder();
  let owner: ((event: { parts?: readonly string[] }) => void) | undefined;
  const rootWatcher = { register: (_name: string, run: (event: { parts?: readonly string[] }) => void) => { owner = run; return () => { owner = undefined; }; } };
  let clock = 1_000_000;
  const deps: AppsDeps = {
    services: { bus, secrets, tools, rootWatcher },
    dataDir: data.dir,
    kv, connect: servers.connect, oauth,
    openExternal: (url) => { browser.push(url); },
    clientInfo: { name: 'workforce-test', version: '0.0.0' },
    now: () => clock, timers, env: { PATH: '/usr/bin', HOME: '/home/me', SECRET_OF_RUNTIME: 'never-passed' }, platform: 'linux',
    ...overrides,
  };
  const apps = new Apps(deps);
  return {
    apps, deps, kv, secrets, tools, events, servers, oauth, timers, browser, data,
    /** The data folder watcher saw a change in the connectors folder. */
    changedFile: (name = 'mcp.json') => owner?.({ parts: [name] }),
    changed: () => events.filter((entry) => entry.event === 'apps.changed').map((entry) => (entry.data as { id: string }).id),
    tick: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

/** The WorkforceError code a promise or call ends with ('ok' when none). */
export async function codeOf(run: () => unknown): Promise<string> {
  try { await run(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? (error as Error).name; }
}
