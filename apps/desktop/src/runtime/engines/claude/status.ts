// Claude Code account checks: `claude auth status --json` and one short probe process that sends
// the `initialize` (models, account) and `get_usage` (limits, plan) control requests.
// Owns: the probe (ported from legacy usage.cjs: safe-mode, no tools, no MCP, no session
// persistence, cwd = temp), its cache per account shared by checks and model lists (one process
// at a time per account; 1 min after an answer or a probe that did not answer
// `initialize` – timeout, crash, no start), the last good `initialize` per account (stands in for
// a failed probe, dropped on sign-out), the account env (CLAUDE_CONFIG_DIR = the account home, the
// CLI's own cron scheduler off: NO_CLI_CRON) and the setting sources every Claude process loads (USER_SETTINGS_ONLY: that home's settings, never
// project or local ones; auth status and the probe also run with cwd = temp, outside the workspace).
// A status or probe that does not answer in CHECK_TIMEOUT_MS is "unknown" (state error), never needs_login.
// Login guard 03.11.: both may be refreshing the sign-in, so neither is hard-killed – answered, the probe's stdin closes
// and it ends by itself; a tree is killed only CLAUDE_EXIT_GRACE_MS later (accounts/cli.ts) – and status and probe of an
// account run one process at a time, also across checks (the next waits until the previous one is gone).
// B-051 L5: a claude.ai sign-in whose subscriptionType is 'free' is not 'ok' but 'error' with CLAUDE_FREE_PLAN
// (accounts/cli.ts; no probe runs for it) – the account service stores that even from a background check.
// Never: reads ~/.claude/.credentials.json or any token; never sends a model message; never logs
// what the probe returns (it holds the account's e-mail address).

import type { Account } from '../../../shared/model/providers.ts';
import type { AccountCheck } from '../types.ts';
import type { Supervisor } from '../../system/supervisor.ts';
import type { Executable } from '../../accounts/executables.ts';
import { CLAUDE_EXIT_GRACE_MS, CLAUDE_FREE_PLAN, claudeFreePlan, claudeLogin, parseClaudeStatus, runCli } from '../../accounts/cli.ts';
import { normalizeClaudeUsage } from '../../accounts/limits.ts';
import { childEnv } from '../codex/server.ts';
import { isRecord, tryJson } from '../shared.ts';
import { parseInitialize, type ClaudeInit } from './models.ts';

/**
 * Load only the account's user settings (`<CLAUDE_CONFIG_DIR>/settings.json`; managed policy always
 * applies), never the 'project'/'local' sources of the working folder and its parents. Agents and
 * content injected into them can write the workspace, and Claude Code gates on exactly these sources:
 * `.claude/settings.json` and `settings.local.json` (hooks, permissions.allow/defaultMode, env,
 * apiKeyHelper, enabledPlugins, MCP approvals) and the project `.claude/skills|agents|commands|
 * workflows` trees (skill/agent frontmatter hooks, allowed-tools, mcpServers). `.mcp.json` is
 * ignored by --strict-mcp-config (and -p auto-approves it only while project settings are on).
 * Side effect: the workspace's CLAUDE.md/AGENTS.md is not auto-loaded either (our prompt is passed
 * explicitly). A CLI without the flag rejects it and the turn fails closed.
 */
export const USER_SETTINGS_ONLY: readonly string[] = ['--setting-sources', 'user'];

/**
 * Claude Code's own cron scheduler stays off in every process. In a `-p` turn (stdin stays open for
 * steering) it would lease `<cwd>/.claude/scheduled_tasks.json` – a workspace file, read whatever the
 * setting sources are – and enqueue its prompts into the turn (`isKairosCronEnabled()` is
 * `!CLAUDE_CODE_DISABLE_CRON && …` in 2.1.303). Workforce schedules work itself.
 */
export const NO_CLI_CRON: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_CRON: '1' };

