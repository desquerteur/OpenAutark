// Codex engine: persistent threads on one app-server per account home.
// Owns: server pool per account (B-057: one setup per account at a time), thread start/resume with our dynamic tools and instructions,
// the volatile context block on reused/resumed threads, steer, model list and account check (their
// requests in reads.ts; limits with banked resets – credit details only when asked, limits-read.ts)
// and the reset redemption (B-044).
// A thread the server refuses to resume is reported as ended (details.rebase): the executor
// renews the session (compaction + new thread with the full projection) – so does a loaded thread
// whose turn now runs in another folder (Codex keeps the cwd a thread was opened with, e.g. a task
// worktree removed since; I02), marked `details.folder` for a quiet renewal. Every start/resume opens
// read-only with the workspace marked untrusted (isolation.ts: no project config or AGENTS.md from the
// workspace, the safe git env in every shell); an agent's turn outside the server's folder then runs with
// full access and approval policy 'never' (turnAccess).
// A helper turn (no tools, no hub, no session) runs on an ephemeral thread, unloaded after the turn,
// made lean (helper-thread.ts: no environment, no built-in Codex tools or context blocks – LEAN 23.10.).
// B-074/B-075: a thread (helper or agent, start or resume) not opened in time is the turn's own timeout (no account cools, a chat retries it); its signal ends the open.
// B-049 F1: an agent thread opens lean too (start and resume: helper-thread.ts openAgentThread – the
// shell and patch tools kept, Codex's other tools and instruction blocks off; today's settings when refused).
// D5: an agent turn asks for reasoning summaries (turn/start `summary: 'auto'`), a helper turn for none.
// LEAN: warm() says whether an account's server is up, prewarm() starts it ahead of a likely helper
// call (spawn + initialize + one lean thread without a turn; it idles out as usual).
// B-049 F7: every agent turn's result names its Codex turn id (session.turn, recorded per run by the executor).
// B-049 F9: a new agent thread asks for raw Responses items (code mode's exec calls, code-mode.ts) – a server that
// refuses the field is remembered per process (helper-thread.ts).
// B-057 (fork.ts): fork() copies a parent thread of the account into a new thread (thread/fork), loaded with the split's
// folder and not fresh – its first turn gets the context block (the split's identity) like any resumed thread.
// Live test C4: background commands are the agents' own; the emergency stop ends those of every loaded thread
// (stopBackground), and a thread nobody resumes leaves with its own (terminals.ts dropThread: a released split – unload –,
// a thread renewed for B-047 D1, a helper thread), a deleted one too.
// Native rebuild (rebuild.ts): rebuild() starts a thread with the turn's settings and dynamic tools and injects the ledger's
// history; its first turn sends no context block (the thread has this turn's instructions) and a refused first turn is reported as
// ended (details.rebuild 'failed'); with `revert` it keeps the bound thread, cut before a recorded turn, and injects only the tail;
// probeRebuild() is the model-free probe per version. input.trace goes in as real function_call + output pairs before the turn (a
// refusal: a tool-call-shaped block in the input, result.traceAsText).
// H1 (app-note.ts): a thread this process opened (start, resume, fork) is due for the app note, so is one Codex compacted;
// its next agent turn carries the note (after Codex's own multi-agent note), and once that turn started it is no longer due.
// Never: reads token files, migrates a running turn between accounts, keeps session state that
// a restart would lose, writes helper turns into the account's Codex history, or decides approvals.

