// B-052 track A: starting a stdio MCP server. resolveCommand() finds what Windows would run for a bare command
// (`npx` → npx.cmd via PATH + PATHEXT) and, because Node cannot start a .cmd/.bat without a shell, runs the script a
// shim points at with node (npm's npx.cmd, cmd-shim's `"%dp0%\…\cli.js" %*`) or the .exe it names; a shim it cannot
// read runs through `cmd /d /c` only when every argument is plain (no spaces, quotes or shell characters).
// childEnv() is the small inherited base (PATH, HOME, APPDATA …) plus the app's own env – never the runtime's whole
// env (it holds other services' keys). supervisorSpawner() adapts the runtime/system supervisor (below-normal
// priority, hidden window, tree kill); defaultSpawner uses a private one until composition hands its own.
// Owns: that resolution, the env base and the adapter. Never: runs anything through a shell with free text, logs an
// env value, or reads a file other than a shim's first few KB.

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Supervisor } from '../../system/supervisor.ts';
import type { StdioChild, StdioSpawner } from '../types.ts';

export interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile(file: string): Promise<boolean>;
  /** The first few KB of a text file, or undefined. */
  readText(file: string): Promise<string | undefined>;
}

export function defaultResolveDeps(): ResolveDeps {
  return {
    platform: process.platform,
    env: process.env,
    isFile: async (file) => { try { return (await fsp.stat(file)).isFile(); } catch { return false; } },
    readText: async (file) => { try { return (await fsp.readFile(file, 'utf8')).slice(0, 8192); } catch { return undefined; } },
  };
}

/** What to spawn, or a user-safe reason why it cannot be started safely. */
export type Resolved = { command: string; args: string[] } | { refused: string };

const WIN_SAFE_ARG = /^[A-Za-z0-9_@.\/\\:=+,\-]+$/;
const WIN_SAFE_PATH = /^[^"%^&|<>!\r\n]+$/;

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** The program Windows would start for `command` (POSIX: unchanged – spawn searches PATH and runs shebangs itself). */
export async function resolveCommand(command: string, args: string[], deps: ResolveDeps = defaultResolveDeps(), cwd?: string): Promise<Resolved> {
  if (deps.platform !== 'win32') return { command, args };
  const win = path.win32;
  const exts = (envGet(deps.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith('.'));
  const hasExt = exts.includes(win.extname(command).toLowerCase());
  const names = hasExt ? [command] : exts.map((ext) => command + ext);
  const dirs = /[\\/]/.test(command) || win.isAbsolute(command) ? [''] : (envGet(deps.env, 'PATH') ?? '').split(';').map((dir) => dir.trim()).filter(Boolean);
  let found: string | undefined;
  search: for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? win.join(dir, name) : cwd && !win.isAbsolute(name) ? win.resolve(cwd, name) : name;
      if (await deps.isFile(candidate)) { found = candidate; break search; }
    }
  }
  if (!found) return { command, args }; // let spawn report it (not found) – or it is on a path spawn knows
  const ext = win.extname(found).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { command: found, args };
  const shim = await resolveShim(found, deps);
  if (shim) return { command: shim.command, args: [...shim.prefix, ...args] };
  if (WIN_SAFE_PATH.test(found) && args.every((arg) => WIN_SAFE_ARG.test(arg))) {
    // cmd keeps exactly two quotes around an existing program; plain arguments need no quoting at all.
    return { command: envGet(deps.env, 'COMSPEC') ?? 'cmd.exe', args: ['/d', '/c', found, ...args] };
  }
  return { refused: 'The app\'s program is a Windows script that cannot be started safely with these arguments.' };
}

