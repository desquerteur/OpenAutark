// The Claude Code engine's native rebuild state (B-048 E2): rebuilt sessions before their first turn, the
// CLI version (a turn's system/init, else `claude --version` once per process), the session ref after a
// turn on a rebuilt session, the engine's rebuild, probe and delete calls (rebuild.ts, transcript.ts), and the subconscious's
// calls as real tool_use + tool_result records before a resume (injectTrace: appended to the session's own transcript, so the
// prefix keeps its prompt cache; without a session a fresh transcript holding only them).
// Owns: that state and the file operations it needs (the disk unless the engine's FileOps give them).
// Never: spawns a turn, reads any file of an account home but the transcript of a session the app created, or writes anything
// else into a home that is not the app's own.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { Account } from '../../../shared/model/providers.ts';
import type { EngineRebuildInput, EngineRebuildResult, EngineTurnInput, RebuildProbe } from '../types.ts';
import { traceItems } from '../trace-text.ts';
import type { Supervisor } from '../../system/supervisor.ts';
import type { ExecutableFinder } from '../../accounts/executables.ts';
import { runCli } from '../../accounts/cli.ts';
import { claudeTranscript } from './transcript.ts';
import { cliModel } from './models.ts';
import { PROJECT_DIR_NAME, PROJECT_REF, deleteTranscripts, inside, lastRecord, probeClaudeRebuild, resumeTarget, sessionIdOf, writeTranscript, type RebuildFiles } from './rebuild.ts';

/** The engine's file operations this module uses (engine.ts FileOps). */
export interface BaseFiles {
  writeFile(file: string, data: string): Promise<void>;
  rm(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  rmDir?(dir: string): Promise<void>;
  size?(file: string): Promise<number | undefined>;
  folders?(dir: string): Promise<string[]>;
  tail?(file: string, maxBytes: number): Promise<string | undefined>;
  append?(file: string, data: string): Promise<void>;
}

/** How much of a transcript's end is read for its last record (a record can hold a long tool output). */
const TAIL_BYTES = 2 * 1024 * 1024;
/** The closing record behind the subconscious's calls (Claude Code reads a transcript ending on the user side as an interrupted turn). */
export const TRACE_END = '[End of these tool results]';
/** The hub offers tools.call in every agent turn, the tools a trace shows only once learned: its calls stand as tools.call, as in a rebuilt transcript (a model that reads one under its own name tries that name and fails, live 02.11.2026). */
const THROUGH_TOOLS_CALL: ReadonlySet<string> = new Set(['tools.call']);

async function readTail(file: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return undefined; } finally { await handle?.close().catch(() => undefined); }
}

const disk = {
  rmDir: (dir: string) => fsp.rm(dir, { recursive: true, force: true }),
  size: (file: string) => fsp.stat(file).then((stat) => (stat.isFile() ? stat.size : undefined), () => undefined),
  folders: (dir: string) => fsp.readdir(dir, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), () => [] as string[]),
  tail: readTail,
  append: (file: string, data: string) => fsp.appendFile(file, data),
};

/** 2.1.303 is the first version known to take `--thinking-display` (read from its CLI). */
export function takesThinkingDisplay(version: string | undefined): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')?.slice(1).map(Number);
  if (!parts) return false;
  const [major, minor, patch] = parts;
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 303)));
}

export interface ClaudeRebuilderDeps {
  supervisor: Supervisor;
  finder: ExecutableFinder;
  tempDir: string;
  files: BaseFiles;
  env?: NodeJS.ProcessEnv;
  envFor: (account: Account) => NodeJS.ProcessEnv;
  uuid: () => string;
  now: () => number;
  transcriptsDir?: string;
  accountsRoot?: string;
}

export class ClaudeRebuilder {
  readonly files: RebuildFiles;
  readonly transcriptsDir: string;
  /** Rebuilt session refs before their first turn. */
  readonly fresh = new Set<string>();
  private readonly deps: ClaudeRebuilderDeps;
  private version: string | undefined;
  private versionRead: Promise<string | undefined> | undefined;

