// The runtime's own git calls (split worktrees): one GitRunner per services object (gitOf). It runs the git found on
// PATH by absolute path – never one from a PATH entry inside the workspace or a relative one (Windows searches the
// process folder first) – without a shell, in the temp folder, below normal priority, non-interactive (no prompt,
// pager or editor) with -c flags that turn submodule recursion, colour and auto-gc off. Each call has a timeout
// (killed then, on Windows with its process tree) and an output cap (a timed-out probe throws 'timeout'); at most two
// git processes run at once and `serial` runs one operation per repository at a time.
// Owns: spawning git, its flags, caps and queues. Never: runs git through a shell, inherits a GIT_DIR, pushes or
// fetches.

import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import * as nodeOs from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Paths, RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';

export interface GitResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated?: boolean }
/** `env`: extra variables for this call only (e.g. GIT_LFS_SKIP_SMUDGE). */
export interface GitRunOptions { timeoutMs?: number; maxBytes?: number; identity?: { name: string; email: string }; signal?: AbortSignal; env?: Record<string, string> }

/** The part of a child process a git call uses (fakes in tests implement just this). */
export interface GitChild {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}
export type GitSpawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; windowsHide: true; stdio: ['ignore', 'pipe', 'pipe'] }) => GitChild;

export interface GitRunnerDeps {
  paths: Pick<Paths, 'data' | 'workspace' | 'temp'>;
  spawn?: GitSpawn;
  /** The env children start from (default process.env; tests isolate the person's config here). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isFile?: (file: string) => boolean;
  /** Default timeout of a call, `git --version` included (default 30 s; tests under load pass more). */
  timeoutMs?: number;
}

const MAX_PROCESSES = 2;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX = 2 * 1024 * 1024;

/** git 2.31 or newer (worktree and config features the split worktrees use). */
const MIN_GIT: readonly [number, number] = [2, 31];

function gitVersionOk(text: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(text);
  return Boolean(match) && (Number(match![1]) > MIN_GIT[0] || (Number(match![1]) === MIN_GIT[0] && Number(match![2]) >= MIN_GIT[1]));
}

/** Inherited variables that would point git elsewhere: never passed on. */
const DROPPED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

const defaultIsFile = (file: string): boolean => { try { return statSync(file).isFile(); } catch { return false; } };
const real = (dir: string): string => { try { return realpathSync.native(dir); } catch { return dir; } };

export class GitRunner {
  private readonly deps: GitRunnerDeps;
  private readonly platform: NodeJS.Platform;
  private resolved: string | undefined | null = null;
  private versionInfo?: Promise<{ ok: boolean; text: string }>;
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly queues = new Map<string, Promise<void>>();

  constructor(deps: GitRunnerDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
  }

  /** The absolute path of git (cached; undefined when none is found outside the workspace). */
  resolve(): string | undefined {
    if (this.resolved !== null) return this.resolved;
    const win = this.platform === 'win32';
    const impl = win ? path.win32 : path.posix;
    const env = this.deps.env ?? process.env;
    const key = Object.keys(env).find((name) => (win ? name.toUpperCase() === 'PATH' : name === 'PATH'));
    const fold = (text: string) => (win ? text.toLowerCase() : text);
    const workspace = fold(impl.resolve(real(this.deps.paths.workspace)));
    const isFile = this.deps.isFile ?? defaultIsFile;
    this.resolved = undefined;
    for (const entry of (key ? env[key] ?? '' : '').split(win ? ';' : ':')) {
      const dir = entry.trim().replace(/^"(.*)"$/, '$1');
      if (!dir || !impl.isAbsolute(dir)) continue;
      const relative = impl.relative(workspace, fold(impl.resolve(real(dir))));
      if (relative === '' || (!relative.startsWith('..') && !impl.isAbsolute(relative))) continue;
      const file = impl.join(dir, win ? 'git.exe' : 'git');
      if (isFile(file)) { this.resolved = file; break; }
    }
    return this.resolved;
  }

  /**
   * `git --version`: ok when git is found and at least 2.31; `text` is empty when git is missing or
   * did not answer. Only an answer is cached: a failed or timed-out probe is tried again next time.
   */
  version(): Promise<{ ok: boolean; text: string }> {
    if (!this.versionInfo) {
      const probe = this.probeVersion();
      this.versionInfo = probe;
      void probe.then((info) => { if (!info.text && this.versionInfo === probe) this.versionInfo = undefined; });
    }
    return this.versionInfo;
  }

  private async probeVersion(): Promise<{ ok: boolean; text: string }> {
    const git = this.resolve();
    if (!git) return { ok: false, text: '' };
    const result = await this.slotted(() => this.spawnGit(git, ['--version'], {}));
    const text = result.code === 0 ? result.stdout.trim() : '';
    return { ok: gitVersionOk(text), text };
  }

  /** Runs `git <safety flags> -C <dir> <args>`. Throws only when git is missing. */
  run(dir: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
    const git = this.resolve();
    if (!git) return Promise.reject(new WorkforceError('unavailable', 'Git is not installed on this PC.'));
    return this.slotted(() => this.spawnGit(git, [...this.flags(options.identity), '-C', dir, ...args], options));
  }

