// Claude Code engine: one `claude -p` stream-json process per active turn.
// Owns: command line (session id/resume, model, effort, system prompt, MCP hub config,
// bypassPermissions), the stream → events mapping, interrupt/steer through stdin (a turn with
// steered lines ends its input at the first result and waits for their answers or the CLI's end), limits,
// the reported context window and the answer (every main-thread text block, parser.answer()). A session Claude Code cannot find any more is reported as ended
// (details.rebase): the executor renews it (compaction + new session with the full projection).
// Claude Code keeps a session per working folder, so a session this process ran in another folder
// (e.g. before a task worktree) is renewed before the CLI starts, quietly (details.folder, like Codex).
// Models: the CLI's own list from the status probe (`initialize`, cached 5 min per account, see
// models.ts) with the context windows `result.modelUsage` reported in this account's turns; the
// last good list when a probe does not answer (and an error, so the catalog keeps its listing,
// when there is none yet); CLAUDE_MODELS when the CLI is missing or cannot list models. A 1M
// variant's catalog id `<id>-1m` runs as `--model <id>[1m]` (cliModel).
//
// Agent turns run with `--permission-mode bypassPermissions`: Claude Code never asks before its own tools.
// Login guard 03.11.: a turn's CLI is never hard-killed when the turn ends or is stopped (it may be saving a refreshed
// sign-in): its stdin closes and it ends by itself; its tree is killed only after the grace (CLAUDE_EXIT_GRACE_MS). A
// stopped turn still returns after 3 s at the latest; what the CLI prints after the turn returned is dropped.
//
// Project config: a turn runs with cwd = the workspace (file tools work there as usual) but loads
// only the account's user settings (`--setting-sources user`, USER_SETTINGS_ONLY in status.ts) and
// only our MCP config (`--strict-mcp-config` in both branches); the prompt and MCP files live in temp.
// The CLI's own cron scheduler is off (NO_CLI_CRON: no prompts from `.claude/scheduled_tasks.json`).
// A turn without the hub and without tools (the runtime's helper turns) passes
// `--no-session-persistence` like the status probe (no transcript on disk) and, when it has no
// output schema, `--tools ''`, so Claude Code's own tools – also
// those that never prompt – are off.
//
// Native rebuild (rebuild.ts, transcript.ts): rebuild() writes the ledger's history as a fresh transcript; the next turn resumes it by
// its path (or by id in the app's own project folder); a first turn refused is reported as ended (details.rebuild 'failed').
// input.trace goes in as real tool_use + tool_result records before the resume (rebuilder.ts injectTrace; when that fails: a
// tool-call-shaped block in the input, result.traceAsText).
// deleteSession() deletes superseded sessions the app created: for a path ref our transcript, for an id ref the CLI's
// transcript of that session id (rebuild.ts, found by listing folder names).
// Agent turns ask for summarized thinking (`--thinking-display summarized`, 2.1.303 on) so reasoning can be shown.
// B-049 F2 (lean.ts): an agent turn (hub or tools, no output schema) runs with our system prompt only
// (`--system-prompt-file`), built-in tools cut to Bash/Read/Edit/Write/Glob/Grep (+ PowerShell on Windows),
// no skills/slash commands, no hooks, no CLAUDE.md/auto memory/git workflow text, the hub's tools upfront;
// a CLI that refuses those flags gets today's arguments (appended prompt) for the rest of the process.
// Helper turns run with our system prompt only as well and without any built-in tool (helperPromptArgs; `--json-schema` keeps its answer tool).
// B-057 (fork.ts): fork() reserves a split's forked session; its first turn adds `--resume <parent> --fork-session
// --session-id <new>` (a pending fork is the one piece of session state a restart loses: that turn then renews).
// Never: reads CLAUDE_CONFIG_DIR files or tokens but the transcript of a session the app created (it writes there only a rebuilt
// transcript in the app's own home and that transcript's trace records, and deletes there only transcripts of sessions the app created); never passes API keys in the env (they would
// silently override the user's subscription login); keeps session state a restart would lose;
// never lets project-level config in the workspace (.claude/settings*.json, .mcp.json, project
// skills/agents/commands) add permissions, hooks, plugins or MCP servers to a turn.

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { Account, EngineId } from '../../../shared/model/providers.ts';
import type { AccountCheck, Engine, EngineCaps, EngineForkInput, EngineForkResult, EngineModel, EngineRebuildInput, EngineRebuildResult, EngineTurnInput, EngineTurnResult, RebuildProbe } from '../types.ts';
import { hasTrace } from '../../../shared/model/subconscious.ts';
import { rebuiltTurnFailed } from '../rebuild-text.ts';
import { traceInput } from '../trace-text.ts';
import type { Supervisor, Lease } from '../../system/supervisor.ts';
import type { ExecutableFinder } from '../../accounts/executables.ts';
import { CLAUDE_EXIT_GRACE_MS } from '../../accounts/cli.ts';
import { ClaudeStatus, USER_SETTINGS_ONLY } from './status.ts';
import { ClaudeStreamParser, HUB_SERVER } from './stream.ts';
import { claudeModels, cliModel, rememberWindows } from './models.ts';
import { ERR, isRecord, readJsonLines, sameFolder } from '../shared.ts';
import { purgeHistories } from './purge.ts';
import { claudeDown, providerDownMessage } from '../provider-outage.ts'; // B-059 #184
import { ClaudeForks } from './fork.ts'; // B-057
import { ClaudeRebuilder } from './rebuilder.ts';
import { LEAN_ENV, LeanMemory, helperPromptArgs, hubConfig, promptArgs, promptText } from './lean.ts';
import { agentIdentityEnv } from '../agent-token.ts'; // AF-001

