// Generic ACP engine: any agent that speaks the Agent Client Protocol (Gemini CLI, Copilot CLI,
// Kimi Code, Cline …) runs workforce turns. One agent process per account (process.ts:
// heavy lease, idle shutdown after 10 min); one session per (agent, chat) living in that process.
// A session from before a restart is reopened with session/resume (no replay) or session/load
// (history replay is dropped), else reported as ended (details.rebase → the executor renews it
// with the full projection). Workforce tools reach the agent as an HTTP MCP server when it
// supports one: a stable per-session proxy URL in front of each turn's hub lease (mcp-proxy.ts).
// A new session gets the stable + volatile prompt as an instructions block in its first prompt
// (ACP has no system prompt); a continued one gets the volatile context block. B-049 F3: where a CLI
// documents it, its launch replaces the CLI's own system prompt with a short pointer to that block and
// cuts its own instructions, MCP servers and tools (providers.ts, per CLI). Turns run in the turn's folder like every
// engine's; the process and the probe session use the neutral folder (`deps.cwd`: the empty engine folder,
// system/paths.ts engineCwd).
// Owns: the process pool, session open/reopen, model listing (the agent's own offer, else one
// 'default' model; audioIn when the agent declares audio prompts, B-058 G7), the account check (a probe session; sign-in errors → needs_login) and ACP
// authenticate for the sign-in flow. Live test C4: "Stop all work" ends every started agent process with its tree (stopBackground).
// Never: reads agent home or token files, passes provider API keys to the agent (childEnv strips
// them) or downloads or installs agents.

import { promises as fsp } from 'node:fs';
import type { Account, EngineId } from '../../../shared/model/providers.ts';
import type { AccountCheck, Engine, EngineCaps, EngineModel, EngineTurnInput, EngineTurnResult } from '../types.ts';
import type { Supervisor } from '../../system/supervisor.ts';
import type { FetchFn } from '../http/common.ts';
import { AcpProcess, type AcpLaunch, type LiveSession } from './process.ts';
import { AcpRpcError, METHOD_NOT_FOUND, isAuthError, type AuthMethod } from './protocol.ts';
import { listing, parseConfig, type SessionConfig } from './config.ts';
import { McpProxy } from './mcp-proxy.ts';
import { HUB } from './updates.ts';
import { failure, runAcpTurn, type ReadFile } from './turn.ts';
import { ERR, isRecord, str } from '../shared.ts';

export type { AcpLaunch } from './process.ts';
/** The agent to start for an account (undefined = none installed for it). */
export type AcpResolver = (account: Account) => Promise<AcpLaunch | undefined>;

export interface AcpEngineDeps {
  supervisor: Supervisor;
  launch: AcpResolver;
  cwd: string; // neutral working dir for agent processes and probe sessions (empty; never a turn's folder)
  version: string;
  idleMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  readFile?: ReadFile;
  fetch?: FetchFn; // the MCP proxy's forwarder (tests)
  cancelGraceMs?: number; // how long a cancel may stay unconfirmed (default 10 s)
}

const OFFER_TTL_MS = 10 * 60_000;

class StartFailure extends Error {}

