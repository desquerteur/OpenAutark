// Visible terminal windows for interactive CLI sign-ins (Copilot CLI's /login, Kimi Code's `kimi login`),
// one launch per OS:
//   Windows – a hidden PowerShell starts a visible PowerShell window and waits for that window
//             process to close (not for a browser it opened). Both scripts are fixed and
//             -EncodedCommand; the CLI path, its arguments and the title travel only in
//             environment variables, so nothing is quoted.
//   macOS   – Terminal through osascript (`do script`); Terminal's shell does not inherit our
//             environment, so the account's own variables are written into the command, single-quoted,
//             and it starts in the home folder, so the command first changes into `cwd` (quoted).
//             osascript returns at once – the caller re-checks later (the window stays open).
//   Linux   – the first of x-terminal-emulator, gnome-terminal, konsole, xterm on PATH runs
//             `sh -c` with the command as separate arguments; it waits for Enter before closing.
// Owns: building and starting the launch (a light supervisor lease that ends when the window
// closes – on macOS and gnome-terminal when the launcher returns). Never: reads what the person
// types, logs the command or its environment, or builds a shell string from unquoted input.

import * as path from 'node:path';
import { promises as fsp, constants as fsConstants } from 'node:fs';
import type { Lease, Supervisor } from '../system/supervisor.ts';
import type { Executable } from './executables.ts';
import { WorkforceError } from '../../shared/errors.ts';

export interface TerminalRequest {
  exe: Executable;
  /** CLI arguments after the executable's own prefix, e.g. ['login']. */
  args: string[];
  /** The complete child environment (keys already stripped, the account's variables included). */
  env: NodeJS.ProcessEnv;
  /** The account's own variables (KIMI_CODE_HOME …): written into the command where the terminal does not inherit `env`. */
  extra: Record<string, string>;
  title: string;
  /** Folder the launcher and the window it opens start in (macOS: `cd` first) – never the workspace. */
  cwd?: string;
}

export interface TerminalLaunch { command: string; args: string[]; env: NodeJS.ProcessEnv }

export interface TerminalDeps {
  supervisor: Supervisor;
  platform: NodeJS.Platform;
  /** Resolves when `file` exists and is executable (Linux terminal lookup on PATH). */
  access(file: string): Promise<void>;
}

export const CLOSE_PROMPT = 'Press Enter to close this window';
const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];

/** PowerShell -EncodedCommand: base64 of UTF-16LE. */
export const encodePowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

/** POSIX single quotes ('it'\''s'). */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The visible window: runs the CLI with the arguments from the environment, then waits for Enter. */
const WINDOW_SCRIPT = [
  '$Host.UI.RawUI.WindowTitle = $env:WORKFORCE_TERMINAL_TITLE',
  '$argv = @(ConvertFrom-Json $env:WORKFORCE_TERMINAL_ARGS)',
  '& $env:WORKFORCE_TERMINAL_EXE @argv',
  "Write-Host ''",
  `Read-Host '${CLOSE_PROMPT}' | Out-Null`,
].join('\n');

/**
 * The hidden launcher: opens the window above and returns when that window closed. Not
 * `Start-Process -Wait`: Windows PowerShell 5.1 then waits for every process the window started
 * too, such as a browser `auth login` opened for OAuth, so the sign-in would seem open until the
 * browser closes.
 */
const LAUNCH_SCRIPT = [
  `$window = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-EncodedCommand','${encodePowerShell(WINDOW_SCRIPT)}' -WindowStyle Normal -PassThru`,
  '$window.WaitForExit()',
].join('\n');

/** `sh -c` body: runs "$@", then waits for Enter so the person can read the result. */
const SH_SCRIPT = `"$@"; printf '\\n%s ' ${shellQuote(`${CLOSE_PROMPT}.`)}; read -r _`;

/** How to open `request` in a visible terminal on `platform`; `terminal` is the Linux emulator found on PATH. */
export function terminalLaunch(platform: NodeJS.Platform, request: TerminalRequest, terminal?: string): TerminalLaunch {
  const argv = [...request.exe.prefixArgs, ...request.args];
  if (platform === 'win32') {
    const root = request.env.SystemRoot ?? request.env.SYSTEMROOT ?? 'C:\\Windows';
    return {
      command: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(LAUNCH_SCRIPT)],
      env: { ...request.env, WORKFORCE_TERMINAL_EXE: request.exe.command, WORKFORCE_TERMINAL_ARGS: JSON.stringify(argv), WORKFORCE_TERMINAL_TITLE: request.title },
    };
  }
  const assignments = Object.entries(request.extra).map(([key, value]) => `${key}=${value}`);
  if (platform === 'darwin') {
    const command = ['env', ...assignments, request.exe.command, ...argv].map(shellQuote).join(' ');
    const line = request.cwd ? `cd ${shellQuote(request.cwd)} && ${command}` : command; // Terminal's shell starts in the home folder
    return {
      command: '/usr/bin/osascript',
      args: ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', line],
      env: request.env,
    };
  }
  if (!terminal) throw new WorkforceError('unavailable', 'No terminal app was found to open the sign-in. Install a terminal (for example xterm) and try again.');
  const run = ['sh', '-c', SH_SCRIPT, 'sh', 'env', ...assignments, request.exe.command, ...argv];
  const name = path.posix.basename(terminal);
  const args = name === 'gnome-terminal' ? ['--', ...run] // newer versions dropped --title
    : name === 'konsole' ? ['-e', ...run]
      : ['-T', request.title, '-e', ...run]; // x-terminal-emulator (Debian policy: -T and -e) and xterm
  return { command: terminal, args, env: request.env };
}

/** The first Linux terminal emulator on PATH. */
export async function findTerminal(env: NodeJS.ProcessEnv, access: TerminalDeps['access']): Promise<string | undefined> {
  const dirs = (env.PATH ?? '').split(':').filter((dir) => path.posix.isAbsolute(dir));
  for (const name of LINUX_TERMINALS) {
    for (const dir of dirs) {
      const file = path.posix.join(dir, name);
      try { await access(file); return file; } catch { /* next */ }
    }
  }
  return undefined;
}

/** Opens `request` in a visible terminal window; the lease ends when the window (or its launcher) is gone. */
export async function openTerminal(deps: Pick<TerminalDeps, 'supervisor'> & Partial<TerminalDeps>, request: TerminalRequest, owner: string): Promise<Lease> {
  const platform = deps.platform ?? process.platform;
  const access = deps.access ?? ((file: string) => fsp.access(file, fsConstants.X_OK));
  const terminal = platform === 'win32' || platform === 'darwin' ? undefined : await findTerminal(request.env, access);
  const launch = terminalLaunch(platform, request, terminal);
  return deps.supervisor.spawn({ command: launch.command, args: launch.args, owner, kind: 'light', cwd: request.cwd, env: launch.env, stdio: ['ignore', 'ignore', 'ignore'] });
}
