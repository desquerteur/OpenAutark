// One-shot CLI calls (status checks, version, login) through the supervisor, and the parsing of the
// official status outputs (B-051 L5: a Claude Free sign-in is a plan that cannot run agents).
// Owns: timeouts, output caps (32 KB by default), safe stdin writing, the gentle end of a process that may be saving
// a sign-in (graceMs, CLAUDE_EXIT_GRACE_MS), one process per group (group) and the status parsers.
// Never: logs output (status output may contain e-mail addresses) or uses a shell.

import type { Supervisor } from '../system/supervisor.ts';
import type { Executable } from './executables.ts';

export interface CliResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * Claude Code refreshes its sign-in by itself, and a refresh token works once: lock, POST (30 s timeout), profile,
 * save. A process killed between the POST and the save leaves a dead token, and the next process empties the login
 * (`.credentials.json` with empty tokens, 02.11.2026). So a Claude process is never hard-killed while it may refresh:
 * it ends by itself (its own exit waits up to 2 s for a refresh, 2.1.303) and its tree is killed only if it still
 * runs this long after we stopped needing it – longer than a refresh with its lock retries.
 */
export const CLAUDE_EXIT_GRACE_MS = 90_000;
/** One Claude check process per account at a time (runCli group): a hanging one is never joined by the next. */
export const claudeLogin = (accountId: string): string => `claude-login:${accountId}`;

export async function runCli(supervisor: Supervisor, exe: Executable, args: string[], options: {
  env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; maxBytes?: number; stdin?: string; owner?: string;
  /** Resolve early as soon as this returns true for the stdout so far (the process is then ended, see graceMs). */
  until?: (stdout: string) => boolean;
  /**
   * The process may be saving a sign-in: never killed at once. Answered (until, or its own end), its stdin is closed
   * and it ends by itself; timed out, it runs on with its input open (it may still answer, then its stdin is closed).
   * Its tree is killed only if it still runs graceMs after the call resolved. Without it: killed when the call resolves.
   */
  graceMs?: number;
  /** One process of this group at a time: the call starts only once the group's previous process is gone. */
  group?: string;
} = {}): Promise<CliResult> {
  const max = options.maxBytes ?? 32 * 1024;
  const spawn = {
    command: exe.command, args: [...exe.prefixArgs, ...args], owner: options.owner ?? 'cli', kind: 'light' as const,
    env: options.env, cwd: options.cwd, stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] as Array<'pipe' | 'ignore'>,
  };
  const lease = options.group ? await supervisor.spawnAlone({ ...spawn, group: options.group }) : supervisor.spawn(spawn);
  const child = lease.child;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let early = false;
  const closeInput = () => { try { child.stdin?.end(); } catch { /* gone */ } };
  return new Promise<CliResult>((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (options.graceMs === undefined) void lease.release();
      else {
        if (!timedOut) closeInput(); // answered: nothing waits on a refresh any more
        void lease.releaseAfter(options.graceMs);
      }
      resolve({ code: early ? 0 : code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; finish(null); }, options.timeoutMs ?? 10_000);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < max) stdout += chunk.toString().slice(0, max - stdout.length);
      if (!options.until?.(stdout)) return;
      if (!done) { early = true; finish(0); } else if (options.graceMs !== undefined) closeInput(); // a late answer after the timeout
    });
    child.stderr?.on('data', (chunk: Buffer | string) => { if (stderr.length < max) stderr += chunk.toString().slice(0, max - stderr.length); });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(options.stdin);
    }
  });
}

/** Codex `codex login status`: signed in if exit 0 and "Logged in using/with …" (legacy rule). */
export function parseCodexStatus(code: number | null, output: string): { loggedIn: boolean; method?: 'api' | 'chatgpt' } {
  const loggedIn = code === 0 && /^\s*Logged in (?:using|with) /im.test(output);
  return { loggedIn, method: loggedIn ? (/api key/i.test(output) ? 'api' : 'chatgpt') : undefined };
}

/** B-051 L5: Claude Code runs agents only on a paid claude.ai plan (Pro, Max, Team …); the Free plan cannot. */
export const CLAUDE_FREE_PLAN = 'Claude Code needs a Claude Pro or Max plan.';

/** A claude.ai sign-in on the Free plan (case-insensitive; unknown plans pass). Codex is never blocked by plan. */
export function claudeFreePlan(status: { method?: string; plan?: string }): boolean {
  return status.method === 'claude' && status.plan?.trim().toLowerCase() === 'free';
}

/** An account check that found a plan which cannot run agents – a reading, not a failed check (stored even in the background). */
export function planBlocked(check: { state: string; message?: string }): boolean {
  return check.state === 'error' && check.message === CLAUDE_FREE_PLAN;
}

/** Claude `claude auth status --json`. */
export function parseClaudeStatus(code: number | null, stdout: string): { loggedIn: boolean; unknown?: boolean; method?: string; email?: string; plan?: string } {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const loggedIn = code === 0 && value.loggedIn === true;
    if (!loggedIn) return { loggedIn: false };
    const method = value.authMethod === 'claude.ai' ? 'claude' : 'api';
    const email = typeof value.email === 'string' ? value.email.slice(0, 200) : undefined;
    const plan = typeof value.subscriptionType === 'string' ? value.subscriptionType.slice(0, 40) : undefined;
    return { loggedIn, method, email, plan };
  } catch {
    return { loggedIn: false, unknown: true }; // no answer of the CLI (a start that crashed on a loaded PC, live 02.11.2026) says nothing about the login
  }
}
