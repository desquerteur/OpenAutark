// One long-lived `codex app-server --listen stdio://` per account home (CODEX_HOME).
// Owns: process lease, initialize handshake (and the Codex version its userAgent names, B-048), routing notifications/server requests to the thread
// that owns them, the account-level limits push, idle shutdown after 10 min without turns, and the
// features turned off at start (our guarded computer/browser tools; isolation.ts's workspace features)
// plus isolation.ts's server-wide config and – B-052 M1 – the home's own MCP servers turned off (own-mcp.ts reads
// only their names from config.toml at every start). Codex never breaks over that override: a start (spawn or
// initialize) that fails with it is tried once more without it (a short log note; the home's own servers load as
// before B-052, remembered until config.toml changes); and when config.toml's server names changed while no turn
// runs, the next rpc() restarts the server so new threads never merge a stale override. The process runs in `cwd`, an empty folder no turn works or
// writes in (system/paths.ts engineCwd): the server's own config (model list, account and limit
// reads) loads a project layer from there when a home trusts that folder.
// Never: reads CODEX_HOME files beyond those names (auth.json etc.) – the official CLI owns authentication.

import type { Supervisor, Lease } from '../../system/supervisor.ts';
import type { Executable, ExecutableFinder } from '../../accounts/executables.ts';
import { RpcClient, RpcError, type RpcNotification } from './rpc.ts';
import { SERVER_CONFIG, WORKSPACE_FEATURES } from './isolation.ts';
import { codexConfigFile, configStamp, ownMcpOff, overrideRefused, rememberRefused } from './own-mcp.ts'; // B-052 M1: the person's own MCP servers off for agent threads
import { str } from '../shared.ts';
import { ENV_KEY_PROVIDERS } from '../../../shared/model/providers.ts';

export interface ThreadHandler {
  onNotification(note: RpcNotification): void;
  onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Features turned off because they bypass our own guarded tools (human-priority computer/browser control). */
const UNSAFE_FEATURES = ['computer_use', 'browser_use'];

/**
 * Env vars never handed to engine processes (keys stay in-process for HTTP engines only): every
 * provider key variable of the one env → provider table (PR5 ENV_KEY_PROVIDERS), OLLAMA_API_KEY included.
 */
export const STRIPPED_ENV: readonly string[] = Object.keys(ENV_KEY_PROVIDERS);

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

export interface CodexServerOptions {
  key: string; // account id (lease owner)
  home?: string; // CODEX_HOME (undefined = default CLI home)
  executable: Executable;
  supervisor: Supervisor;
  cwd: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  onLimits?: (params: Record<string, unknown>) => void;
  onExit?: () => void;
  /** Short notes (B-052 M1 fallback); default the supervisor's log. */
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/** B-052 M1: the override the running process started with (config.toml path, its stamp then, the `-c` pairs). */
interface OwnMcpState { file: string; stamp: string; args: string[] }

/** This codex.exe lost its helper (an update while it ran): the next process of every account starts from what this PC has now. */
export async function pickAgain(finder: Pick<ExecutableFinder, 'find'>, servers: Iterable<CodexServer>): Promise<void> {
  const executable = await finder.find('codex', { force: true }).catch(() => null);
  if (executable) for (const server of servers) server.useExecutable(executable);
}

export class CodexServer {
  readonly key: string;
  private options: CodexServerOptions;
  private restartDue = false;
  private lease: Lease | undefined;
  private client: RpcClient | undefined;
  private starting: Promise<RpcClient> | undefined;
  private readonly threads = new Map<string, ThreadHandler>();
  private activeTurns = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private ownMcp: OwnMcpState | undefined;
  lastUsedAt = 0;
  /** B-048 E2: the Codex version from initialize's userAgent (undefined until a start, or when it names none). */
  cliVersion: string | undefined;

  constructor(options: CodexServerOptions) {
    this.options = options;
    this.key = options.key;
  }

  get running(): boolean { return Boolean(this.client && !this.client.isClosed); }

  /** The open connection, if any – never starts or restarts the process (C4: "Stop all work" reaches only what runs). */
  get current(): RpcClient | undefined { return this.running ? this.client : undefined; }

  async rpc(): Promise<RpcClient> {
    const running = this.client && !this.client.isClosed ? this.client : undefined;
    // B-052 M1: config.toml's server names changed meanwhile, or another codex.exe is to run – restart between turns (a running turn is never cut).
    if (running && this.activeTurns === 0 && !this.starting && (this.restartDue || await this.ownMcpChanged()) && this.client === running && this.activeTurns === 0) {
      this.restartDue = false;
      await this.dispose();
    }
    if (this.client && !this.client.isClosed) return this.client;
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** The executable of the next start; a running process of another one ends between turns. */
  useExecutable(executable: Executable): void {
    if (executable.command === this.options.executable.command) return;
    this.options = { ...this.options, executable };
    this.restartDue = true;
  }

  register(threadId: string, handler: ThreadHandler): () => void {
    this.threads.set(threadId, handler);
    return () => { if (this.threads.get(threadId) === handler) this.threads.delete(threadId); };
  }

  /** Marks a turn as running (prevents idle shutdown). Returns the end function. */
  beginTurn(): () => void {
    this.activeTurns++;
    this.lastUsedAt = Date.now();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeTurns--;
      this.lastUsedAt = Date.now();
      this.armIdle();
    };
  }

