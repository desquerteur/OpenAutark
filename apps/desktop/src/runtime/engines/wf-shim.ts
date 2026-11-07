// The agents' `wf` (B-072): engine processes (Codex app-server, Claude Code, ACP agents) and their shells find the
// app's terminal client first on PATH. <data>/bin holds `wf` (sh: Git Bash, macOS, Linux) and on Windows `wf.cmd`
// (cmd, PowerShell). Both run app/wf.mjs – the bundle beside this runtime's own, app.asar.unpacked when packaged
// (package.json asarUnpack) – with this process's binary as Node: the app's Electron through ELECTRON_RUN_AS_NODE,
// set for that one call (node ignores it). The folder comes first, so on Windows `wf` is never system32\WF.msc
// (the firewall console). AUTARK_DATA names the data folder, so wf reaches this runtime (wf-cli/discover.ts).
// Owns: the shim texts, writing them (only what changed, LF), the PATH order and AUTARK_DATA of the agents' env.
// Never: puts a token, secret or env value into the files, or fails an engine start (no wf.mjs or a write error:
// PATH stays as it was).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackedPath } from '../computer/service.ts';
import { AGENT_TOKEN_ENV } from '../../shared/api/protocol.ts';

export interface ShimFile { name: string; text: string }

const NOTE = "Autark's wf client, kept up to date by the app (changes here are replaced).";

/** <data>/bin: the agents' own commands. */
export function shimDir(data: string): string {
  return path.join(data, 'bin');
}

/** app/wf.mjs beside the runtime bundle (app/runtime.mjs, app/runtime-cli.mjs); packaged: in app.asar.unpacked. */
export function wfEntry(bundleFile: string): string {
  return unpackedPath(path.join(path.dirname(bundleFile), 'wf.mjs'));
}

/** `wf` (sh) and on Windows `wf.cmd`, both running `entry` with `executable` as Node; `dir` is where they lie. */
export function shimFiles(launch: { executable: string; entry: string }, platform: NodeJS.Platform, dir: string): ShimFile[] {
  const lines = (...rows: string[]) => `${rows.join('\n')}\n`;
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`; // sh: every other character as it is
  if (platform !== 'win32') {
    return [{ name: 'wf', text: lines('#!/bin/sh', `# ${NOTE}`, 'export ELECTRON_RUN_AS_NODE=1', `exec ${quote(launch.executable)} ${quote(launch.entry)} "$@"`) }];
  }
  // Windows: the shells read these files in their own code page, so a path on the shim's drive is written relative
  // to the shim's folder, which each shell takes from Windows itself (Git Bash: `pwd -W`, as C:/…; cmd: %~dp0) –
  // a name such as C:\Users\Jürgen never stands in the files. A path on another drive stays absolute.
  const relative = (file: string) => {
    const rel = path.win32.relative(dir, file);
    return path.win32.isAbsolute(rel) ? undefined : rel;
  };
  const sh = (file: string) => {
    const rel = relative(file);
    return rel === undefined ? quote(file.replace(/\\/g, '/')) : `"$d"${quote(`/${rel.replace(/\\/g, '/')}`)}`;
  };
  const cmd = (file: string) => {
    const rel = relative(file);
    return `"${rel === undefined ? file.replace(/%/g, '%%') : `%~dp0${rel.replace(/%/g, '%%')}`}"`;
  };
  return [{
    name: 'wf', // builtins only: a Git Bash started without its own PATH has no dirname
    text: lines('#!/bin/sh', `# ${NOTE}`, 'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac', 'd=$(CDPATH= cd -- "$d" && pwd -W)',
      'export ELECTRON_RUN_AS_NODE=1', `exec ${sh(launch.executable)} ${sh(launch.entry)} "$@"`),
  }, {
    name: 'wf.cmd', // setlocal keeps the switch out of the caller
    text: lines('@echo off', `rem ${NOTE}`, 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `${cmd(launch.executable)} ${cmd(launch.entry)} %*`),
  }];
}

/** Writes the files whose text differs (LF, `wf` executable); false when the folder cannot be written. */
function writeShim(dir: string, files: ShimFile[]): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = path.join(dir, file.name);
      let current: string | undefined;
      try { current = readFileSync(target, 'utf8'); } catch { current = undefined; }
      if (current !== file.text) writeFileSync(target, file.text, { mode: 0o755 });
    }
    return true;
  } catch {
    return false;
  }
}

/** `base` plus AUTARK_DATA, and `dir` first on PATH (once; on Windows under the variable's own spelling, e.g. Path). */
export function withShim(base: NodeJS.ProcessEnv, data: string, dir: string | undefined, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, AUTARK_DATA: data };
  delete env[AGENT_TOKEN_ENV]; // AF-001: an agent identity this runtime inherited is never passed on – each agent gets its own (agent-token.ts)
  if (!dir) return env;
  const key = (platform === 'win32' ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') : undefined) ?? 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  env[key] = [dir, ...(env[key] ?? '').split(separator).filter((part) => part && part !== dir)].join(separator);
  return env;
}

export interface AgentEnvOptions {
  env?: NodeJS.ProcessEnv; // default process.env
  platform?: NodeJS.Platform; // default process.platform
  executable?: string; // default process.execPath (the app's Electron, or node for the headless runtime)
  entry?: string; // default app/wf.mjs beside this bundle (wfEntry)
}

/**
 * The env for engine processes: AUTARK_DATA = `data`, and <data>/bin first on PATH once the shim is written there.
 * Without app/wf.mjs (unit tests, a runtime run from source) nothing is written and PATH stays as it was.
 */
export function agentEnv(data: string, options: AgentEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const entry = options.entry ?? wfEntry(fileURLToPath(import.meta.url));
  const dir = shimDir(data);
  const ready = existsSync(entry) && writeShim(dir, shimFiles({ executable: options.executable ?? process.execPath, entry }, platform, dir));
  return withShim(options.env ?? process.env, data, ready ? dir : undefined, platform);
}