/** npm / cmd-shim launchers: the script (run with node) or the program their last `%*` line starts. */
async function resolveShim(shim: string, deps: ResolveDeps): Promise<{ command: string; prefix: string[] } | undefined> {
  const text = await deps.readText(shim);
  if (!text) return undefined;
  const win = path.win32;
  const dir = win.dirname(shim);
  const vars = new Map<string, string>();
  for (const match of text.matchAll(/^\s*SET\s+"?([A-Za-z_][\w]*)=([^"\r\n]*)"?\s*$/gim)) {
    const name = match[1].toUpperCase();
    if (!vars.has(name)) vars.set(name, match[2]);
  }
  const expand = (value: string) => value
    .replace(/%~dp0%?|%dp0%/gi, `${dir}\\`)
    .replace(/%([A-Za-z_]\w*)%/g, (whole, name: string) => vars.get(name.toUpperCase())?.replace(/%~dp0%?|%dp0%/gi, `${dir}\\`) ?? whole);
  const launch = text.split(/\r?\n/).reverse().find((line) => line.includes('%*'));
  if (!launch) return undefined;
  const parts = [...launch.matchAll(/"([^"]+)"/g)].map((match) => win.normalize(expand(match[1])));
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (/[%]/.test(part) || !(await deps.isFile(part))) continue;
    if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) {
      const nodeExe = parts.find((candidate) => candidate.toLowerCase().endsWith('node.exe'));
      const node = nodeExe && await deps.isFile(nodeExe) ? nodeExe : await findOnPath('node.exe', deps);
      return node ? { command: node, prefix: [part] } : undefined;
    }
    if (lower.endsWith('.exe') && !lower.endsWith('node.exe')) return { command: part, prefix: [] };
  }
  return undefined;
}

async function findOnPath(name: string, deps: ResolveDeps): Promise<string | undefined> {
  for (const dir of (envGet(deps.env, 'PATH') ?? '').split(';').map((entry) => entry.trim()).filter(Boolean)) {
    const candidate = path.win32.join(dir, name);
    if (await deps.isFile(candidate)) return candidate;
  }
  return undefined;
}

const BASE_ENV: Record<'win32' | 'posix', string[]> = {
  win32: ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'ALLUSERSPROFILE'],
  posix: ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'],
};

/** The inherited base (names as the platform knows them; no exported shell functions) plus the app's own env. */
export function childEnv(own: Record<string, string> | undefined, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const wanted = new Set(BASE_ENV[platform === 'win32' ? 'win32' : 'posix']);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.startsWith('()')) continue;
    if (wanted.has(platform === 'win32' ? key.toUpperCase() : key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(own ?? {})) {
    if (platform === 'win32') for (const existing of Object.keys(out)) if (existing.toUpperCase() === key.toUpperCase()) delete out[existing];
    out[key] = value;
  }
  return out;
}

/** The start failure of a child started by supervisorSpawner (e.g. 'ENOENT'), for the user-safe message. */
export function startErrorOf(child: StdioChild): string | undefined {
  const value = (child as { startError?: unknown }).startError;
  return typeof value === 'string' ? value : undefined;
}

/** A StdioSpawner over the runtime's process supervisor: kill() ends the whole process tree. */
export function supervisorSpawner(supervisor: Pick<Supervisor, 'spawn'>, owner = 'app'): StdioSpawner {
  return (command, args, opts) => {
    const lease = supervisor.spawn({ command, args, owner, kind: 'light', env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = lease.child;
    let startError: string | undefined;
    child.once('error', (error) => { startError = (error as NodeJS.ErrnoException).code ?? 'ERROR'; });
    child.stdin?.on('error', () => undefined); // EPIPE after the server exited is no crash
    const stdout = child.stdout;
    if (!stdout || !child.stdin) throw new Error('stdio not piped');
    const stdio: StdioChild & { readonly startError: string | undefined } = {
      stdin: {
        write: (chunk) => (child.stdin && !child.stdin.destroyed ? child.stdin.write(chunk) : false),
        end: () => { try { child.stdin?.end(); } catch { /* gone */ } },
      },
      stdout,
      stderr: child.stderr,
      pid: child.pid,
      kill: () => { void lease.release(); return true; },
      once: (_event, listener) => { void lease.exited.then((code) => listener(code)); return stdio; },
      get startError() { return startError; },
    };
    return stdio;
  };
}

let fallback: Supervisor | undefined;

/** The default: a private supervisor (composition should pass its own via supervisorSpawner). */
export const defaultSpawner: StdioSpawner = (command, args, opts) => {
  fallback ??= new Supervisor();
  return supervisorSpawner(fallback, 'app')(command, args, opts);
};