  /** True when no turn ran for `idleMs`. */
  idle(now: number, idleMs = this.options.idleMs ?? 600_000): boolean {
    return this.activeTurns === 0 && now - this.lastUsedAt >= idleMs;
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const lease = this.lease;
    this.client?.close(new Error('codex server disposed'));
    this.client = undefined;
    this.lease = undefined;
    this.threads.clear();
    await lease?.release();
  }

  private armIdle(): void {
    if (this.activeTurns > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.activeTurns === 0) void this.dispose(); }, this.options.idleMs ?? 600_000);
    this.idleTimer.unref?.();
  }

  /** B-052 M1: the override as config.toml asks for it now ([] while this home refuses it). */
  private async wantedOwnMcp(file: string, stamp: string): Promise<string[]> {
    return overrideRefused(file, stamp) ? [] : ownMcpOff(this.options.home, this.options.env ?? process.env);
  }

  /** B-052 M1: config.toml changed since the start and asks for another override (a mere stamp change is noted). */
  private async ownMcpChanged(): Promise<boolean> {
    const seen = this.ownMcp;
    if (!seen) return false;
    const stamp = await configStamp(seen.file);
    if (stamp === seen.stamp) return false;
    const wanted = await this.wantedOwnMcp(seen.file, stamp);
    if (wanted.join('\n') !== seen.args.join('\n')) return true;
    seen.stamp = stamp; // another edit (a trusted folder, the model …): the running override still fits
    return false;
  }

  private async start(): Promise<RpcClient> {
    const file = codexConfigFile(this.options.home, this.options.env ?? process.env);
    const stamp = await configStamp(file);
    const ownMcp = await this.wantedOwnMcp(file, stamp);
    this.ownMcp = { file, stamp, args: ownMcp };
    if (!ownMcp.length) return this.launch([]);
    try {
      return await this.launch(ownMcp);
    } catch (error) {
      // Codex must never break over the override: once more without it (its own servers then load as before B-052).
      let client: RpcClient;
      try { client = await this.launch([]); } catch { throw error; } // not the override's fault
      rememberRefused(file, stamp);
      this.ownMcp = { file, stamp, args: [] };
      (this.options.log ?? this.options.supervisor.log)?.warn('codex refused turning off its own MCP servers; started without that override', { owner: `codex:${this.key}` });
      return client;
    }
  }

  private async launch(ownMcp: readonly string[]): Promise<RpcClient> {
    const { executable, supervisor, home } = this.options;
    const off = [...UNSAFE_FEATURES, ...WORKSPACE_FEATURES];
    const args = [
      ...executable.prefixArgs, 'app-server', '--listen', 'stdio://',
      ...off.flatMap((name) => ['-c', `features.${name}=false`]), ...[...SERVER_CONFIG, ...ownMcp].flatMap((pair) => ['-c', pair]),
    ];
    const lease = supervisor.spawn({
      command: executable.command, args, owner: `codex:${this.key}`, kind: 'heavy', cwd: this.options.cwd,
      env: childEnv(this.options.env ?? process.env, { CODEX_HOME: home }), stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.lease = lease;
    const client = new RpcClient(lease.child);
    client.handler = (method, params) => this.route(method, params);
    client.onNotification((note) => this.dispatch(note));
    client.onClose(() => {
      if (this.client === client) { this.client = undefined; this.lease = undefined; }
      for (const handler of this.threads.values()) handler.onNotification({ method: 'workforce/closed', params: {} });
      this.threads.clear();
      this.options.onExit?.();
    });
    try {
      const init = await client.request<{ userAgent?: unknown }>('initialize', {
        clientInfo: { name: 'workforce', title: 'Autark', version: this.options.version },
        capabilities: { experimentalApi: true }, // dynamicTools and inject_items are experimental
      }, 30_000);
      // B-048 E2: "<client>/0.165.0-alpha.1.2 (…)" – the Codex version the rebuild probe is kept for.
      this.cliVersion = /\/(\d+\.\d+\.\d+[^\s()]*)/.exec(typeof init?.userAgent === 'string' ? init.userAgent : '')?.[1] ?? this.cliVersion;
      client.notify('initialized', {});
    } catch (error) {
      client.close(error as Error);
      await lease.release();
      if (this.lease === lease) this.lease = undefined;
      throw error;
    }
    this.client = client;
    this.lastUsedAt = Date.now();
    this.armIdle();
    return client;
  }

  private threadOf(params: Record<string, unknown>): ThreadHandler | undefined {
    const id = str(params.threadId) ?? str(params.conversationId);
    return id ? this.threads.get(id) : undefined;
  }

  private dispatch(note: RpcNotification): void {
    if (note.method === 'account/rateLimits/updated') { this.options.onLimits?.(note.params); }
    this.threadOf(note.params)?.onNotification(note);
  }

  private route(method: string, params: Record<string, unknown>): Promise<unknown> {
    const thread = this.threadOf(params);
    if (!thread) return Promise.reject(new RpcError(-32601, 'No active Autark turn for this request.'));
    return thread.onServerRequest(method, params);
  }
}