  constructor(deps: ClaudeRebuilderDeps) {
    this.deps = deps;
    const files = deps.files;
    this.files = {
      writeFile: (file, data) => files.writeFile(file, data), mkdir: (dir) => files.mkdir(dir), rm: (file) => files.rm(file),
      rmDir: (dir) => (files.rmDir ?? disk.rmDir)(dir), size: (file) => (files.size ?? disk.size)(file), folders: (dir) => (files.folders ?? disk.folders)(dir),
      tail: (file, maxBytes) => (files.tail ?? disk.tail)(file, maxBytes), append: (file, data) => (files.append ?? disk.append)(file, data),
    };
    this.transcriptsDir = deps.transcriptsDir ?? path.join(deps.tempDir, 'engine-transcripts', 'claude');
  }

  /** A version a turn reported (system/init claude_code_version). */
  remember(version: string | undefined): void {
    if (version) this.version = version;
  }

  /** Agent turns ask for summarized thinking once the CLI is known to take the flag. */
  thinkingDisplay(): boolean {
    return takesThinkingDisplay(this.version);
  }

  /** Before a turn on `ref`: whether it is a rebuilt session's first turn, and our transcript's size (path tier). */
  async before(ref: string | undefined): Promise<{ rebuilt: boolean; grownFrom?: number }> {
    if (!ref) return { rebuilt: false };
    const target = resumeTarget(ref);
    return { rebuilt: this.fresh.delete(ref), grownFrom: target.path ? await this.files.size(target.path) : undefined };
  }

  /**
   * The session ref after a turn: a rebuilt session in the app's project folder keeps its tier prefix; one
   * resumed from our transcript path keeps the path while Claude Code appends to that file (2.1.303 adopts the
   * file's session id – whether it appends there or writes its own transcript was read from the CLI, not tested
   * live); only a completed turn that left the file as it was moves the ref to the reported session id, which a
   * later `--resume <id>` finds in the CLI's project folder (a failed turn keeps the path).
   */
  async nextRef(ref: string | undefined, grownFrom: number | undefined, reported: string, completed: boolean): Promise<string> {
    if (!ref) return reported;
    if (ref.startsWith(PROJECT_REF)) return `${PROJECT_REF}${reported.startsWith(PROJECT_REF) ? reported.slice(PROJECT_REF.length) : reported}`;
    const target = resumeTarget(ref);
    if (!target.path) return reported;
    const size = await this.files.size(target.path);
    const grew = size !== undefined && grownFrom !== undefined && size > grownFrom;
    return grew || !completed || reported === ref ? ref : reported;
  }

  /** Writes the ledger history as a fresh transcript for the probed tier; the next turn resumes it. */
  async rebuild(input: EngineRebuildInput): Promise<EngineRebuildResult> {
    const tier = input.probe?.tier ?? 'path';
    if (tier === 'project' && !this.ownHome(input.account)) throw new Error('the project tier needs an app-owned Claude home');
    const sessionId = this.deps.uuid();
    const { lines, records } = claudeTranscript(input.items, {
      sessionId, cwd: input.cwd, version: (await this.cliVersion()) ?? 'unknown', model: cliModel(input.model), accountId: input.account.id,
      offered: new Set(input.toolNames), uuid: this.deps.uuid, now: this.deps.now(),
    });
    if (!records) throw new Error('nothing to rebuild');
    const ref = await writeTranscript(this.files, { tier, transcriptsDir: this.transcriptsDir, home: input.account.home }, sessionId, lines);
    this.fresh.add(ref);
    return { ref, generation: input.generation, items: records };
  }