export { CLAUDE_MODELS } from './models.ts';

/** One CLI process of a turn (B-049 F2: a lean start may be retried today's way). */
interface Attempt { parser: ClaudeStreamParser; broken: boolean; interrupted: boolean; quiet: boolean }

/** Claude Code's answer to --resume with an id it no longer has (2.1.303: `errors: ["No conversation found with session ID: …"]`, verified live 23.10.). */
const MISSING_SESSION = /no conversation found|session .*not found/i;
/** Session folders remembered per process (the oldest is dropped beyond this). */
const MAX_FOLDERS = 500;

export interface FileOps {
  writeFile(file: string, data: string): Promise<void>;
  readFile(file: string): Promise<Uint8Array>;
  rm(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  /** B-048 (rebuilder.ts): folder removal, file size and sub-folder names; the disk when not given. */
  rmDir?(dir: string): Promise<void>;
  size?(file: string): Promise<number | undefined>;
  folders?(dir: string): Promise<string[]>;
  tail?(file: string, maxBytes: number): Promise<string | undefined>;
  append?(file: string, data: string): Promise<void>;
}

const nodeFiles: FileOps = {
  writeFile: (file, data) => fsp.writeFile(file, data, { mode: 0o600 }),
  readFile: (file) => fsp.readFile(file),
  rm: (file) => fsp.rm(file, { force: true }),
  mkdir: async (dir) => { await fsp.mkdir(dir, { recursive: true }); },
};

export interface ClaudeEngineDeps {
  supervisor: Supervisor;
  finder: ExecutableFinder;
  tempDir: string;
  now?: () => number;
  files?: FileOps;
  env?: NodeJS.ProcessEnv;
  uuid?: () => string;
  /** B-048: <data>/engine-transcripts/claude – rebuilt transcripts (default: <tempDir>/engine-transcripts/claude). */
  transcriptsDir?: string;
  /** B-048: <data>/accounts – the app's own isolated homes (the only ones the 'project' tier writes into). */
  accountsRoot?: string;
  /** Login guard 03.11.: how long an ended or stopped CLI may take to exit by itself before its tree is killed (CLAUDE_EXIT_GRACE_MS). */
  graceMs?: number;
}

export class ClaudeEngine implements Engine {
  readonly id: EngineId = 'claude';
  readonly caps: EngineCaps = { sessions: true, dynamicTools: false, mcp: true, images: true, rebase: true, structured: true, ownTools: true, fork: true, rebuild: true, trace: true };
  private readonly deps: ClaudeEngineDeps;
  private readonly files: FileOps;
  private readonly rebuilds: ClaudeRebuilder; // session refs, CLI version, delete (rebuilder.ts)
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly status: ClaudeStatus;
  private readonly running = new Map<string, Lease>();
  /** runId → user lines steered into the running turn (17:09): the turn ends only once each was answered or the CLI ended. */
  private readonly steered = new Map<string, number>();
  private readonly windows = new Map<string, Map<string, number>>(); // account id → model → window from modelUsage
  private readonly noEffort = new Set<string>(); // models the CLI lists without effort support (no --effort)
  private readonly folders = new Map<string, string>(); // session id → the folder its turns ran in (this process)
  /** Wave 2: account id → its running `claude purge`; a turn of that account starts only after it. */
  private readonly purging = new Map<string, Promise<unknown>>();
  private readonly lean = new LeanMemory(); // B-049 F2: whether this process's CLI takes the lean flags (lean.ts)
  private readonly forks = new ClaudeForks({ files: () => this.rebuilds.files, uuid: () => this.uuid() }); // B-057: pending forks (fork.ts)

