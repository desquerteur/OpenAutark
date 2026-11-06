// Test fixtures for the split worktrees over the PC's real git: skipped when git is missing or older
// than 2.31; every call runs with an isolated config (GIT_CONFIG_GLOBAL = an empty temp file,
// GIT_CONFIG_NOSYSTEM=1) in os temp folders; repos are made with `git init -b main` and a local
// identity. worktreeFixture wires the RPC fixture's real chat/task services, two agents, a GitRunner
// with that env (and generous timeouts); plantHooks plants marker-writing
// hooks and an fsmonitor; holdFolder starts a process that works in a folder (its cwd).
// Owns: fixtures only. Never imported by src/.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agent } from '../chat/harness.ts';
import { rpcFixture } from '../rpc/s1-helpers.ts';
import { GitRunner, setGitRunner } from '../../../src/runtime/git/exec.ts';
import type { HandlerTable } from '../../../src/runtime/rpc/table.ts';

function probe(): string {
  try { return execFileSync('git', ['--version'], { encoding: 'utf8' }); } catch { return ''; }
}

/** false when the real-git tests can run, else the reason to skip them. */
const versionOk = (text: string): boolean => { const m = /git version (\d+)\.(\d+)/.exec(text); return Boolean(m) && (Number(m![1]) > 2 || (Number(m![1]) === 2 && Number(m![2]) >= 31)); };
export const GIT_SKIP: string | false = versionOk(probe()) ? false : 'git 2.31 or newer is not installed';

const DROP = /^GIT_/i;

/** process.env without inherited GIT_* variables, with the person's and the system's config switched off. */
export function gitEnv(root: string): NodeJS.ProcessEnv {
  const empty = path.join(root, 'empty.gitconfig');
  if (!existsSync(empty)) writeFileSync(empty, '');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!DROP.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' };
}

/** Plain git for setting up and inspecting repos (no Workforce flags). */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Like git(), but returns the exit code instead of throwing. */
export function gitCode(cwd: string, args: string[], env: NodeJS.ProcessEnv): number {
  try { git(cwd, args, env); return 0; } catch (error) { return (error as { status?: number }).status ?? 1; }
}

/** A repo with one commit (README.md and the given files) on main. */
export function makeRepo(dir: string, env: NodeJS.ProcessEnv, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main'], env);
  git(dir, ['config', 'user.name', 'Person'], env);
  git(dir, ['config', 'user.email', 'person@example.invalid'], env);
  for (const [name, text] of Object.entries({ 'README.md': '# Site\n', ...files })) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'Initial commit'], env);
  return dir;
}

const posixPath = (file: string) => file.split(path.sep).join('/');

/**
 * Marker-writing hooks in .git/hooks (pre-commit, post-checkout, post-commit, post-merge,
 * pre-merge-commit, reference-transaction) and in a local core.hooksPath folder, plus a local
 * core.fsmonitor command. Each writes `<markers>/<name>` when it runs. Returns the marker names written so far.
 */
export function plantHooks(repo: string, markers: string, env: NodeJS.ProcessEnv): () => string[] {
  mkdirSync(markers, { recursive: true });
  const script = (name: string) => `#!/bin/sh\necho ran > "${posixPath(path.join(markers, name))}"\nexit 0\n`;
  const own = path.join(repo, '.git', 'own-hooks');
  mkdirSync(own, { recursive: true });
  for (const hook of ['pre-commit', 'post-checkout', 'post-commit', 'post-merge', 'pre-merge-commit', 'reference-transaction']) {
    writeFileSync(path.join(repo, '.git', 'hooks', hook), script(`git-hooks-${hook}`), { mode: 0o755 });
    writeFileSync(path.join(own, hook), script(`hooks-path-${hook}`), { mode: 0o755 });
  }
  git(repo, ['config', 'core.hooksPath', posixPath(own)], env);
  const fsmonitor = path.join(repo, '.git', 'fsmonitor.sh');
  writeFileSync(fsmonitor, `#!/bin/sh\necho ran > "${posixPath(path.join(markers, 'fsmonitor'))}"\nexit 1\n`, { mode: 0o755 });
  git(repo, ['config', 'core.fsmonitor', `sh "${posixPath(fsmonitor)}"`], env);
  return () => (existsSync(markers) ? readdirSync(markers).sort() : []);
}

/** The RPC fixture with real tasks/chats, agents Ada and Bob in one chat and real git (isolated). */
export function worktreeFixture(options: { table?: HandlerTable } = {}) {
  const f = rpcFixture(options);
  const env = gitEnv(f.paths.temp);
  const runner = new GitRunner({ paths: f.paths, env, timeoutMs: 180_000 }); // generous: parallel suites slow every git call down
  setGitRunner(f.services, runner);
  f.org.add(agent('ag_ada', 'Ada'));
  f.org.add(agent('ag_bob', 'Bob'));
  const chat = f.chats.create({ agentIds: ['ag_ada', 'ag_bob'], createdBy: 'human' });
  const task = (title: string, assigneeId = 'ag_ada', extra: { parentId?: string } = {}) =>
    f.tasks.create({ conversationId: chat.id, title, assigneeKind: 'agent', assigneeId, createdBy: 'human', ...extra });
  const settled = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  const lines = () => f.chats.messages(chat.id, { limit: 500 }).filter((message) => message.kind === 'status').map((message) => message.body);
  const repo = (name = 'site', files: Record<string, string> = {}) => makeRepo(path.join(f.paths.workspace, name), env, files);
  return { ...f, env, runner, chat, task, settled, lines, repo, cleanup: () => f.cleanup() };
}

export type WorktreeFixture = ReturnType<typeof worktreeFixture>;

/** A process whose cwd is `dir` (as an engine or a dev server it started); `release` ends it. */
export function holdFolder(dir: string): { release: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  return { release: async () => { child.kill(); await exited; } };
}
