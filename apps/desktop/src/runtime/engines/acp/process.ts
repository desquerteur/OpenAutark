// One ACP agent process per account: spawn (heavy lease, the account's own environment without
// provider API keys), initialize, the sessions that live in this process, routing session/update
// and session/request_permission to the turn running in a session, and idle shutdown 10 minutes
// after the last turn (or probe) ended.
// Owns: process lifetime and per-session bookkeeping (config offers, MCP proxy key, running turn).
// Updates for a session without a running turn (e.g. the history session/load replays) are
// dropped; a permission request without a running turn is answered 'cancelled'.
// Never: builds prompts or maps updates (turn.ts / updates.ts), reads the agent's home or token
// files, or keeps state a restart would need (sessions are reopened by id).

import type { Lease, Supervisor } from '../../system/supervisor.ts';
import { childEnv } from '../codex/server.ts';
import { AcpConnection, AcpRpcError, METHOD_NOT_FOUND, initialize, type AgentInfo } from './protocol.ts';
import { parseConfig, type SessionConfig } from './config.ts';
import { isRecord, str } from '../shared.ts';

/** How to start one account's agent (the provider table, PR8, supplies it). */
export interface AcpLaunch {
  name: string; // shown in messages ("Gemini CLI is not signed in for this account.")
  command: string;
  args: string[];
  env?: Record<string, string | undefined>; // e.g. the account's isolated home
}

/** The running turn of a session. */
export interface SessionTurn {
  update(update: Record<string, unknown>): void;
  permission(params: Record<string, unknown>): Promise<unknown>;
}

export interface LiveSession { id: string; config: SessionConfig; proxyKey?: string; turn?: SessionTurn }

export interface AcpProcessOptions {
  key: string; // account id (lease owner)
  launch: AcpLaunch;
  supervisor: Supervisor;
  cwd: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  now?: () => number;
  onExit?: (process: AcpProcess) => void;
}

const IDLE_MS = 600_000;

export class AcpProcess {
  readonly launch: AcpLaunch;
  readonly info: AgentInfo;
  readonly conn: AcpConnection;
  readonly sessions = new Map<string, LiveSession>();
  private readonly lease: Lease;
  private readonly options: AcpProcessOptions;
  private activeTurns = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  lastUsedAt: number;

  private constructor(options: AcpProcessOptions, lease: Lease, conn: AcpConnection, info: AgentInfo) {
    this.options = options;
    this.launch = options.launch;
    this.lease = lease;
    this.conn = conn;
    this.info = info;
    this.lastUsedAt = this.now();
  }

  /** Spawns the agent and runs initialize; rejects (and kills it) when that fails. */
  static async start(options: AcpProcessOptions): Promise<AcpProcess> {
    const { launch, supervisor } = options;
    const lease = supervisor.spawn({
      command: launch.command, args: launch.args, owner: `acp:${options.key}`, kind: 'heavy', cwd: options.cwd,
      env: childEnv(options.env ?? process.env, launch.env ?? {}), stdio: ['pipe', 'pipe', 'ignore'],
    });
    let conn: AcpConnection;
    let info: AgentInfo;
    try {
      conn = new AcpConnection(lease.child);
      info = await initialize(conn, options.version);
    } catch (error) {
      await lease.release();
      throw error;
    }
    const proc = new AcpProcess(options, lease, conn, info);
    proc.wire();
    proc.armIdle();
    return proc;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private wire(): void {
    this.conn.onNotification((note) => {
      if (note.method !== 'session/update') return;
      const session = this.sessions.get(str(note.params.sessionId) ?? '');
      const update = isRecord(note.params.update) ? note.params.update : undefined;
      if (!session || !update) return;
      if (update.sessionUpdate === 'config_option_update') session.config = parseConfig(update, session.config);
      session.turn?.update(update);
    });
    this.conn.handler = async (method, params) => {
      if (method === 'session/request_permission') {
        const turn = this.sessions.get(str(params.sessionId) ?? '')?.turn;
        return turn ? turn.permission(params) : { outcome: { outcome: 'cancelled' } };
      }
      // fs/* and terminal/* are not offered in initialize; anything else is unknown to us.
      throw new AcpRpcError('remote', METHOD_NOT_FOUND, 'This action is not available.');
    };
    this.conn.onClose(() => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      try { this.options.onExit?.(this); } catch { /* isolate */ }
      this.sessions.clear();
      void this.lease.release();
    });
  }

  get running(): boolean { return !this.conn.isClosed; }

  /** Records a session opened by session/new|load|resume (its answer carries the config offers). */
  addSession(id: string, result: unknown, proxyKey?: string): LiveSession {
    const session: LiveSession = { id, config: parseConfig(result), proxyKey };
    this.sessions.set(id, session);
    return session;
  }

  /** Routes the session's updates and permission requests to `turn` until the returned detach. */
  attachTurn(session: LiveSession, turn: SessionTurn): () => void {
    session.turn = turn;
    return () => { if (session.turn === turn) session.turn = undefined; };
  }

  /** Marks work in progress (no idle shutdown meanwhile). Returns the end function. */
  beginTurn(): () => void {
    this.activeTurns++;
    this.lastUsedAt = this.now();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeTurns--;
      this.lastUsedAt = this.now();
      this.armIdle();
    };
  }

  /** True when nothing ran for `idleMs`. */
  idle(now: number, idleMs = this.options.idleMs ?? IDLE_MS): boolean {
    return this.activeTurns === 0 && now - this.lastUsedAt >= idleMs;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.conn.close(new AcpRpcError('closed', -32099, 'The agent was stopped.'));
    await this.lease.release();
  }

  private armIdle(): void {
    if (this.activeTurns > 0 || this.conn.isClosed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.activeTurns === 0) void this.dispose(); }, this.options.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }
}