  /** run(), for a call whose "no" means something: one that timed out throws 'timeout' instead. */
  async probe(dir: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
    const result = await this.run(dir, args, options);
    if (result.timedOut) throw new WorkforceError('timeout', `git ${args[0]} failed: ${this.firstLine(result)}`);
    return result;
  }

  /** stdout of a call that must succeed; else a 'conflict' with git's first error line. */
  async out(dir: string, args: string[], options: GitRunOptions = {}): Promise<string> {
    const result = await this.run(dir, args, options);
    if (result.code === 0) return result.stdout;
    throw new WorkforceError(result.timedOut ? 'timeout' : 'conflict', `git ${args[0]} failed: ${this.firstLine(result)}`);
  }

  /** git's first error line, the workspace path left out (no absolute paths in messages). */
  firstLine(result: GitResult): string {
    if (result.timedOut) return 'it took too long and was stopped';
    const line = (result.stderr || result.stdout).split('\n').map((text) => text.trim()).find(Boolean) ?? `exit ${result.code}`;
    const root = path.resolve(this.deps.paths.workspace);
    const spellings = [root, root.split(path.sep).join('/'), real(root), real(root).split(path.sep).join('/')];
    let clean = line;
    for (const spelling of spellings) clean = clean.split(spelling).join('<workspace>');
    return clean.slice(0, 200);
  }

  async hasBranch(repo: string, branch: string): Promise<boolean> {
    return (await this.probe(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  }

  /** One operation per repository at a time (FIFO); a failing operation does not block the next. */
  serial<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const key = this.platform === 'win32' ? repoKey.toLowerCase() : repoKey;
    const next = (this.queues.get(key) ?? Promise.resolve()).then(fn);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }

  private flags(identity: GitRunOptions['identity']): string[] {
    const pairs = [
      ['submodule.recurse', 'false'], ['core.quotePath', 'false'],
      ['color.ui', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false'],
    ];
    if (this.platform === 'win32') pairs.push(['core.longpaths', 'true']);
    if (identity) pairs.push(['user.name', identity.name], ['user.email', identity.email]);
    return ['--no-pager', ...pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`])];
  }

  /** At most MAX_PROCESSES git processes at once (a finished one hands its slot to the next). */
  private async slotted<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < MAX_PROCESSES) this.running++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running--;
    }
  }

  private spawnGit(git: string, argv: string[], options: GitRunOptions): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...(this.deps.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_PAGER: 'cat', GIT_EDITOR: ':', ...options.env };
    for (const name of DROPPED) delete env[name];
    const who = options.identity;
    if (who) Object.assign(env, { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });
    const max = options.maxBytes ?? DEFAULT_MAX;
    return new Promise((resolve) => {
      let child: GitChild;
      try {
        child = (this.deps.spawn ?? defaultSpawn)(git, argv, { cwd: this.deps.paths.temp, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: String((error as Error).message ?? error), timedOut: false });
        return;
      }
      if (child.pid) { try { nodeOs.setPriority(child.pid, nodeOs.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ } }
      const out = capped(max);
      const err = capped(max);
      child.stdout?.on('data', out.add);
      child.stderr?.on('data', err.add);
      let timedOut = false;
      let finished = false;
      const kill = () => {
        if (this.platform === 'win32' && child.pid) killTree(child.pid);
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT);
      options.signal?.addEventListener('abort', kill, { once: true });
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', kill);
        resolve({ code: timedOut ? null : code, stdout: out.text(), stderr: err.text(), timedOut, ...(out.cut || err.cut ? { truncated: true } : {}) });
      };
      child.once('close', (code) => finish(code));
      child.once('error', (error) => { err.add(Buffer.from(error.message)); finish(null); });
    });
  }
}

const defaultSpawn: GitSpawn = (command, args, options) => nodeSpawn(command, args, options) as unknown as GitChild;

/** A Windows process tree (git.exe of Git for Windows starts the real git as a child). */
function killTree(pid: number): void {
  try {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    nodeSpawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
  } catch { /* best effort */ }
}

/** Collects up to `max` bytes; the rest is dropped (cut). */
function capped(max: number): { add: (chunk: Buffer | string) => void; text: () => string; cut: boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  const state = {
    cut: false,
    add: (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size >= max) { state.cut = true; return; }
      const part = size + bytes.length > max ? bytes.subarray(0, max - size) : bytes;
      if (part.length < bytes.length) state.cut = true;
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
  return state;
}

const runners = new WeakMap<object, GitRunner>();

/** The GitRunner of a services object (created on first use). */
export function gitOf(s: Pick<RuntimeServices, 'paths'>): GitRunner {
  let runner = runners.get(s);
  if (!runner) {
    runner = new GitRunner({ paths: s.paths });
    runners.set(s, runner);
  }
  return runner;
}

/** Tests: a runner with an isolated env or a fake spawn. */
export function setGitRunner(s: object, runner: GitRunner): void {
  runners.set(s, runner);
}
