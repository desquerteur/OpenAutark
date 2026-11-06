// The PATH as Windows has it now (B-051 L2): a process keeps the PATH it started with, so Node.js or a CLI
// installed while the app runs would stay unfound until a restart. The finder asks this on a forced
// lookup: the machine and the current user's `Path` from the registry (HKLM …\Session Manager\Environment,
// HKCU\Environment), REG_EXPAND_SZ %VARS% expanded from the env, machine first like Windows builds it.
// Owns: two fixed `reg.exe query` calls through the supervisor (runCli, 5 s), their parsing and expansion.
// Never: writes the registry, takes arguments from input, runs on other platforms (undefined there),
// hands out a relative, unexpanded or network entry (localDir), or fails a lookup – any error, timeout
// or missing answer is undefined.

import * as path from 'node:path';
import { Supervisor } from '../system/supervisor.ts';
import { runCli, type CliResult } from './cli.ts';

const KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'] as const;
export const FRESH_PATH_MS = 5_000;

/** Runs `reg.exe` with these constant arguments. */
export type RegRunner = (args: string[]) => Promise<CliResult>;

export interface FreshPathDeps {
  /** The runtime's supervisor; without one a private supervisor of its own (defaultFinderEnv). */
  supervisor?: Supervisor;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Tests: answers instead of reg.exe. */
  run?: RegRunner;
}

/** The `Path` value of one `reg query … /v Path` answer, undefined without one. */
export function parseRegPath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (match) return match[1].trim() || undefined;
  }
  return undefined;
}

/** %NAME% from the env (case-insensitive, like Windows); unknown names stay as written. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  const names = new Map(Object.keys(env).map((key) => [key.toLowerCase(), key]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => {
    const key = names.get(name.toLowerCase());
    const found = key === undefined ? undefined : env[key];
    return found === undefined ? whole : found;
  });
}

/**
 * A registry PATH entry the finder may search: a drive path, fully expanded (review B-051). A relative or
 * unexpanded entry ("bin", ".", "%NEW%\bin") would resolve against the process cwd; a network share
 * (\\server\…) can stall a lookup – an installer meanwhile never adds either.
 */
export function localDir(dir: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dir) && !dir.includes('%');
}
const unquote = (dir: string): string => dir.trim().replace(/^"(.*)"$/, '$1').trim();

let ownSupervisor: Supervisor | undefined;

/** The reader for FinderEnv.freshPath: machine;user PATH, or undefined (not Windows, any failure). */
export function freshPath(deps: FreshPathDeps = {}): () => Promise<string | undefined> {
  return async () => {
    if ((deps.platform ?? process.platform) !== 'win32') return undefined;
    const env = deps.env ?? process.env;
    const run = deps.run ?? regRunner(deps, env);
    try {
      const answers = await Promise.all(KEYS.map((key) => run(['query', key, '/v', 'Path'])));
      if (answers.some((answer) => answer.timedOut || answer.code === null)) return undefined;
      const parts = answers.map((answer) => (answer.code === 0 ? parseRegPath(answer.stdout) : undefined)).filter((part): part is string => part !== undefined);
      const dirs = parts.flatMap((part) => expandVars(part, env).split(';')).map(unquote).filter(localDir);
      return dirs.length ? dirs.join(';') : undefined;
    } catch {
      return undefined;
    }
  };
}

/** reg.exe from System32 (never a PATH lookup), through the given supervisor or a private one. */
function regRunner(deps: FreshPathDeps, env: NodeJS.ProcessEnv): RegRunner {
  const root = expandVars('%SystemRoot%', env);
  const reg = path.win32.join(root.includes('%') ? 'C:\\Windows' : root, 'System32', 'reg.exe');
  return (args) => {
    const supervisor = deps.supervisor ?? (ownSupervisor ??= new Supervisor());
    return runCli(supervisor, { command: reg, prefixArgs: [], path: reg }, args, { timeoutMs: deps.timeoutMs ?? FRESH_PATH_MS, owner: 'fresh-path', maxBytes: 64 * 1024 });
  };
}