  constructor(deps: ClaudeEngineDeps) {
    this.deps = deps;
    this.files = deps.files ?? nodeFiles;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.status = new ClaudeStatus({ supervisor: deps.supervisor, tempDir: deps.tempDir, now: this.now, env: deps.env, graceMs: deps.graceMs });
    this.rebuilds = new ClaudeRebuilder({
      supervisor: deps.supervisor, finder: deps.finder, tempDir: deps.tempDir, files: this.files, env: deps.env, envFor: (account) => this.status.envFor(account),
      uuid: this.uuid, now: this.now, transcriptsDir: deps.transcriptsDir, accountsRoot: deps.accountsRoot,
    });
  }

  async listModels(account: Account): Promise<EngineModel[]> {
    const exe = account.state === 'needs_login' ? null : await this.deps.finder.find('claude');
    const probe = exe ? await this.status.probe(exe, account) : undefined;
    // No answer and no earlier list: the static list would drop the CLI's own models (1M variants,
    // legacy ids) and add ones the plan may lack – the catalog keeps its previous listing instead.
    if (probe?.failed && !probe.init) throw new Error('Claude Code did not answer the model list.');
    const models = claudeModels(probe?.init, this.windows.get(account.id));
    for (const m of models) {
      if (m.efforts.length) this.noEffort.delete(m.model);
      else this.noEffort.add(m.model);
    }
    return models;
  }

  async checkAccount(account: Account): Promise<AccountCheck> {
    const exe = await this.deps.finder.find('claude');
    if (!exe) return { state: 'error', message: 'Claude Code is not installed.' };
    try { return await this.status.check(exe, account); }
    catch { return { state: 'error', message: 'Claude Code did not answer the account check.' }; }
  }