import { promises as fsp } from 'node:fs';
import type { Account, AccountLimits, EngineId } from '../../../shared/model/providers.ts';
import type { AccountCheck, Engine, EngineCaps, EngineForkInput, EngineForkResult, EngineModel, EngineRebuildInput, EngineRebuildResult, EngineTurnInput, EngineTurnResult, RebuildProbe } from '../types.ts';
import { injectTrace, probeCodexRebuild, responseItems, revertThread, startRebuiltThread } from './rebuild.ts';
import { rebuiltTurnFailed } from '../rebuild-text.ts';
import { traceInput } from '../trace-text.ts';
import { hasTrace, type TraceCall } from '../../../shared/model/subconscious.ts';
import { forkParams, forkThread } from './fork.ts'; // B-057
import type { Supervisor } from '../../system/supervisor.ts';
import type { ExecutableFinder } from '../../accounts/executables.ts';
import { CodexServer, pickAgain } from './server.ts';
import { RpcError, type RpcClient } from './rpc.ts';
import { runCodexTurn, retryAfterFrom, type TurnControl } from './turn.ts';
import { dropThread } from './terminals.ts'; // L3 / C4: a thread nobody resumes leaves with its background commands
import { threadIsolation, trustKeys, turnAccess } from './isolation.ts';
import { imageThread, openAgentThread, startHelperThread, untilStopped } from './helper-thread.ts';
import { ERR, ToolNames, nearestEffort, sameFolder, str } from '../shared.ts';
import { normalizeCodexLimits } from '../../accounts/limits.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { consumeResetCredit } from './reset-credit.ts';
import type { PlainReads } from './limits-read.ts';
import { listCodexModels, readCodexAccount } from './reads.ts';
import { appNote } from './app-note.ts'; // H1

/** RpcClient's code for "codex did not answer" (a timeout, not a refusal). */
const RPC_TIMEOUT = -32000;
/** JSON-RPC "method not found". */
const RPC_NO_METHOD = -32601;

/** Wave 2: `thread/delete` refused because the thread itself is gone – not because this Codex lacks the method. */
export function threadGone(error: RpcError): boolean {
  if (error.rpcCode === RPC_TIMEOUT || error.rpcCode === RPC_NO_METHOD) return false;
  if (/method not found|unknown (variant|method|request)|unsupported/i.test(error.message)) return false;
  return /\bthread\b[^\n]{0,80}\b(not found|does not exist|unknown|missing)\b|\b(no such|unknown) thread\b/i.test(error.message);
}

/** Our tools as Codex dynamic tools (wire names, as at thread/start). */
function dynamicTools(tools: EngineTurnInput['tools'], names: ToolNames): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ type: 'function', name: names.wire(tool.name), description: tool.description, inputSchema: tool.inputSchema }));
}

export interface CodexEngineDeps {
  supervisor: Supervisor;
  finder: ExecutableFinder;
  cwd: string; // the server process's own empty folder (system/paths.ts engineCwd); threads get their own cwd, never this one
  version: string;
  now?: () => number;
  idleMs?: number;
  /** Account-level limit pushes (also outside turns) → AccountService.updateLimits. */
  onLimits?: (accountId: string, limits: AccountLimits) => void;
  env?: NodeJS.ProcessEnv;
  /** The real path of a thread's cwd (one more spelling to mark untrusted); default fs.realpath. */
  realpath?: (dir: string) => Promise<string>;
  /** Variables every agent shell gets (I02: gitSafeEnv; applied after Codex's KEY/SECRET/TOKEN excludes). */
  shellEnv?: Record<string, string>;
}

