// Official installers for the engine CLIs, so a PC without Node.js gets a working CLI (B-051 L1).
// Claude Code: its official native installer (code.claude.com/docs/en/setup, ported from legacy
// accounts.cjs). Codex: its official standalone installer first (chatgpt.com/codex/install.ps1 on
// Windows → %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe, install.sh elsewhere → ~/.local/bin;
// CODEX_NON_INTERACTIVE=1 and redirected stdio answer every prompt "no"); `npm i -g @openai/codex` only
// when that route failed and npm exists. A route counts once the finder sees the CLI (fresh PATH).
// B-051 integration: demo mode (WORKFORCE_FAKE_ENGINE, e2e and window tests) never runs a real installer.
// Owns: the fixed install commands, their order and their 5-minute timeout (per route).
// Never: builds commands from user input (all arguments are constants), runs as admin, or installs in demo mode.

import type { Supervisor } from '../system/supervisor.ts';
import type { Executable, ExecutableFinder } from './executables.ts';
import { WorkforceError } from '../../shared/errors.ts';

const NPM_PACKAGES = { codex: '@openai/codex' } as const;
export const INSTALL_FAILED = {
  claude: 'Could not install Claude Code. Check your connection and try again.',
  codex: 'Could not install Codex. Check your connection and try again.',
} as const;
/** Demo mode: the fake engine needs no CLI, and a real installer must never run there. */
export const INSTALL_OFF_IN_DEMO = 'The demo does not install programs.';
const INSTALL_MS = 5 * 60_000;

/** One install command: constant arguments, the env it runs with (undefined = the inherited one). */
export interface InstallRoute { command: string; args: string[]; env?: NodeJS.ProcessEnv }

export interface InstallDeps { supervisor: Supervisor; finder: ExecutableFinder; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number; demo?: boolean }

/** Claude Code's official native installer (stable channel). */
export function claudeInstaller(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): InstallRoute {
  return platform === 'win32'
    ? { command: 'powershell.exe', env, args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://claude.ai/install.ps1'))) stable; if (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.local/bin/claude.exe'))) { exit 1 }"] }
    : { command: '/bin/bash', env, args: ['-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s stable'] };
}

/** Codex's official standalone installer; the caller's env (never dropped: PATH, SystemRoot …) plus CODEX_NON_INTERACTIVE=1. */
export function codexInstaller(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): InstallRoute {
  const quiet: NodeJS.ProcessEnv = { ...(env ?? process.env), CODEX_NON_INTERACTIVE: '1' };
  return platform === 'win32'
    ? { command: 'powershell.exe', env: quiet, args: ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://chatgpt.com/codex/install.ps1'))); if (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin\\codex.exe'))) { exit 1 }"] }
    : { command: '/bin/bash', env: quiet, args: ['-c', 'set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh'] };
}

/** `npm install -g <package>` (Codex's fallback); npm.cmd cannot be spawned without a shell – all arguments are constants, so cmd /c is safe. */
export function npmInstaller(npm: Executable, platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): InstallRoute {
  if (platform === 'win32' && npm.path.toLowerCase().endsWith('.cmd') && npm.command === npm.path) {
    return { command: 'cmd.exe', env, args: ['/d', '/s', '/c', 'npm', 'install', '-g', NPM_PACKAGES.codex] };
  }
  return { command: npm.command, env, args: [...npm.prefixArgs, 'install', '-g', NPM_PACKAGES.codex] };
}

/** Installs the CLI unless the finder already sees it; true when it was installed now. Throws INSTALL_FAILED when every route failed. */
export async function installCli(provider: 'claude' | 'codex', deps: InstallDeps): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (await deps.finder.find(provider, { force: true })) return false; // already installed
  if (deps.demo) throw new WorkforceError('unavailable', INSTALL_OFF_IN_DEMO);
  if (provider === 'claude') {
    if (await runRoute(claudeInstaller(platform, deps.env), provider, deps)) return true;
  } else {
    if (await runRoute(codexInstaller(platform, deps.env), provider, deps)) return true;
    const npm = await deps.finder.find('npm', { force: true }); // Node may have been installed meanwhile
    if (npm && await runRoute(npmInstaller(npm, platform, deps.env), provider, deps)) return true;
  }
  throw new WorkforceError('unavailable', INSTALL_FAILED[provider]);
}

/** Runs one route to its end (or the timeout); true when it exited 0 and the CLI is found now. */
async function runRoute(route: InstallRoute, provider: 'claude' | 'codex', deps: InstallDeps): Promise<boolean> {
  let code: number | null;
  try {
    const lease = deps.supervisor.spawn({ command: route.command, args: route.args, owner: `install:${provider}`, kind: 'light', env: route.env, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { void lease.release(); }, deps.timeoutMs ?? INSTALL_MS);
    timer.unref?.();
    code = await lease.exited;
    clearTimeout(timer);
  } catch {
    code = null; // could not start (no PowerShell or bash)
  }
  deps.finder.clear();
  return code === 0 && Boolean(await deps.finder.find(provider, { force: true }));
}