  async steer(runId: string, text: string): Promise<boolean> {
    const stdin = this.running.get(runId)?.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false; // the turn already answered: the next turn reads it
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
    this.steered.set(runId, (this.steered.get(runId) ?? 0) + 1);
    return true;
  }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    const exe = await this.deps.finder.find('claude');
    if (!exe) return { text: '', stop: 'error', error: ERR.unavailable('Claude Code is not installed.') };
    let resume = input.session?.ref;
    const ranIn = resume ? this.folders.get(resume) : undefined;
    if (ranIn !== undefined && !sameFolder(ranIn, input.cwd)) return { text: '', stop: 'error', error: ERR.folder('Claude Code') };
    let traceRefused: string | undefined;
    if (hasTrace(input.trace)) {
      if (resume && this.forks.target(resume).fork) traceRefused = 'a forked session has no transcript yet';
      else {
        try { resume = await this.rebuilds.injectTrace(input, resume); } catch (error) { traceRefused = error instanceof Error ? error.message.slice(0, 200) : 'refused'; }
      }
    }
    const generation = input.session?.generation ?? 1;
    const sessionId = resume ?? this.uuid();
    // A transcript-path session resumes from its path (or by id in the app's own project folder); B-057: a fork's first turn its parent.
    const target = resume ? this.forks.target(resume) : undefined;
    const { rebuilt, grownFrom } = await this.rebuilds.before(resume);
    const agentTurn = Boolean(input.mcp || input.tools.length);
    // B-049 F2 (lean.ts): an agent turn runs with our system prompt only and the built-in execution core.
    const lean = (agentTurn ? !input.outputSchema : Boolean(input.system.stable)) && this.lean.allowed();
    await this.files.mkdir(this.deps.tempDir);
    const base = path.join(this.deps.tempDir, `claude-${input.runId}-${this.uuid().slice(0, 8)}`);
    const promptFile = `${base}.prompt.md`;
    const mcpFile = `${base}.mcp.json`;
    const temp = input.mcp ? [promptFile, mcpFile] : [promptFile];
    const argsFor = async (lean: boolean): Promise<string[]> => {
      // Claude Code snapshots the system prompt on a conversation's first request and replays it on
      // resume (`--system-prompt-snapshot on`, the default). So the volatile part goes into the system
      // prompt of a new session only; on resume it travels as a context block in the user message. A rebuilt session's first
      // turn has no snapshot yet: it starts like a new one, so the stable block stays the cached one all sessions share.
      await this.files.writeFile(promptFile, promptText(input.system.stable, resume && !rebuilt ? undefined : input.system.volatile, lean));
      const args = [...exe.prefixArgs, '-p', ...USER_SETTINGS_ONLY, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--model', cliModel(input.model), ...(this.noEffort.has(input.model) ? [] : ['--effort', input.effort === 'none' ? 'low' : input.effort]), ...(agentTurn ? promptArgs(promptFile, lean) : helperPromptArgs(promptFile, lean)),
        ...(agentTurn && this.rebuilds.thinkingDisplay() ? ['--thinking-display', 'summarized'] : [])]; // B-048: reasoning text to show
      if (input.mcp) {
        // File (0600, deleted after the turn) instead of argv: argv is visible to other processes.
        await this.files.writeFile(mcpFile, hubConfig(input.mcp, lean));
        args.push('--mcp-config', mcpFile, '--strict-mcp-config', '--permission-mode', 'bypassPermissions');
      } else {
        args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-prompts', 'none');
        if (input.tools.length === 0) {
          // A runtime helper turn (decision, verifier, compaction) never
          // resumes, so Claude Code keeps no transcript of it (the prompt may hold outside content).
          // Without a schema none of Claude Code's own tools run either, also those that never
          // prompt; today's form keeps the tool list of a schema turn, the lean one has passed --tools '' above.
          if (!resume) args.push('--no-session-persistence');
          if (!input.outputSchema && !lean) args.push('--tools', '');
        }
      }
      if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema));
      args.push(...(target ? ['--resume', target.resume, ...(target.fork ? ['--fork-session', '--session-id', target.fork] : [])] : ['--session-id', sessionId]));
      return args;
    };

    const content = await this.content(traceRefused ? { ...input, input: [traceInput(input.trace!.calls), ...input.input] } : input, resume && !rebuilt ? input.system.volatile : undefined);
    const env = { ...this.status.envFor(input.account), ...LEAN_ENV, ...target?.env, ...(agentTurn ? agentIdentityEnv(input.agentId) : {}) }; // AF-001: the agent's wf identity in its shells
    let ran: Attempt;
    try {
      ran = await this.attempt(exe.command, await argsFor(lean), env, input, content);
      // B-049 F2: a CLI that refused a lean flag ended at once without a line (no model call): once more today's way.
      if (lean && this.lean.afterLean(ran.quiet)) {
        ran = await this.attempt(exe.command, await argsFor(false), env, input, content);
        this.lean.afterRetry(ran.quiet);
      }
    } finally {
      for (const file of temp) await this.files.rm(file).catch(() => {});
    }
    const { parser, broken, interrupted } = ran;
    const s = parser.state;
    this.forks.settle(resume, s.sessionId, s.done && !broken); // B-057: a fork the CLI took is no longer pending
    this.rebuilds.remember(s.version);
    this.rememberWindows(input.account.id, s.contextWindows);
    const result: EngineTurnResult = {
      text: parser.answer(), stop: 'done', usage: s.usage, contextTokens: s.contextTokens,
      contextWindow: parser.contextWindow(cliModel(input.model)), session: { ref: await this.rebuilds.nextRef(resume, grownFrom, s.sessionId ?? sessionId, s.done && !s.isError && !broken), generation },
    };
    if (input.outputSchema && s.structured !== undefined) result.structured = s.structured;
    if (traceRefused) result.traceAsText = traceRefused;
    if (s.compacted) result.compacted = true; // B-049 F6: the next turn sends every volatile section again
    if (input.mcp || input.tools.length || resume) this.ranIn(result.session!.ref, input.cwd); // helper turns keep no session
    if (interrupted || input.signal.aborted) return { ...result, stop: 'interrupted', error: ERR.cancelled() };
    if (parser.limited()) return { ...result, stop: 'limit', error: ERR.limit(s.resetsAt ? Math.max(0, s.resetsAt - this.now()) : undefined) };
    if (parser.signedOut()) return { ...result, stop: 'error', error: ERR.unavailable('Claude Code is not signed in for this account.') };
    if (!s.done || broken) return { ...result, stop: 'error', error: ERR.unavailable('Claude Code stopped unexpectedly.') };
    if (s.isError) {
      if (resume && MISSING_SESSION.test(s.errorText ?? '')) {
        this.folders.delete(resume);
        return { ...result, session: undefined, stop: 'error', error: { code: 'conflict', message: 'Claude Code could not resume this session.', details: { rebase: true, ...(rebuilt ? { rebuild: 'failed' } : {}) } } };
      }
      // B-059 #184: the API overloaded or unreachable is an outage of the account (provider-outage.ts).
      if (claudeDown(s.assistantError, s.errorText)) return { ...result, stop: 'error', error: ERR.unavailable(providerDownMessage('Anthropic')) };
      const failed: EngineTurnResult = { ...result, stop: 'error', error: ERR.failed() };
      return rebuilt ? rebuiltTurnFailed(failed) : failed;
    }
    return result;
  }

  /** One CLI process of a turn: the user message, then its stream until the result or its end (`quiet`: ended without a line). */
  private async attempt(command: string, args: string[], env: NodeJS.ProcessEnv, input: EngineTurnInput, content: Array<Record<string, unknown>>): Promise<Attempt> {
    // Wave 2: never while this account's histories are being purged (nothing awaits between here and the spawn).
    for (let purge = this.purging.get(input.account.id); purge; purge = this.purging.get(input.account.id)) await purge.catch(() => undefined);
    // Stopped while the turn was being prepared (a look before it, a purge): no CLI and no model call after the Stop, as on Codex (codex/turn.ts).
    if (input.signal.aborted) return { parser: new ClaudeStreamParser(() => {}, this.now), broken: false, interrupted: true, quiet: false };
    const lease = this.deps.supervisor.spawn({ command, args, owner: `claude:${input.runId}`, kind: 'heavy', cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.running.set(input.runId, lease);
    const parser = new ClaudeStreamParser((event) => { try { input.onEvent(event); } catch { /* isolate */ } }, this.now);
    let broken = false;
    let lines = 0;
    let open = true; // the turn has not returned yet; afterwards the lines of a CLI ending by itself are not part of it
    let stopWaiting = () => {};
    const finished = new Promise<void>((resolve) => {
      stopWaiting = () => resolve();
      if (!lease.child.stdout) { broken = true; resolve(); return; }
      let results = 0;
      readJsonLines(lease.child.stdout, (message) => {
        if (!open) return;
        lines++;
        lease.touch();
        parser.push(message);
        if (!parser.state.done) return;
        if (isRecord(message) && message.type === 'result') results++;
        // Steered lines (17:09) are taken into this turn or answered as their own: no more input, then each
        // answer (one result per line) or the CLI's end – a steered line is never left unanswered.
        if (results > (this.steered.get(input.runId) ?? 0)) resolve();
        else if (lease.child.stdin && !lease.child.stdin.writableEnded) { try { lease.child.stdin.end(); } catch { /* gone */ } }
      }, () => { broken = true; resolve(); });
      lease.exited.then(() => resolve());
    });
    let interrupted = false;
    const onAbort = () => {
      interrupted = true;
      try { lease.child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: 'interrupt', request: { subtype: 'interrupt' } })}\n`); } catch { /* gone */ }
      setTimeout(() => stopWaiting(), 3000).unref?.(); // login guard 03.11.: no kill at once – it may be refreshing the sign-in (finally)
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
      lease.child.stdin?.on('error', () => {});
      lease.child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
      if (input.signal.aborted) onAbort();
      await finished;
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      this.running.delete(input.runId);
      this.steered.delete(input.runId);
      try { lease.child.stdin?.end(); } catch { /* gone */ }
      void lease.releaseAfter(this.deps.graceMs ?? CLAUDE_EXIT_GRACE_MS); // it ends by itself; its tree is killed only after the grace
    }
    // `exited` may come before the last stdout data: a start without a line counts only once stdout ended (at most 2 s).
    const stdout = lease.child.stdout;
    if (!lines && stdout && !stdout.readableEnded) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 2000);
        function done() { clearTimeout(timer); resolve(); }
        stdout.once('end', done); stdout.once('close', done);
      });
    }
    open = false;
    return { parser, broken, interrupted, quiet: lines === 0 && !broken && !interrupted && !input.signal.aborted };
  }

  /** The ledger's history as a fresh transcript for the probed tier; the next turn resumes it (rebuilder.ts). */
  rebuild(input: EngineRebuildInput): Promise<EngineRebuildResult> { return this.rebuilds.rebuild(input); }

  /** The CLI version the rebuild probe is kept for. */
  rebuildVersion(): Promise<string | undefined> { return this.rebuilds.cliVersion(); }

  /** The model-free probe of the rebuild tiers in `cwd`. */
  probeRebuild(account: Account, cwd: string): Promise<RebuildProbe> { return this.rebuilds.probe(account, cwd); }

  /** B-057 (fork.ts): reserves a forked session of the parent; its first turn resumes the parent with --fork-session. */
  fork(input: EngineForkInput): Promise<EngineForkResult> { return this.forks.fork(input, this.folders.get(input.parentRef)); }

  /** A superseded session the app created – our transcript (path ref) or the CLI's transcript of its id (id ref). */
  deleteSession(account: Account, ref: string): Promise<'deleted' | 'missing'> {
    this.folders.delete(ref);
    this.forks.drop(ref); // B-057: a split's fork that never ran
    return this.rebuilds.delete(account, ref);
  }

  /** Remembers the folder of a session's turn (at most MAX_FOLDERS sessions, the oldest go first). */
  private ranIn(sessionId: string, cwd: string): void {
    this.folders.delete(sessionId);
    this.folders.set(sessionId, cwd);
    if (this.folders.size > MAX_FOLDERS) this.folders.delete(this.folders.keys().next().value!);
  }

  private rememberWindows(accountId: string, reported: Record<string, number>): void {
    if (!Object.keys(reported).length) return;
    let windows = this.windows.get(accountId);
    if (!windows) this.windows.set(accountId, windows = new Map());
    rememberWindows(windows, reported);
  }

  private async content(input: EngineTurnInput, volatile?: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    if (volatile) out.push({ type: 'text', text: `<workforce-context>\n${volatile}\n</workforce-context>` });
    for (const item of input.input) {
      if (item.type === 'text') out.push({ type: 'text', text: item.text });
      else if (item.type === 'image') {
        try {
          const data = Buffer.from(await this.files.readFile(item.path)).toString('base64');
          out.push({ type: 'image', source: { type: 'base64', media_type: item.mime, data } });
        } catch { out.push({ type: 'text', text: `[image unavailable: ${path.basename(item.path)}]` }); }
      } else out.push({ type: 'text', text: `[file: ${item.name} (${item.mime}) at ${item.path}]${item.text ? `\n${item.text}` : ''}` });
    }
    if (!out.length) out.push({ type: 'text', text: '(continue)' });
    return out;
  }

  /**
   * Wave 2 (privacy): every session history of this account's home, through `claude purge --all --yes`
   * (purge.ts). The account is held from this call on (set before the first await): a turn of it waits
   * until the purge ended, so it never resumes or writes a transcript the purge is deleting.
   */
  purgeHistories(account: Account): Promise<{ purged: boolean; message?: string }> {
    if (this.purging.has(account.id)) return Promise.reject(Object.assign(new Error("Claude Code is already deleting this account's histories."), { code: 'conflict' }));
    const job = (async () => {
      const exe = await this.deps.finder.find('claude');
      if (!exe) throw Object.assign(new Error('Claude Code is not installed.'), { code: 'unavailable' });
      return purgeHistories(this.deps.supervisor, exe, account, this.status.envFor(account), this.deps.tempDir);
    })().finally(() => {
      this.purging.delete(account.id);
      this.folders.clear();
    });
    this.purging.set(account.id, job);
    return job;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.running.values()].map((lease) => lease.release()));
    this.running.clear();
  }
}
