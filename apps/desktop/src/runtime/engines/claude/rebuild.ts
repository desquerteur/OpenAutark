// Claude Code native rebuild (B-048 E2).
// Owns: where a rebuilt transcript lives, how a turn resumes it, the model-free probe per CLI version, and
// the deletion of superseded sessions the app created.
// Tiers: 'path' (default) – the transcript in the app's own data folder (<data>/engine-transcripts/claude/<id>.jsonl),
// resumed with `--resume <absolute path>`; 'project' – only when the probe shows path resume fails and only for
// the app's own isolated homes (<data>/accounts/…): the transcript in that home's fixed project folder
// (CLAUDE_CODE_PROJECT_DIR_NAME, honoured with CLAUDE_CONFIG_DIR – read from the 2.1.303 CLI), resumed by id.
// A session ref says its tier: an absolute .jsonl path, `project:<uuid>`, or a plain session id.
// Probe: a 4-record transcript (a request, one hub call with its result, an answer) and `claude -p --resume`
// with the `initialize` control request only – no user message, so no model call; it passes when the CLI
// answers initialize and reports no error (e.g. "No conversation found"). Not run live in B-048.
// Deletion: a path ref – our transcript file only (a ref that moved to the id Claude Code reported for it is the same
// session, possibly still bound); an id ref – the CLI's own transcript of that session id (projects/<folder>/<id>.jsonl
// and its <id>/ folder) – found by listing folder names, never by reading a file of the home.
// Never: reads credential or settings files of a home, writes into a home that is not the app's own, or
// deletes a file that is not named after a session id the app created.

import * as path from 'node:path';
import type { Account } from '../../../shared/model/providers.ts';
import type { RebuildProbe } from '../types.ts';
import type { Executable } from '../../accounts/executables.ts';
import type { Supervisor } from '../../system/supervisor.ts';
import { CLAUDE_EXIT_GRACE_MS, runCli } from '../../accounts/cli.ts';
import { isRecord, tryJson } from '../shared.ts';
import { USER_SETTINGS_ONLY } from './status.ts';
import { claudeTranscript } from './transcript.ts';

/** The fixed project folder name of the 'project' tier (CLAUDE_CODE_PROJECT_DIR_NAME: [A-Za-z0-9_-]{1,64}). */
export const PROJECT_DIR_NAME = 'workforce-rebuilt';
export const PROJECT_REF = 'project:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBE_TIMEOUT_MS = 30_000;

export interface RebuildFiles {
  writeFile(file: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  rm(file: string): Promise<void>;
  /** Removes a folder and what it holds (a session's subagent/tool-result folder). */
  rmDir(dir: string): Promise<void>;
  /** Size in bytes, undefined when the file is missing. */
  size(file: string): Promise<number | undefined>;
  /** Names of the sub-folders of `dir` (none when it is missing). */
  folders(dir: string): Promise<string[]>;
  /** The last `maxBytes` of a file (undefined when it is missing). */
  tail(file: string, maxBytes: number): Promise<string | undefined>;
  append(file: string, data: string): Promise<void>;
}

/** How a turn resumes a session ref: the --resume argument and the extra env (the 'project' tier's folder name). */
export function resumeTarget(ref: string): { resume: string; env: Record<string, string>; path?: string } {
  if (ref.startsWith(PROJECT_REF)) return { resume: ref.slice(PROJECT_REF.length), env: { CLAUDE_CODE_PROJECT_DIR_NAME: PROJECT_DIR_NAME } };
  if (isTranscriptPath(ref)) return { resume: ref, env: {}, path: ref };
  return { resume: ref, env: {} };
}

/** An absolute path to a .jsonl transcript (the 'path' tier's ref). */
export function isTranscriptPath(ref: string): boolean {
  return ref.toLowerCase().endsWith('.jsonl') && (path.isAbsolute(ref) || path.win32.isAbsolute(ref));
}

/** The session id a ref names (the file name of a path ref). */
export function sessionIdOf(ref: string): string {
  if (ref.startsWith(PROJECT_REF)) return ref.slice(PROJECT_REF.length);
  if (isTranscriptPath(ref)) return path.basename(ref).replace(/\.jsonl$/i, '');
  return ref;
}

/** Is `child` inside `parent` (not equal)? */
export function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The newest record of the main chain in a transcript's tail (a first partial line is skipped). */
export function lastRecord(tail: string): { uuid: string; sessionId?: string; version?: string } | undefined {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = tryJson(lines[index].trim());
    if (isRecord(record) && typeof record.uuid === 'string' && record.isSidechain !== true) {
      return { uuid: record.uuid, ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}), ...(typeof record.version === 'string' ? { version: record.version } : {}) };
    }
  }
  return undefined;
}