export const PROBE_ARGS = ['-p', '--safe-mode', ...USER_SETTINGS_ONLY, '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const control = (id: string, request: Record<string, unknown>) => `${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`;
const PROBE_REQUESTS = control('init', { subtype: 'initialize' }) + control('usage', { subtype: 'get_usage', skip_behaviors: true });
const PROBE_IDS = ['init', 'usage'];
/** `auth status` and the probe: a cold Claude Code start (~290 MB binary) took 5–30 s on a loaded 8 GB PC (audit 23.10.); at 30 s three probes in a row got no answer, nothing was listed and the person read "No model is connected" (q2m3, live 02.11.2026). On a quiet PC about 1 s. */
export const CHECK_TIMEOUT_MS = 90_000;

export interface ClaudeProbe {
  usage: ReturnType<typeof normalizeClaudeUsage>;
  /** This probe's `initialize`, else the account's last one that listed models. */
  init?: ClaudeInit;
  /** The process did not answer `initialize` at all (timeout, crash, could not start). */
  failed?: boolean;
}

/** Successful control-response payloads by request id; `answered` also counts error responses. */
export function controlResponses(stdout: string): { payloads: Map<string, unknown>; answered: Set<string> } {
  const payloads = new Map<string, unknown>();
  const answered = new Set<string>();
  for (const line of stdout.split('\n')) {
    const message = tryJson(line.trim());
    if (!isRecord(message) || message.type !== 'control_response' || !isRecord(message.response)) continue;
    const response = message.response;
    const id = typeof response.request_id === 'string' ? response.request_id : undefined;
    if (!id || !PROBE_IDS.includes(id)) continue;
    answered.add(id);
    if (response.subtype === 'success') payloads.set(id, response.response);
  }
  return { payloads, answered };
}

export class ClaudeStatus {
  private readonly supervisor: Supervisor;
  private readonly tempDir: string;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly retryMs: number;
  private readonly cache = new Map<string, { at: number; ttl: number; value: ClaudeProbe }>();
  private readonly lastInit = new Map<string, ClaudeInit>();
  private readonly inflight = new Map<string, Promise<ClaudeProbe>>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly graceMs: number;

  constructor(deps: { supervisor: Supervisor; tempDir: string; now?: () => number; throttleMs?: number; retryMs?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number; graceMs?: number }) {
    this.supervisor = deps.supervisor;
    this.tempDir = deps.tempDir;
    this.now = deps.now ?? Date.now;
    this.throttleMs = deps.throttleMs ?? 60_000;
    this.retryMs = Math.min(deps.retryMs ?? 60_000, this.throttleMs);
    this.env = deps.env ?? process.env;
    this.timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
    this.graceMs = deps.graceMs ?? CLAUDE_EXIT_GRACE_MS;
  }

  envFor(account: Account): NodeJS.ProcessEnv {
    return childEnv(this.env, { ...NO_CLI_CRON, CLAUDE_CONFIG_DIR: account.home });
  }

  async check(exe: Executable, account: Account): Promise<AccountCheck> {
    // `auth status` takes no --setting-sources: it runs in temp so no project settings (apiKeyHelper, env) apply.
    const status = await runCli(this.supervisor, exe, ['auth', 'status', '--json'], {
      env: this.envFor(account), cwd: this.tempDir, timeoutMs: this.timeoutMs, owner: `claude-status:${account.id}`, graceMs: this.graceMs, group: claudeLogin(account.id),
    });
    // No answer (a cold start on a loaded PC): unknown – a background check then keeps the account as it was.
    if (status.timedOut) return { state: 'error', message: 'Claude Code did not answer the account check.' };
    const parsed = parseClaudeStatus(status.code, status.stdout);
    if (parsed.unknown) return { state: 'error', message: 'Claude Code did not answer the account check.' };
    if (!parsed.loggedIn) {
      this.cache.delete(account.id); // the next check after signing in probes again
      this.lastInit.delete(account.id); // another login may have another plan
      return { state: 'needs_login', message: 'Sign in to Claude Code.' };
    }
    // B-051 L5: signed in, but the Free plan cannot run Claude Code agents – never shown as "Signed in".
    if (claudeFreePlan(parsed)) return { state: 'error', message: CLAUDE_FREE_PLAN, plan: parsed.plan, ...(parsed.email ? { email: parsed.email } : {}) };
    const check: AccountCheck = { state: 'ok', email: parsed.email, plan: parsed.plan ?? (parsed.method === 'api' ? 'api' : undefined) };
    const probe = await this.probe(exe, account);
    if (probe.usage.limits) check.limits = probe.usage.limits;
    if (probe.usage.plan) check.plan = probe.usage.plan;
    const info = probe.init?.account;
    if (!check.email && info?.email) check.email = info.email;
    if (!check.plan && info?.plan) check.plan = info.plan;
    return check;
  }

  /** The probe's reading, at most one process per throttle (or retry) window per account (concurrent callers share it). */
  probe(exe: Executable, account: Account): Promise<ClaudeProbe> {
    const cached = this.cache.get(account.id);
    if (cached && this.now() - cached.at < cached.ttl) return Promise.resolve(cached.value);
    let running = this.inflight.get(account.id);
    if (!running) {
      running = this.read(exe, account).then((raw) => {
        const value: ClaudeProbe = { usage: raw.usage === undefined ? {} : normalizeClaudeUsage(raw.usage, this.now()) };
        const parsed = raw.init === undefined ? undefined : parseInitialize(raw.init);
        if (parsed?.models.length) this.lastInit.set(account.id, parsed);
        const last = this.lastInit.get(account.id);
        // A probe without a model list never empties it: the last good list stands in.
        const init = parsed?.models.length || !last ? parsed : { models: last.models, account: parsed?.account ?? last.account };
        if (init) value.init = init;
        if (!raw.initAnswered) value.failed = true;
        this.cache.set(account.id, { at: this.now(), ttl: value.failed ? this.retryMs : this.throttleMs, value });
        return value;
      }).finally(() => { this.inflight.delete(account.id); });
      this.inflight.set(account.id, running);
    }
    return running;
  }

  /** Raw `initialize` and `get_usage` payloads of one probe process (successful responses only); `initAnswered` also counts an error response. */
  async read(exe: Executable, account: Account): Promise<{ init?: unknown; usage?: unknown; initAnswered?: boolean }> {
    try {
      const result = await runCli(this.supervisor, exe, PROBE_ARGS, {
        env: this.envFor(account), cwd: this.tempDir, timeoutMs: this.timeoutMs, maxBytes: 1024 * 1024, stdin: PROBE_REQUESTS, owner: `claude-usage:${account.id}`,
        graceMs: this.graceMs, group: claudeLogin(account.id),
        until: (stdout) => { const { answered } = controlResponses(stdout); return PROBE_IDS.every((id) => answered.has(id)); },
      });
      const { payloads, answered } = controlResponses(result.stdout);
      return { init: payloads.get('init'), usage: payloads.get('usage'), initAnswered: answered.has('init') };
    } catch {
      return {};
    }
  }
}