export class AcpEngine implements Engine {
  readonly id: EngineId = 'acp';
  readonly caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: true, images: true, rebase: true, structured: false, ownTools: true };
  private readonly deps: AcpEngineDeps;
  private readonly now: () => number;
  private readonly processes = new Map<string, Promise<AcpProcess>>();
  private readonly offers = new Map<string, { config: SessionConfig; label: string; vision: boolean; audio: boolean; at: number }>();
  private readonly proxy: McpProxy;

  constructor(deps: AcpEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.proxy = new McpProxy({ fetch: deps.fetch });
  }

  private process(account: Account): Promise<AcpProcess> {
    let pending = this.processes.get(account.id);
    if (!pending) {
      const forget = () => { if (this.processes.get(account.id) === started) this.processes.delete(account.id); };
      const started: Promise<AcpProcess> = this.start(account, forget);
      started.catch(forget);
      this.processes.set(account.id, pending = started);
    }
    return pending;
  }

  private async start(account: Account, forget: () => void): Promise<AcpProcess> {
    const launch = await this.deps.launch(account).catch(() => undefined);
    if (!launch) throw new StartFailure(`${account.label} is not installed.`);
    try {
      return await AcpProcess.start({
        key: account.id, launch, supervisor: this.deps.supervisor, cwd: this.deps.cwd, version: this.deps.version,
        env: this.deps.env, idleMs: this.deps.idleMs, now: this.now,
        onExit: (proc) => { forget(); for (const session of proc.sessions.values()) if (session.proxyKey) this.proxy.drop(session.proxyKey); },
      });
    } catch (error) {
      throw new StartFailure(error instanceof AcpRpcError && error.kind === 'remote' ? `${launch.name} speaks an unsupported ACP version.` : `${launch.name} could not start.`);
    }
  }

  private remember(account: Account, proc: AcpProcess, config: SessionConfig): void {
    this.offers.set(account.id, { config, label: proc.launch.name, vision: proc.info.images, audio: proc.info.audio, at: this.now() });
  }

  /** A throwaway session that shows whether the agent is signed in and what it offers. */
  private async probe(account: Account): Promise<{ proc: AcpProcess; config?: SessionConfig; error?: unknown }> {
    const proc = await this.process(account);
    const end = proc.beginTurn();
    try {
      const result = await proc.conn.request('session/new', { cwd: this.deps.cwd, mcpServers: [] }, 60_000);
      const config = parseConfig(result);
      this.remember(account, proc, config);
      const id = isRecord(result) ? str(result.sessionId) : undefined;
      if (id && proc.info.closeSession) void proc.conn.request('session/close', { sessionId: id }).catch(() => undefined);
      return { proc, config };
    } catch (error) {
      return { proc, error };
    } finally { end(); }
  }

  async listModels(account: Account): Promise<EngineModel[]> {
    const offer = this.offers.get(account.id);
    if (offer && this.now() - offer.at < OFFER_TTL_MS) return listing(offer.config, offer.label, offer.vision, offer.audio);
    const { proc, config, error } = await this.probe(account);
    // Before sign-in the agent cannot say what it offers: one 'default' model until it can.
    if (error && !isAuthError(error)) throw error;
    return listing(config, proc.launch.name, proc.info.images, proc.info.audio);
  }

  async checkAccount(account: Account): Promise<AccountCheck> {
    let probed;
    try { probed = await this.probe(account); }
    catch (error) { return { state: 'error', message: error instanceof StartFailure ? error.message : `${account.label} could not start.` }; }
    const name = probed.proc.launch.name;
    if (!probed.error) return { state: 'ok' };
    if (isAuthError(probed.error)) return { state: 'needs_login', message: `Sign in to ${name}.` };
    return { state: 'error', message: `${name} did not answer the account check.` };
  }

  /** The sign-in methods the account's agent offers (ACP initialize `authMethods`). */
  async authMethods(account: Account): Promise<AuthMethod[]> {
    return (await this.process(account)).info.authMethods;
  }

  /** ACP authenticate (the agent runs its own sign-in, e.g. a browser OAuth). True when it succeeded. */
  async authenticate(account: Account, methodId?: string): Promise<boolean> {
    const proc = await this.process(account);
    const id = methodId ?? proc.info.authMethods[0]?.id;
    if (!id || !proc.info.authMethods.some((method) => method.id === id)) return false;
    const end = proc.beginTurn();
    try {
      await proc.conn.request('authenticate', { methodId: id }, 5 * 60_000);
      this.offers.delete(account.id);
      return true;
    } catch { return false; } finally { end(); }
  }

  /** MCP servers for session/new|load: our hub behind the session's proxy key (bound right away). */
  private async hub(proc: AcpProcess, input: EngineTurnInput): Promise<{ key?: string; servers: unknown[] }> {
    if (!input.mcp) return { servers: [] };
    if (!proc.info.mcpHttp) {
      try { input.onEvent({ type: 'status', note: `${proc.launch.name} cannot use Autark tools (no HTTP MCP)` }); } catch { /* cosmetic */ }
      return { servers: [] };
    }
    const { key, url } = await this.proxy.endpoint();
    this.proxy.bind(key, input.mcp);
    return { key, servers: [{ type: 'http', name: HUB, url, headers: [] }] };
  }

  private async open(proc: AcpProcess, input: EngineTurnInput): Promise<LiveSession | EngineTurnResult> {
    const { key, servers } = await this.hub(proc, input);
    try {
      const result = await proc.conn.request('session/new', { cwd: input.cwd, mcpServers: servers }, 60_000);
      const id = isRecord(result) ? str(result.sessionId) : undefined;
      if (!id || id.length > 500) throw new AcpRpcError('remote', -32603, 'no session id');
      return proc.addSession(id, result, key);
    } catch (error) {
      if (key) this.proxy.drop(key);
      return { text: '', ...failure(error, proc.launch.name) };
    }
  }

  private async reopen(proc: AcpProcess, ref: string, input: EngineTurnInput): Promise<LiveSession | EngineTurnResult> {
    const name = proc.launch.name;
    const ended = (): EngineTurnResult => ({ text: '', stop: 'error', error: { code: 'conflict', message: `${name} could not continue this session.`, details: { rebase: true } } });
    const methods = [proc.info.resumeSession ? 'session/resume' : undefined, proc.info.loadSession ? 'session/load' : undefined].filter((m): m is string => Boolean(m));
    if (!methods.length) return ended();
    const { key, servers } = await this.hub(proc, input);
    for (const method of methods) {
      try {
        const result = await proc.conn.request(method, { sessionId: ref, cwd: input.cwd, mcpServers: servers }, 120_000);
        return proc.addSession(ref, result, key);
      } catch (error) {
        if (method === 'session/resume' && error instanceof AcpRpcError && error.kind === 'remote' && error.rpcCode === METHOD_NOT_FOUND && methods.length > 1) continue;
        if (key) this.proxy.drop(key);
        if (error instanceof AcpRpcError && error.kind === 'remote' && !isAuthError(error)) return ended();
        return { text: '', ...failure(error, name) };
      }
    }
    if (key) this.proxy.drop(key);
    return ended();
  }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    let proc: AcpProcess;
    try { proc = await this.process(input.account); }
    catch (error) { return { text: '', stop: 'error', error: ERR.unavailable(error instanceof StartFailure ? error.message : `${input.account.label} could not start.`) }; }
    const ref = input.session?.ref;
    let session = ref ? proc.sessions.get(ref) : undefined;
    const fresh = !ref;
    if (!session) {
      const opened = ref ? await this.reopen(proc, ref, input) : await this.open(proc, input);
      // C4: "Stop all work" may end the process while a stopped turn still opens its session – a stop, not an account failure.
      if ('stop' in opened) return input.signal.aborted ? { text: '', stop: 'interrupted', error: ERR.cancelled() } : opened;
      session = opened;
      this.remember(input.account, proc, session.config);
    }
    if (session.proxyKey) this.proxy.bind(session.proxyKey, input.mcp);
    const { stable, volatile } = input.system;
    const context = fresh
      ? [stable && `<workforce-instructions>\n${stable}\n</workforce-instructions>`, volatile && `<workforce-context>\n${volatile}\n</workforce-context>`].filter(Boolean).join('\n\n')
      : volatile.trim() ? `<workforce-context>\n${volatile}\n</workforce-context>` : '';
    try {
      return await runAcpTurn({ proc, session, input, context: context || undefined, readFile: this.deps.readFile ?? ((file) => fsp.readFile(file)), resumed: !fresh, cancelGraceMs: this.deps.cancelGraceMs });
    } finally {
      if (session.proxyKey) this.proxy.bind(session.proxyKey, undefined);
    }
  }

  /**
   * Live test C4 ("Stop all work", agents/work-stop.ts): every started agent process ends with its whole tree, so a shell
   * child it left running in the background ends too (ACP has no per-command stop). The next turn starts the agent again
   * and reopens its session by id, as after an idle shutdown. A process still starting is left alone (it ran nothing yet).
   */
  async stopBackground(): Promise<number> {
    let ended = 0;
    for (const pending of [...this.processes.values()]) {
      const proc = await Promise.race([pending, Promise.resolve(undefined)]).catch(() => undefined);
      if (proc?.running) { await proc.dispose(); ended++; }
    }
    return ended;
  }

  /** Stops agents idle for 10 min (each also self-times; this is the registry's sweep hook). */
  async disposeIdle(now = this.now()): Promise<void> {
    for (const pending of [...this.processes.values()]) {
      const proc = await pending.catch(() => undefined);
      if (proc?.running && proc.idle(now)) await proc.dispose();
    }
  }

  async dispose(): Promise<void> {
    const started = await Promise.allSettled([...this.processes.values()]);
    this.processes.clear();
    await Promise.all(started.map((s) => (s.status === 'fulfilled' ? s.value.dispose() : undefined)));
    this.proxy.close();
  }
}
