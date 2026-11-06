// Filesystem layout of one installation.
// Owns: where data, workspace, resources, blobs, account homes, logs, temp and the engine folder live,
// and creating those directories. Never: reads or writes files inside them.
//
// Layout (data = Electron userData or the headless data dir):
//   <data>/workforce.db        SQLite store
//   <data>/blobs/ab/cd/<sha>   content-addressed files
//   <data>/accounts/<id>/      isolated CLI homes (CODEX_HOME, CLAUDE_CONFIG_DIR …)
//   <data>/theme.css           the app's look (root/theme.ts; the old custom/ overlay folder is no longer used)
//   <data>/logs/               rotating runtime log
//   <data>/tmp/                scratch (cleared by its users, never relied upon)
//   <data>/engine-cwd/         empty folder CLI engine processes start in (engineCwd): never a turn's
//                              folder or writable root, nothing writes there – a CLI loads project
//                              config from its process folder
//   <data>/engine-prompts/     B-049 F3: the replacement system prompt files of ACP plan CLIs (enginePromptDir;
//                              engines/acp/providers.ts writes them, e.g. GEMINI_SYSTEM_MD)
//   <data>/bin/                the agents' wf shim (engines/wf-shim.ts), first on their PATH
//   <home>/Workforce/         human/AI-readable workspace (agents' cwd, artifacts)

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Paths } from '../contracts.ts';

export interface PathsInput {
  data: string; // userData directory given by the host
  resources: string; // shipped resources directory (skills, modes, agent templates)
  home?: string; // defaults to os.homedir()
  workspace?: string; // override (from settings later); default <home>/Workforce
  temp?: string; // default <data>/tmp
}

export function createPaths(input: PathsInput): Paths {
  const data = path.resolve(input.data);
  const home = input.home ?? os.homedir();
  return {
    data,
    workspace: path.resolve(input.workspace ?? path.join(home, 'Workforce')),
    resources: path.resolve(input.resources),
    blobs: path.join(data, 'blobs'),
    accounts: path.join(data, 'accounts'),
    logs: path.join(data, 'logs'),
    temp: path.resolve(input.temp ?? path.join(data, 'tmp')),
  };
}

/** The empty folder engine processes (Codex app-server, ACP agents) start in; created by ensurePaths. */
export function engineCwd(paths: Pick<Paths, 'data'>): string {
  return path.join(paths.data, 'engine-cwd');
}

/** B-049 F3: the app's own folder for ACP plan CLIs' replacement system prompts (created by its writer on first use). */
export function enginePromptDir(paths: Pick<Paths, 'data'>): string {
  return path.join(paths.data, 'engine-prompts');
}

/** Creates every writable directory (resources is read-only and never created). */
export function ensurePaths(paths: Paths): Paths {
  for (const dir of [paths.data, paths.workspace, paths.blobs, paths.accounts, paths.logs, paths.temp, engineCwd(paths)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

/** Path of the SQLite database inside the data dir. */
export function databasePath(paths: Paths): string {
  return path.join(paths.data, 'workforce.db');
}