export class CodexEngine implements Engine {
  readonly id: EngineId = 'codex';
  readonly caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: true, images: true, rebase: true, structured: true, ownTools: true, fork: true, rebuild: true, revert: true, trace: true };
  private readonly deps: CodexEngineDeps;
  private readonly now: () => number;
  private readonly servers = new Map<string, CodexServer>();
  private readonly loaded = new Map<string, Map<string, string>>(); // account → thread id → its cwd, for threads loaded in its current process
  private readonly efforts = new Map<string, string[]>(); // model → supported efforts (from model/list)
  private readonly running = new Map<string, TurnControl>(); // runId → control (steer)
  private readonly watchers = new Map<string, Set<(limits: AccountLimits, raw: unknown) => void>>();
  private readonly lastLimits = new Map<string, unknown>();
  private readonly warming = new Map<string, Promise<void>>(); // account → its running prewarm
  private readonly creating = new Map<string, Promise<CodexServer>>(); // B-057: account → its server being set up (concurrent first turns share it)
  private readonly leanRefused = new Set<string>(); // accounts whose running server refused the lean helper thread
  private readonly agentLeanRefused = new Set<string>(); // B-049 F1: accounts whose running server refused the lean agent thread
  private readonly rawRefused = new Set<string>(); // B-049 F9: accounts whose running server refused experimentalRawEvents
  private readonly plainReads: PlainReads = { value: false }; // this Codex refused excludeResetCreditDetails
  private readonly noteDue = new Set<string>(); // H1: threads whose next agent turn carries the app note (app-note.ts)
  private readonly fresh = new Set<string>(); // rebuilt threads before their first turn
  private readonly cut = new Set<string>(); // threads that lost their tail in a failed revert: they cannot continue
  constructor(deps: CodexEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** The account's server; B-057: concurrent first calls share one setup, so a cold account never gets two app-servers. */
  private server(account: Account): Promise<CodexServer> {
    const known = this.servers.get(account.id);
    if (known) return Promise.resolve(known);
    const pending = this.creating.get(account.id);
    if (pending) return pending;
    const work = this.createServer(account).finally(() => this.creating.delete(account.id));
    this.creating.set(account.id, work);
    return work;
  }

  private async createServer(account: Account): Promise<CodexServer> {
    let server = this.servers.get(account.id);
    if (!server) {
      const executable = await this.deps.finder.find('codex');
      if (!executable) throw Object.assign(new Error('Codex is not installed.'), { code: 'unavailable' });
      server = new CodexServer({
        key: account.id, home: account.home, executable, supervisor: this.deps.supervisor, cwd: this.deps.cwd,
        version: this.deps.version, idleMs: this.deps.idleMs, env: this.deps.env,
        onLimits: (params) => this.limitsPushed(account.id, params),
        onExit: () => { this.loaded.delete(account.id); this.leanRefused.delete(account.id); this.agentLeanRefused.delete(account.id); this.rawRefused.delete(account.id); },
      });
      this.servers.set(account.id, server);
    }
    return server;
  }

  private limitsPushed(accountId: string, params: Record<string, unknown>): void {
    this.lastLimits.set(accountId, params.rateLimits);
    const limits = normalizeCodexLimits(params, this.now());
    if (!limits) return;
    this.deps.onLimits?.(accountId, limits);
    for (const watcher of this.watchers.get(accountId) ?? []) watcher(limits, params.rateLimits);
  }

  async listModels(account: Account): Promise<EngineModel[]> {
    const rpc = await (await this.server(account)).rpc();
    return listCodexModels(rpc, this.efforts);
  }

  async checkAccount(account: Account, options: { details?: boolean } = {}): Promise<AccountCheck> {
    let rpc;
    try { rpc = await (await this.server(account)).rpc(); }
    catch { return { state: 'error', message: 'Codex is not installed or could not start.' }; }
    return readCodexAccount(rpc, { details: options.details === true, plain: this.plainReads, now: this.now, seen: (raw) => this.lastLimits.set(account.id, raw) });
  }

  /** B-044: redeems one banked reset (reset-credit.ts – key per attempt, outcome as sent); a Codex that cannot start refuses with 'unavailable'. */
  async consumeReset(account: Account, idempotencyKey: string, creditId?: string): Promise<unknown> {
    let rpc;
    try { rpc = await (await this.server(account)).rpc(); }
    catch { throw new WorkforceError('unavailable', 'Codex is not installed or could not start.'); } // nothing was sent
    return consumeResetCredit(rpc, idempotencyKey, creditId);
  }

  async steer(runId: string, text: string): Promise<boolean> {
    const control = this.running.get(runId);
    if (!control?.turnId) return false;
    try {
      await control.rpc.request('turn/steer', { threadId: control.threadId, expectedTurnId: control.turnId, input: [{ type: 'text', text, text_elements: [] }] });
      return true;
    } catch { return false; }
  }

  async tell(runId: string, call: TraceCall): Promise<boolean> { const control = this.running.get(runId); return control?.turnId ? (await injectTrace(control.rpc, control.threadId, [call], `${runId}_${Date.now()}`)) === undefined : false; }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    let server: CodexServer;
    let rpc;
    try {
      server = await this.server(input.account);
      rpc = await server.rpc();
    } catch {
      return { text: '', stop: 'error', error: ERR.unavailable('Codex is not installed or could not start.') };
    }
    const names = new ToolNames(input.tools);
    const supported = this.efforts.get(input.model) ?? [];
    const effort = supported.length ? nearestEffort(input.effort, supported) : input.effort === 'max' ? 'xhigh' : input.effort;
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    const threadSettings = await this.settings(input);
    let threadId: string;
    const generation = input.session?.generation ?? 1;
    const ref = input.session?.ref;
    // A runtime helper turn (decision, verifier, compaction … – no tools, no hub, never resumed) runs on an ephemeral thread: nothing lands in
    // the account's Codex history (like Claude Code's --no-session-persistence), and the thread is unloaded after the turn (thread/unsubscribe).
    // LEAN: that thread has no environment and none of Codex's own tools or context blocks (helper-thread.ts).
    const helper = !ref && !input.mcp && input.tools.length === 0;
    const open = untilStopped(rpc, input.signal); // B-075: the turn's signal (a Stop, a helper call's time limit) also ends the open
    try {
      if (ref) {
        threadId = ref;
        if (this.cut.delete(threadId)) return { text: '', stop: 'error', error: { code: 'conflict', message: 'Codex could not continue this session.', details: { rebase: true } } };
        if (!loaded.has(threadId)) {
          // After a process restart the thread must be resumed (dynamic tools persist with it: live 23.10., codex 0.163 – e2e/runtime-real-restart).
          try {
            await openAgentThread(open, 'thread/resume', { threadId, ...threadSettings }, this.agentLeanRefused, input.account.id);
          } catch (error) {
            // The server answered with an error (not a timeout): this thread cannot continue.
            if (error instanceof RpcError && error.rpcCode !== RPC_TIMEOUT) return { text: '', stop: 'error', error: { code: 'conflict', message: 'Codex could not resume this session.', details: { rebase: true } } };
            throw error;
          }
          loaded.set(threadId, input.cwd);
          this.noteDue.add(threadId); // H1: Codex may set its own note again on a resume
        } else if (!sameFolder(loaded.get(threadId)!, input.cwd)) {
          // A loaded thread keeps the cwd it was opened with (e.g. a task worktree that is gone now):
          // renew the session – `folder` makes it the executor's quiet folder renewal (agents/turn.ts).
          return { text: '', stop: 'error', error: ERR.folder('Codex') };
        }
      } else {
        const opened = { ...threadSettings, dynamicTools: dynamicTools(input.tools, names) };
        const start = input.nativeTools === 'image' ? imageThread(opened) : opened; // B-058 i1: the plan-image thread (helper-thread.ts)
        const started = helper
          ? await startHelperThread(open, start, this.leanRefused, input.account.id)
          : await openAgentThread<{ thread?: { id?: string } }>(open, 'thread/start', start, this.agentLeanRefused, input.account.id, this.rawRefused);
        const id = str(started?.thread?.id);
        if (!id) return { text: '', stop: 'error', error: ERR.failed('Codex did not start a session.') };
        threadId = id;
        if (!helper) { loaded.set(threadId, input.cwd); this.noteDue.add(threadId); }
      }
    } catch (error) {
      if (input.signal.aborted) return { text: '', stop: 'interrupted', error: ERR.cancelled() }; // as a turn stopped while it opened (turn.ts)
      if (error instanceof RpcError && error.rpcCode === RPC_TIMEOUT) return { text: '', stop: 'error', error: { ...ERR.timeout(), message: 'Codex did not open the session in time.' } };
      return { text: '', stop: 'error', error: ERR.unavailable('Codex could not open the session.') };
    }
    const control: TurnControl = { threadId, rpc };
    this.running.set(input.runId, control);
    const watcher = (limits: AccountLimits) => { try { input.onEvent({ type: 'limits', limits }); } catch { /* isolate */ } };
    const set = this.watchers.get(input.account.id) ?? new Set();
    set.add(watcher);
    this.watchers.set(input.account.id, set);
    try {
      const refused = hasTrace(input.trace) ? await injectTrace(rpc, threadId, input.trace.calls, input.runId) : undefined;
      // A reused or resumed thread has its instructions from an earlier turn: the current volatile
      // context (time, task) travels as a block in front of the turn input – not on a rebuilt thread's first turn.
      const rebuilt = ref ? this.fresh.delete(threadId) : false;
      let result: EngineTurnResult = await runCodexTurn({
        server, rpc, threadId, input: refused ? { ...input, input: [traceInput(input.trace!.calls), ...input.input] } : input,
        effort, names, control, now: this.now, context: ref && !rebuilt ? input.system.volatile : undefined,
        access: turnAccess(input, this.deps.cwd),
        summary: helper ? 'none' : 'auto', // D5: an agent turn shows its reasoning summaries; a helper turn pays for none
        note: this.noteDue.has(threadId) ? appNote(input.tools) : undefined, helper, // H1; a silent helper turn is cut (turn.ts HELPER_SILENT_MS)
      });
      if (control.turnId) this.noteDue.delete(threadId); // H1: the note went with a started turn
      if (result.error?.details?.codeHost) await pickAgain(this.deps.finder, this.servers.values());
      if (result.compacted && !helper) this.noteDue.add(threadId); // H1: Codex's compacted history carries its own note again
      if (!helper) result.session = { ref: threadId, generation, ...(control.turnId ? { turn: control.turnId } : {}) }; // B-049 F7: the turn id per run
      else delete result.session;
      if (refused) result.traceAsText = refused;
      if (rebuilt && !control.turnId && result.stop === 'interrupted') this.fresh.add(threadId); // stopped before its first turn: still un-run
      else if (rebuilt) result = rebuiltTurnFailed(result);
      if (result.stop === 'limit' && result.error && result.error.retryAfterMs === undefined) {
        result.error.retryAfterMs = retryAfterFrom(this.lastLimits.get(input.account.id), this.now());
      }
      return result;
    } finally {
      set.delete(watcher);
      this.running.delete(input.runId);
      if (helper) void dropThread(rpc, threadId); // nobody resumes a helper thread – nothing of it keeps running
    }
  }

  /** A thread's settings: model, cwd, instructions; read-only and untrusted on open (runCodexTurn gives each turn its own sandbox). */
  private async settings(input: { model?: string; cwd: string; system?: { stable: string; volatile: string }; agentId?: string }): Promise<{ config?: Record<string, unknown>; developerInstructions?: string } & Record<string, unknown>> {
    const real = await (this.deps.realpath ?? fsp.realpath)(input.cwd).catch(() => undefined);
    return {
      ...(input.model ? { model: input.model } : {}), cwd: input.cwd,
      ...(input.system ? { baseInstructions: input.system.stable, developerInstructions: input.system.volatile } : {}),
      approvalPolicy: 'never', ...threadIsolation(trustKeys(input.cwd, real), this.deps.shellEnv, input.agentId), // AF-001: agentId – the thread's wf identity
    };
  }

  /** A new thread with the coming turn's settings and dynamic tools, holding the ledger's history (rebuild.ts); deleted again when the injection fails. */
  async rebuild(input: EngineRebuildInput): Promise<EngineRebuildResult> {
    const rpc = await (await this.server(input.account)).rpc();
    const items = responseItems(input.items, { offered: new Set(input.tools.map((tool) => tool.name)), accountId: input.account.id, model: input.model, custom: input.probe?.custom === true });
    if (!items.length) throw new Error('nothing to rebuild');
    if (input.revert) return this.revert(rpc, input, input.revert, items);
    const start = { ...await this.settings(input), dynamicTools: dynamicTools(input.tools, new ToolNames(input.tools)) };
    const open = (params: Record<string, unknown>) => openAgentThread<{ thread?: { id?: string } }>(rpc, 'thread/start', params, this.agentLeanRefused, input.account.id, this.rawRefused);
    const threadId = await startRebuiltThread(rpc, start, items, input.probe?.verify, open);
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    loaded.set(threadId, input.cwd);
    this.fresh.add(threadId);
    this.noteDue.add(threadId); // H1
    return { ref: threadId, generation: input.generation, items: items.length };
  }

  /**
   * Keeps the bound thread – resumed when this process has not loaded it, never one open in another folder – cut before the
   * recorded turn, with the tail injected (rebuild.ts revertThread). Not fresh: it keeps the instructions it opened with, so its
   * next turn gets the context block. A thread whose tail could not be injected ends at its next turn, should the fallback not replace it.
   */
  private async revert(rpc: RpcClient, input: EngineRebuildInput, revert: { ref: string; beforeTurn: string }, items: Array<Record<string, unknown>>): Promise<EngineRebuildResult> {
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    const open = loaded.get(revert.ref);
    if (open !== undefined && !sameFolder(open, input.cwd)) throw new Error('the session runs in another folder');
    if (open === undefined) {
      await openAgentThread(rpc, 'thread/resume', { threadId: revert.ref, ...await this.settings(input) }, this.agentLeanRefused, input.account.id);
      loaded.set(revert.ref, input.cwd);
      this.noteDue.add(revert.ref); // H1
    }
    try { await revertThread(rpc, revert.ref, revert.beforeTurn, items, input.probe?.verify); } catch (error) {
      if ((error as { cut?: boolean }).cut) this.cut.add(revert.ref);
      throw error;
    }
    return { ref: revert.ref, generation: input.generation, items: items.length };
  }

  /** The running Codex's version (initialize's userAgent; the server starts if needed). */
  async rebuildVersion(account: Account): Promise<string | undefined> {
    const server = await this.server(account);
    await server.rpc();
    return server.cliVersion;
  }

  /** The model-free probe (rebuild.ts probeCodexRebuild) in `cwd`, read-only like every opened thread. */
  async probeRebuild(account: Account, cwd: string): Promise<RebuildProbe> {
    const version = (await this.rebuildVersion(account).catch(() => undefined)) ?? 'unknown';
    const rpc = await (await this.server(account)).rpc();
    return probeCodexRebuild(rpc, await this.settings({ cwd }), version, this.now());
  }

  /** B-057 (fork.ts): the parent thread copied into a new one (thread/fork, lean), loaded with the split's folder – not fresh. */
  async fork(input: EngineForkInput): Promise<EngineForkResult> {
    const rpc = await (await this.server(input.account)).rpc();
    const loaded = this.loaded.get(input.account.id) ?? new Map<string, string>();
    this.loaded.set(input.account.id, loaded);
    const cwd = input.cwd ?? loaded.get(input.parentRef);
    if (!cwd) throw new Error('the folder of the forked session is unknown');
    const params = forkParams(input, await this.settings({ model: input.model, cwd, agentId: input.agentId }));
    const ref = await forkThread(params, (fork) => openAgentThread<{ thread?: { id?: string } }>(rpc, 'thread/fork', fork, this.agentLeanRefused, input.account.id));
    loaded.set(ref, cwd);
    this.noteDue.add(ref); // H1: Codex sets its own note again in a fork, after the parent's history
    return { ref, generation: 1 };
  }

  /**
   * Wave 2 (privacy): deletes a thread this app started, with the app-server's own `thread/delete`
   * (official protocol schema of the installed Codex; not marked experimental). Only an answer about
   * the thread itself ("thread … not found", "no such thread") counts as gone; a Codex without the
   * method (-32601, "method not found", "unknown variant …"), a timeout or another refusal throws, so
   * the row ends 'failed' and stays named as a remaining copy instead of being reported deleted.
   */
  async deleteSession(account: Account, ref: string): Promise<'deleted' | 'missing'> {
    const rpc = await (await this.server(account)).rpc();
    // C4: a deleted thread still loaded here leaves nothing running in the background (a refusal is ignored).
    if (this.loaded.get(account.id)?.has(ref)) await rpc.request('thread/backgroundTerminals/clean', { threadId: ref }, 5_000).catch(() => undefined);
    try {
      await rpc.request('thread/delete', { threadId: ref }, 30_000);
    } catch (error) {
      if (error instanceof RpcError && threadGone(error)) return 'missing';
      throw error;
    }
    this.loaded.get(account.id)?.delete(ref);
    this.noteDue.delete(ref);
    this.fresh.delete(ref);
    return 'deleted';
  }

  /** B-057 (splits/release.ts): a released split thread leaves the running app-server's memory (thread/unsubscribe, like a helper thread); its rollout stays for the session sweep's thread/delete. */
  async unload(account: Account, ref: string): Promise<void> {
    this.noteDue.delete(ref);
    if (!this.loaded.get(account.id)?.delete(ref)) return; // not loaded here: nothing in memory
    const rpc = this.servers.get(account.id)?.current; // C4: the open connection only – never a (re)start for this
    if (!rpc) return;
    // Live test L3: its background terminals (code mode's exec_command with a yield) outlive a stopped turn and the
    // unsubscribe – nobody resumes a released split, so what it started ends with it (terminals.ts dropThread).
    await dropThread(rpc, ref);
  }

  /**
   * Live test C4: the person's "Stop all work" (agents/work-stop.ts) – every background command a loaded thread left running
   * ends (`thread/backgroundTerminals/clean` per thread, also those of finished turns: an emergency brake keeps nothing
   * running). Only running servers; never starts or restarts one. Resolves to the threads Codex cleaned; refusals are ignored.
   */
  async stopBackground(): Promise<number> {
    const cleaned = await Promise.all([...this.loaded].flatMap(([accountId, threads]) => {
      const rpc = this.servers.get(accountId)?.current;
      return rpc ? [...threads.keys()].map((ref) => rpc.request('thread/backgroundTerminals/clean', { threadId: ref }, 5_000).then(() => true, () => false)) : [];
    }));
    return cleaned.filter(Boolean).length;
  }

  /** LEAN: this account's app-server is up – a helper thread starts in well under a second instead of after a process start. */
  warm(account: Account): boolean {
    return this.servers.get(account.id)?.running === true;
  }

  /**
   * LEAN: starts this account's app-server ahead of a likely helper call: spawn, initialize and one lean
   * ephemeral thread without a turn (a fresh server's first thread pays Codex's own start work – no
   * model call, nothing in the history), unloaded right away. A running server is left as it is; the
   * started one idles out like any other (10 min without turns). Concurrent calls share one start.
   */
  prewarm(account: Account): Promise<void> {
    const pending = this.warming.get(account.id);
    if (pending) return pending;
    if (this.warm(account)) return Promise.resolve();
    const work = (async () => {
      const rpc = await (await this.server(account)).rpc();
      const cwd = this.deps.cwd;
      const real = await (this.deps.realpath ?? fsp.realpath)(cwd).catch(() => undefined);
      const started = await startHelperThread(rpc, {
        cwd, approvalPolicy: 'never', ...threadIsolation(trustKeys(cwd, real), this.deps.shellEnv),
      }, this.leanRefused, account.id);
      const id = str(started?.thread?.id);
      if (id) await rpc.request('thread/unsubscribe', { threadId: id }).catch(() => undefined);
    })().finally(() => this.warming.delete(account.id));
    this.warming.set(account.id, work);
    return work;
  }

  /** Stops servers idle for 10 min (also self-timed; this is the registry's sweep hook). */
  async disposeIdle(now = this.now()): Promise<void> {
    for (const [id, server] of this.servers) {
      if (server.running && server.idle(now)) { await server.dispose(); this.loaded.delete(id); }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.dispose()));
    this.servers.clear();
    this.loaded.clear();
    this.noteDue.clear();
  }
}