  /**
   * input.trace as real tool pairs before the turn: appended to the transcript of session `ref`, chained to its last record; without a
   * session a fresh transcript holding only them, resumed by its path. Returns the ref to resume; throws when it cannot (the turn then
   * takes the calls as text). Its callers never run it on a session a turn is running on (one turn per agent and chat).
   */
  async injectTrace(input: Pick<EngineTurnInput, 'trace' | 'runId' | 'cwd' | 'model' | 'account'>, ref: string | undefined): Promise<string> {
    const items = traceItems(input.trace?.calls ?? [], input.runId);
    const base = { cwd: input.cwd, model: cliModel(input.model), accountId: input.account.id, offered: THROUGH_TOOLS_CALL, uuid: this.deps.uuid, now: this.deps.now() };
    if (!ref) {
      const sessionId = this.deps.uuid();
      const { lines } = claudeTranscript(items, { ...base, sessionId, version: (await this.cliVersion()) ?? 'unknown' });
      const written = await writeTranscript(this.files, { tier: 'path', transcriptsDir: this.transcriptsDir }, sessionId, lines);
      this.fresh.add(written);
      return written;
    }
    const file = await this.transcriptOf(input.account, ref);
    if (!file) throw new Error('the session transcript was not found');
    const tail = await this.files.tail(file, TAIL_BYTES);
    const last = tail === undefined ? undefined : lastRecord(tail);
    if (!last) throw new Error('the session transcript has no record to continue');
    const { lines } = claudeTranscript(items, { ...base, sessionId: last.sessionId ?? sessionIdOf(ref), version: last.version ?? (await this.cliVersion()) ?? 'unknown', parentUuid: last.uuid, closing: TRACE_END });
    await this.files.append(file, `${tail!.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`);
    return ref;
  }

  /** Where the transcript of a session ref lives: our path, the app's project folder, or the CLI's folders of the account's home. */
  private async transcriptOf(account: Account, ref: string): Promise<string | undefined> {
    const target = resumeTarget(ref);
    if (target.path) return (await this.files.size(target.path)) === undefined ? undefined : target.path;
    const home = account.home ?? this.deps.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
    const projects = path.join(home, 'projects');
    const folders = ref.startsWith(PROJECT_REF) ? [PROJECT_DIR_NAME] : await this.files.folders(projects);
    for (const folder of folders) {
      const file = path.join(projects, folder, `${sessionIdOf(ref)}.jsonl`);
      if ((await this.files.size(file)) !== undefined) return file;
    }
    return undefined;
  }

  /** The CLI version – from a turn's system/init, else `claude --version` (once per process; again after a failed read). */
  cliVersion(): Promise<string | undefined> {
    if (this.version) return Promise.resolve(this.version);
    this.versionRead ??= (async () => {
      const exe = await this.deps.finder.find('claude');
      if (!exe) return undefined;
      const result = await runCli(this.deps.supervisor, exe, ['--version'], { env: this.deps.env, cwd: this.deps.tempDir, timeoutMs: 30_000, owner: 'claude-version' });
      const version = /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
      if (version) this.version ??= version;
      else this.versionRead = undefined;
      return version;
    })();
    return this.versionRead;
  }

  /** The model-free probe of the rebuild tiers in `cwd` (rebuild.ts probeClaudeRebuild). */
  async probe(account: Account, cwd: string): Promise<RebuildProbe> {
    const exe = await this.deps.finder.find('claude');
    const version = (await this.cliVersion().catch(() => undefined)) ?? 'unknown';
    if (!exe) return { version, ok: false, reason: 'Claude Code is not installed.', at: this.deps.now() };
    return probeClaudeRebuild({
      supervisor: this.deps.supervisor, files: this.files, exe, env: this.deps.envFor(account), transcriptsDir: this.transcriptsDir,
      uuid: this.deps.uuid, now: this.deps.now, ownHome: this.ownHome(account),
    }, account, cwd, version);
  }

  /** A superseded session the app created: our transcript (path ref) or the CLI's transcript of its id (id ref; rebuild.ts). */
  delete(account: Account, ref: string): Promise<'deleted' | 'missing'> {
    this.fresh.delete(ref);
    return deleteTranscripts(this.files, ref, { transcriptsDir: this.transcriptsDir, home: account.home });
  }

  /** One of the app's own isolated homes (<data>/accounts/…), never a detected login or ~/.claude. */
  ownHome(account: Account): boolean {
    return Boolean(this.deps.accountsRoot && account.home && !account.detected && inside(account.home, this.deps.accountsRoot));
  }
}
