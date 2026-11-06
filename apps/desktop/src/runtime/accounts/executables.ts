// Finds the official CLIs (codex, claude, gemini, copilot, kimi …) on this PC.
// B-051 L2: a forced lookup (`find(id, { force: true })`, e.g. before and after an install) on Windows
// also searches the PATH as Windows has it now (FinderEnv.freshPath – fresh-path.ts, wired by
// defaultFinderEnv), so Node.js or a CLI installed while the app runs is found without a restart; the
// standalone Codex installer's %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe is a fixed candidate.
// Owns: candidate paths (ported from legacy accounts.cjs findExecutable), Windows npm `.cmd` shim
// resolution to the real `.exe`/script, and a cache so discovery runs once per process.
// Never: executes anything itself (the fresh PATH comes from the injected reader) or reads files other
// than a `.cmd` shim's few text lines.

import { promises as fsp, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { freshPath } from './fresh-path.ts';

export type CliId = 'codex' | 'claude' | 'gemini' | 'copilot' | 'kimi' | 'tailscale' | 'npm' | 'node';

/** How to start a CLI: `command` plus fixed leading args (e.g. node + script for js shims). */
export interface Executable {
  command: string;
  prefixArgs: string[];
  path: string; // the file that was found (shim or binary)
}

export interface FsLike {
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtimeMs?: number }>;
  access(p: string, mode: number): Promise<void>;
  readdir(p: string): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>>;
  readFile(p: string): Promise<string>;
}

export interface FinderEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  fs: FsLike;
  /** Windows: the machine + current user PATH as the registry has it now (forced lookups only); undefined = unknown. */
  freshPath?: () => Promise<string | undefined>;
}

/** What Codex's code mode runs scripts in (every tool call of an agent), beside its codex.exe. */
const CODEX_HELPER = 'codex-code-mode-host.exe';

export function defaultFinderEnv(): FinderEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    freshPath: freshPath(), // a private supervisor until composition hands its own (fresh-path.ts)
    fs: {
      stat: (p) => fsp.stat(p),
      access: (p, mode) => fsp.access(p, mode),
      readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
      readFile: (p) => fsp.readFile(p, 'utf8'),
    },
  };
}

export class ExecutableFinder {
  private readonly cache = new Map<CliId, Promise<Executable | null>>();
  private readonly deps: FinderEnv;

  constructor(deps: FinderEnv = defaultFinderEnv()) {
    this.deps = deps;
  }

  find(id: CliId, options: { force?: boolean } = {}): Promise<Executable | null> {
    if (options.force) this.cache.delete(id);
    let found = this.cache.get(id);
    if (!found) {
      found = this.locate(id, options.force === true).catch(() => null);
      this.cache.set(id, found);
    }
    return found;
  }

  /** Forget everything (after an install). */
  clear(): void {
    this.cache.clear();
  }

  private async locate(id: CliId, force: boolean): Promise<Executable | null> {
    const { platform, env, home, fs } = this.deps;
    const win = platform === 'win32';
    const join = win ? path.win32.join : path.posix.join;
    const names = win ? [`${id}.exe`, `${id}.cmd`] : [id];
    const candidates: string[] = [];
    const dirs: string[] = [];
    if (win && id === 'claude' && env.APPDATA) candidates.push(join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    dirs.push(join(home, '.local', 'bin'), join(home, 'bin'));
    const last: string[] = [];
    if (win && id === 'codex' && env.LOCALAPPDATA) {
      // B-051 L1: the official standalone installer's place (install.ts) and the Codex desktop app's CLI in a hashed sub-folder.
      const standalone = join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      const app: string[] = [];
      await this.scan(join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'), 'codex.exe', app, 0);
      const { usable, lone } = await this.byCodexHelper(app);
      candidates.push(...usable, standalone);
      last.push(...lone);
    }
    if (win && id === 'tailscale') candidates.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'));
    if (win && env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
    const delimiter = win ? ';' : ':';
    for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) dirs.push(dir);
    if (win && force && this.deps.freshPath) {
      // B-051 L2: what was added to the user or machine PATH since this process started (an install meanwhile).
      const fresh = await this.deps.freshPath().catch(() => undefined);
      const known = new Set(dirs.map((dir) => dir.toLowerCase()));
      for (const dir of (fresh ?? '').split(';').map((part) => part.trim()).filter(Boolean)) if (!known.has(dir.toLowerCase())) { known.add(dir.toLowerCase()); dirs.push(dir); }
    }
    if (!win) dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
    for (const dir of dirs) for (const name of names) candidates.push(join(dir, name));
    candidates.push(...last);
    for (const candidate of candidates) {
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, win ? fsConstants.F_OK : fsConstants.X_OK);
      } catch { continue; }
      if (win && candidate.toLowerCase().endsWith('.cmd')) {
        const resolved = await this.resolveShim(candidate, force);
        if (resolved) return resolved;
        // npm's own shim is not a simple cmd-shim; callers run it via `cmd /c` with constant args only.
        if (id === 'npm') return { command: candidate, prefixArgs: [], path: candidate };
        continue; // never run other .cmd files through a shell (argument quoting is unsafe)
      }
      return { command: candidate, prefixArgs: [], path: candidate };
    }
    return null;
  }

  /**
   * An update of the Codex desktop app leaves the old hashed folder behind with a codex.exe alone, and every tool call
   * of that one fails ("failed to spawn code-mode host"). The folders with the helper beside it come first, newest first;
   * a codex.exe alone comes after every other install on this PC (still better than none: engines/code-mode.ts says what is wrong).
   */
  private async byCodexHelper(found: string[]): Promise<{ usable: string[]; lone: string[] }> {
    const rated = await Promise.all(found.map(async (exe) => ({
      exe,
      helper: await this.deps.fs.stat(path.win32.join(path.win32.dirname(exe), CODEX_HELPER)).then((s) => s.isFile(), () => false),
      time: await this.deps.fs.stat(exe).then((s) => s.mtimeMs ?? 0, () => 0),
    })));
    rated.sort((a, b) => b.time - a.time);
    return { usable: rated.filter((one) => one.helper).map((one) => one.exe), lone: rated.filter((one) => !one.helper).map((one) => one.exe) };
  }

  private async scan(dir: string, file: string, out: string[], depth: number): Promise<void> {
    const entries = await this.deps.fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      const full = path.win32.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === file) out.push(full);
      else if (entry.isDirectory() && depth < 4) await this.scan(full, file, out, depth + 1);
    }
  }

  /**
   * npm cmd-shims look like `"%dp0%\node_modules\pkg\bin\tool.exe"   %*` or
   * `"%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*`. Resolve to the target so we can spawn it
   * directly with an argument array (Node refuses to spawn .cmd without a shell).
   */
  private async resolveShim(shim: string, force: boolean): Promise<Executable | null> {
    let text: string;
    try { text = (await this.deps.fs.readFile(shim)).slice(0, 4096); } catch { return null; }
    const dir = path.win32.dirname(shim);
    const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+)"/gi)].map((m) => path.win32.join(dir, m[1]));
    for (const target of targets) {
      try { if (!(await this.deps.fs.stat(target)).isFile()) continue; } catch { continue; }
      const lower = target.toLowerCase();
      if (lower.endsWith('.exe')) return { command: target, prefixArgs: [], path: shim };
      if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) {
        const node = await this.find('node', { force }); // a forced lookup finds a Node.js installed meanwhile too
        if (node) return { command: node.command, prefixArgs: [...node.prefixArgs, target], path: shim };
      }
    }
    return null;
  }
}
