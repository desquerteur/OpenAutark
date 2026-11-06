// Workspace file and shell tools. files.write is for engines that bring no tools of their own (HTTP APIs, local
// models; CLI engines such as Codex and Claude Code use their native tools) and runs on this PC. shell.exec is direct
// for those engines (tools/core-sets.ts) and reachable for every engine through tools.find / tools.call – a CLI engine
// uses it for a linked PC's terminal. files.read and files.list are offered to every engine. A path is relative to the
// workspace or absolute anywhere on this PC – the data folder included (agents work on the whole PC). Only an explicit
// `device` naming a linked PC sends a read there (its 'tools.call', devices/tools.ts runRemoteTool); shell.exec is a
// remote tool – with `device` (or an agent homed on another PC) the terminal of that PC runs it.
// B-061: a command without cwd runs in the folder of a split part (its own worktree, else its group's – ToolContext.split.cwd), else
// in the workspace (commandCwd; shell.exec and secrets.run).
// B-044: shell.exec takes `env`, whose values may hold secret://<id> handles resolved at spawn (command.ts, secrets/handles.ts).
// Owns: files.read, files.write, files.list, shell.exec, the path rule (resolvePath) and the resource of a workspace
// path (workspaceResource: one spelling per file); isInside / realInside for the worktrees (git/).
// Never: lets a command run unbounded (timeout + output cap; killed on run abort).

import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActionDescription, ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { resolveDevice } from '../placement.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { clip, defineTool } from './util.ts';
import { commandAction, ENV_SCHEMA, runCommand } from './command.ts';
import { searchTool } from './files-search.ts';
import { LINE_READ_BYTES, lineWindow } from './file-window.ts';

const MAX_READ = 256 * 1024;
const outside = () => new WorkforceError('forbidden', 'Path is outside the folder.');

/** A path as given: relative to the workspace, or absolute anywhere on this PC. */
export function resolvePath(ctx: Pick<ToolContext, 'services'>, given: string | undefined): string {
  return path.resolve(ctx.services.paths.workspace, given ?? '.');
}


/** Where a command runs: `cwd` as given (resolvePath); without one, a split part's own folder (its worktree), else the workspace. */
export function commandCwd(ctx: Pick<ToolContext, 'services' | 'split'>, given: string | undefined): string {
  const asked = given?.trim();
  return asked ? resolvePath(ctx, asked) : ctx.split?.cwd ?? resolvePath(ctx, undefined);
}