/** A rebuilt transcript written for its tier; returns the session ref. */
export async function writeTranscript(files: RebuildFiles, where: { tier: 'path' | 'project'; transcriptsDir: string; home?: string }, sessionId: string, lines: string[]): Promise<string> {
  if (where.tier === 'project') {
    if (!where.home) throw new Error('no app-owned Claude home for the project tier');
    const dir = path.join(where.home, 'projects', PROJECT_DIR_NAME);
    await files.mkdir(dir);
    await files.writeFile(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
    return `${PROJECT_REF}${sessionId}`;
  }
  await files.mkdir(where.transcriptsDir);
  const file = path.join(where.transcriptsDir, `${sessionId}.jsonl`);
  await files.writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Deletes a superseded session the app created: a path ref – our transcript inside `transcriptsDir` only (when
 * Claude Code continued that session in its own transcript, the ref moved to the reported id, which may still be
 * bound: that copy goes when the id ref is superseded, else Claude Code's own cleanup applies); an id or project
 * ref – the CLI's own transcript of its session id in the account home (projects/<folder>/<id>.jsonl plus its
 * <id>/ folder). `cliCopies` (the probe's own never-bound session): a path ref's CLI copies go too.
 */
export async function deleteTranscripts(files: RebuildFiles, ref: string, where: { transcriptsDir: string; home?: string }, options: { cliCopies?: boolean } = {}): Promise<'deleted' | 'missing'> {
  const id = sessionIdOf(ref);
  if (!UUID.test(id)) return 'missing';
  let deleted = false;
  if (isTranscriptPath(ref)) {
    if (!inside(ref, where.transcriptsDir)) return 'missing'; // never a file outside the app's own folder
    if ((await files.size(ref)) !== undefined) { await files.rm(ref); deleted = true; }
    if (!options.cliCopies) return deleted ? 'deleted' : 'missing'; // B-048 review: the live session of a moved ref stays
  }
  if (where.home) {
    const projects = path.join(where.home, 'projects');
    const folders = ref.startsWith(PROJECT_REF) ? [PROJECT_DIR_NAME] : await files.folders(projects);
    for (const folder of folders) {
      const file = path.join(projects, folder, `${id}.jsonl`);
      if ((await files.size(file)) === undefined) continue;
      await files.rm(file);
      await files.rmDir(path.join(projects, folder, id)).catch(() => undefined);
      deleted = true;
    }
  }
  return deleted ? 'deleted' : 'missing';
}

/** The probe's own 4-record transcript (it never reaches a model). */
function probeLines(sessionId: string, cwd: string, version: string, uuid: () => string, now: number): string[] {
  return claudeTranscript([
    { itemId: 'm1', kind: 'm', role: 'user', text: 'Probe of the app: an earlier request.' },
    { itemId: 't1', kind: 't', role: 'tool', text: '', call: { name: 'workforce.probe', args: {}, callId: 'toolu_workforce_probe', output: 'ok' } },
    { itemId: 'a1', kind: 'a', role: 'assistant', text: 'Probe of the app: an earlier answer.' },
  ], { sessionId, cwd, version, model: 'probe', accountId: '', offered: new Set(['workforce.probe']), uuid, now }).lines;
}

/** Did a probe process start the resumed session? (initialize answered, no error result.) */
export function probeOutcome(stdout: string): { ok: boolean; reason?: string } {
  let answered = false;
  let error: string | undefined;
  for (const line of stdout.split('\n')) {
    const message = tryJson(line.trim());
    if (!isRecord(message)) continue;
    if (message.type === 'control_response' && isRecord(message.response) && message.response.request_id === 'init') {
      if (message.response.subtype === 'success') answered = true;
      else error = typeof message.response.error === 'string' ? message.response.error : 'initialize failed';
    }
    if (message.type === 'result' && (message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success'))) {
      const errors = Array.isArray(message.errors) ? message.errors.filter((entry): entry is string => typeof entry === 'string') : [];
      error = (typeof message.result === 'string' && message.result) || errors.join('; ') || 'error result';
    }
  }
  if (error) return { ok: false, reason: error.slice(0, 200) };
  return answered ? { ok: true } : { ok: false, reason: 'the resumed session did not start' };
}

export interface ProbeDeps {
  supervisor: Supervisor; files: RebuildFiles; exe: Executable; env: NodeJS.ProcessEnv; transcriptsDir: string; uuid: () => string; now: () => number;
}

/** One tier's probe: write the probe transcript, start `claude -p --resume` with initialize only, clean up. */
async function probeTier(deps: ProbeDeps, account: Account, cwd: string, version: string, tier: 'path' | 'project'): Promise<{ ok: boolean; reason?: string }> {
  const sessionId = deps.uuid();
  const where = { tier, transcriptsDir: deps.transcriptsDir, home: account.home };
  let ref: string | undefined;
  try {
    ref = await writeTranscript(deps.files, where, sessionId, probeLines(sessionId, cwd, version, deps.uuid, deps.now()));
    const target = resumeTarget(ref);
    const args = ['-p', ...USER_SETTINGS_ONLY, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--resume', target.resume];
    const result = await runCli(deps.supervisor, deps.exe, args, {
      env: { ...deps.env, ...target.env }, cwd, timeoutMs: PROBE_TIMEOUT_MS, maxBytes: 256 * 1024, owner: `claude-rebuild-probe:${account.id}`, graceMs: CLAUDE_EXIT_GRACE_MS,
      stdin: `${JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })}\n`,
      until: (stdout) => /"request_id":"init"/.test(stdout) || /"type":"result"/.test(stdout),
    });
    if (result.timedOut) return { ok: false, reason: 'no answer' };
    return probeOutcome(result.stdout);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' };
  } finally {
    if (ref) await deleteTranscripts(deps.files, ref, where, { cliCopies: true }).catch(() => undefined);
  }
}

/** The probe of the rebuild tiers for this CLI version: 'path' first, 'project' only for the app's own homes. */
export async function probeClaudeRebuild(deps: ProbeDeps & { ownHome: boolean }, account: Account, cwd: string, version: string): Promise<RebuildProbe> {
  const viaPath = await probeTier(deps, account, cwd, version, 'path');
  if (viaPath.ok) return { version, ok: true, tier: 'path', at: deps.now() };
  if (!deps.ownHome || !account.home) return { version, ok: false, reason: `path resume: ${viaPath.reason ?? 'failed'}`, at: deps.now() };
  const viaProject = await probeTier(deps, account, cwd, version, 'project');
  if (viaProject.ok) return { version, ok: true, tier: 'project', reason: `path resume: ${viaPath.reason ?? 'failed'}`, at: deps.now() };
  return { version, ok: false, reason: `path resume: ${viaPath.reason ?? 'failed'}; project folder: ${viaProject.reason ?? 'failed'}`, at: deps.now() };
}