/** True when `target` is `root` or below it (path.relative folds case on Windows). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The real path of `target`: of its deepest existing ancestor, plus the parts that do not exist yet. */
async function realExisting(target: string): Promise<string> {
  const rest: string[] = [];
  let probe = target;
  for (;;) {
    try { return path.join(await realpath(probe), ...rest); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WorkforceError('forbidden', 'This path cannot be checked (no access or a broken link).');
      const parent = path.dirname(probe);
      if (parent === probe) throw outside();
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolves `relative` inside `root` with symlinks and junctions followed: a link inside the
 * workspace that points elsewhere counts as outside. Returns the real path; throws 'forbidden'.
 */
export async function realInside(root: string, relative: string | undefined): Promise<string> {
  const base = path.resolve(root);
  const target = path.resolve(base, relative ?? '.');
  if (!isInside(base, target)) throw outside();
  const realBase = await realpath(base).catch(() => base);
  const real = await realExisting(target);
  if (!isInside(realBase, real)) throw outside();
  return real;
}

/** The real path of a read on this PC (resolvePath, links followed); a linked PC's call reads only in its workspace. */
export async function readPath(ctx: ToolContext, given: string | undefined): Promise<string> {
  if (ctx.fromPc !== undefined) return realInside(ctx.services.paths.workspace, given);
  const target = resolvePath(ctx, given);
  return realpath(target).catch(() => target);
}

/** realExisting for describe() (sync): the same walk with the same native realpath. */
function realExistingSync(target: string): string {
  const rest: string[] = [];
  let probe = target;
  for (;;) {
    try { return path.join(realpathSync.native(probe), ...rest); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(probe);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === probe) throw error;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * The resource of a workspace path: its real path relative to the real workspace root,
 * '/'-separated ('.' = the root). './a', 'b/../a', an absolute path into the workspace and a link
 * to the file all give one spelling, so a deny or ask rule that names the path holds for each of
 * them – here and when a linked PC asks (devices/file-peer.ts). A path outside the workspace, or
 * one that cannot be checked, keeps its spelling: the tool refuses it anyway.
 */
export function workspaceResource(root: string, relative: string | undefined): string {
  const given = relative ?? '.';
  try {
    const base = path.resolve(root);
    let realBase = base;
    try { realBase = realpathSync.native(base); } catch { /* not created yet: as written */ }
    const real = realExistingSync(path.resolve(base, given));
    if (!isInside(realBase, real)) return given;
    return path.relative(realBase, real).split(path.sep).join('/') || '.';
  } catch {
    return given;
  }
}

/** files.read / files.list `device`: unlike a remote tool's, its default is this PC (see the header). */
const READ_DEVICE = Object.freeze({
  type: 'string', minLength: 1, maxLength: 120,
  description: 'A linked PC to read on (name or id from devices.list); it must allow "Use files" for this PC.',
});

type Linked = { id: string; name: string } | { error: string } | undefined;

/** The linked PC an explicit `device` names; undefined for none or this PC. */
function linkedPc(ctx: ToolContext, device: string | undefined): Linked {
  if (device === undefined) return undefined;
  const target = resolveDevice(ctx.services, device);
  if ('error' in target) return target;
  return target.self || !target.id ? undefined : { id: target.id, name: target.name };
}

/** The path a read is judged by – here the real workspace path; on a linked PC (which judges its own path) the plainly normalized one – and ' on <that PC>'. */
function readTarget(ctx: ToolContext, device: string | undefined, given: string | undefined): { path: string; on: string } {
  const there = linkedPc(ctx, device);
  if (there && !('error' in there)) return { path: path.posix.normalize((given ?? '.').replace(/\\/g, '/')), on: ` on ${there.name}` };
  return { path: workspaceResource(ctx.services.paths.workspace, given), on: '' };
}

/** What a read asks for (readTarget); the summary names a linked PC. */
function describeRead(ctx: ToolContext, device: string | undefined, summary: string, given: string | undefined): ActionDescription {
  const target = readTarget(ctx, device, given);
  return { summary: `${summary}${target.on}`, resource: target.path, reversible: true, external: false };
}

/** Runs the read on the linked PC (its 'tools.call', never forwarded further); errors reach the registry as failures. */
async function readThere(ctx: ToolContext, there: { id: string }, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const input = { ...args };
  delete input.device;
  const result = await ctx.services.devices.call(there.id, 'tools.call', {
    name, args: input, agentId: ctx.agent.id, agentName: ctx.agent.name, runId: ctx.runId, conversationId: ctx.conversationId, taskId: ctx.taskId, mode: ctx.mode,
  }, ctx.signal);
  const output = result as ToolOutput | undefined;
  return output && Array.isArray(output.content) ? output : text(typeof result === 'string' ? result : JSON.stringify(result ?? null));
}

export type ShellSpawn = (command: string, options: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv }) => {
  stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): boolean;
};

export const defaultShell: ShellSpawn = (command, options) => {
  const child = nodeSpawn(command, { cwd: options.cwd, env: options.env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => {
    if (process.platform === 'win32' && child.pid) {
      nodeSpawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { child.kill(); });
    } else {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  };
  options.signal.addEventListener('abort', kill, { once: true });
  child.once('close', () => options.signal.removeEventListener('abort', kill));
  child.once('error', () => options.signal.removeEventListener('abort', kill));
  if (options.signal.aborted) kill();
  return child;
};

/** The resource of a shell command: its text (whitespace folded, clipped) and the working folder. */
export function shellResource(command: string, cwd: string | undefined): string {
  return `${clip(command.trim().replace(/\s+/g, ' '), 300)}@${cwd?.trim() || '.'}`;
}

export function fileTools(deps: { shell?: ShellSpawn } = {}): ToolDef[] {
  const shell = deps.shell ?? defaultShell;

  const readFileTool = defineTool<{ path: string; maxBytes?: number; fromLine?: number; lines?: number; device?: string }>({
    name: 'files.read',
    description: 'Read a text file by workspace path, or by absolute path anywhere on this PC.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ }, fromLine: { type: 'integer', minimum: 1 }, lines: { type: 'integer', minimum: 1 }, device: { ...READ_DEVICE } }, required: ['path'], additionalProperties: false },
    category: 'read',
    describe: (args, ctx) => describeRead(ctx, args.device, `Read ${args.path}`, args.path),
    async run(args, ctx) {
      const there = linkedPc(ctx, args.device);
      if (there) return 'error' in there ? failure(there.error) : readThere(ctx, there, 'files.read', args);
      const file = await readPath(ctx, args.path);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return failure(`No file at ${args.path}.`);
      // Only the bytes needed are read: the start (maxBytes, default MAX_READ), or up to LINE_READ_BYTES for lines
      // further down – a big file (or one a linked PC asks for) never fills memory. B-048: lines in windows (file-window.ts).
      const limit = args.fromLine !== undefined && args.fromLine > 1 ? LINE_READ_BYTES : (args.maxBytes ?? MAX_READ);
      const handle = await open(file, 'r');
      let body: string;
      try {
        const buffer = Buffer.alloc(Math.min(limit, info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        body = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      return text(lineWindow(body, args, info.size <= limit));
    },
  });
  const writeFileTool = defineTool<{ path: string; content: string; append?: boolean }>({
    name: 'files.write',
    description: 'Create or overwrite a text file: a workspace path, or an absolute path anywhere on this PC (folders are created).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string', maxLength: 2_000_000 }, append: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false },
    category: 'write_local', audience: 'http',
    describe: (args) => ({ summary: `Write ${args.path}`, external: false }),
    async run(args, ctx) {
      const file = resolvePath(ctx, args.path);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, args.content, { encoding: 'utf8', flag: args.append ? 'a' : 'w' });
      return json({ ok: true, path: file, bytes: Buffer.byteLength(args.content) });
    },
  });

  const listDir = defineTool<{ path?: string; device?: string }>({
    name: 'files.list',
    description: "List a folder: a workspace path or an absolute path anywhere on this PC, or with device a linked PC's workspace.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 }, device: { ...READ_DEVICE } }, additionalProperties: false },
    category: 'read',
    describe: (args, ctx) => describeRead(ctx, args.device, `List ${args.path ?? '.'}`, args.path),
    async run(args, ctx) {
      const there = linkedPc(ctx, args.device);
      if (there) return 'error' in there ? failure(there.error) : readThere(ctx, there, 'files.list', args);
      const dir = await readPath(ctx, args.path);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
      if (!entries) return failure(`No folder at ${args.path ?? '.'}.`);
      const lines = entries.slice(0, 500).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
      return text(lines.length ? lines.join('\n') : '(empty)');
    },
  });

  const shellExec = defineTool<{ command: string; cwd?: string; timeoutSeconds?: number; env?: Record<string, string> }>({
    name: 'shell.exec',
    description: 'Run a shell command on this PC or, with device, on a linked PC (devices.list) – engines with a shell of their own use it for a linked PC. cwd: a workspace path or an absolute folder anywhere there, default the workspace (a split part: its own folder). Output is capped. At a timeout it gets more seconds or is aborted; the decision accompanies the result. A secret goes in by handle: env {"API_KEY": "secret://<id>"}.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 8000 }, cwd: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Seconds until the first timeout review; default estimated from the command (search 15, install 300, build/test 180, other 60).' }, env: { ...ENV_SCHEMA } }, required: ['command'], additionalProperties: false },
    category: 'write_system', remote: true,
    describe: (args, ctx) => commandAction(ctx, { summary: `Run: ${clip(args.command, 200)}`, resource: shellResource(args.command, args.cwd), reversible: false, external: false }, args.env),
    async run(args, ctx) {
      const cwd = commandCwd(ctx, args.cwd);
      return runCommand(shell, ctx, { command: args.command, cwd, timeoutSeconds: args.timeoutSeconds, env: args.env });
    },
  });

  return [readFileTool, writeFileTool, listDir, shellExec, searchTool({ resolve: readPath })];
}

