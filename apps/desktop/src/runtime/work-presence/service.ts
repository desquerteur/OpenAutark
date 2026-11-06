// B-055 G (WORK-PRESENCE, Q11): the work presence of this runtime – AIs notice when another agent is editing the same
// files (the short "Working nearby" hint, context-line.ts); they get the information, never a refusal.
// One tap: the run journal's bus events. 'run.upserted' says which turns run (running → started; done, failed,
// interrupted, unknown → ended, which also leaves the overlap notes); 'run.item' brings every engine-native call as
// the turn journals it (agents/turn-attempt.ts: Codex fileChange as apply_patch and its shell, Claude Code's
// Edit/Write/MultiEdit/NotebookEdit/Read, an ACP agent's edit/delete/move/read – touches.ts), timed by the row's
// createdAt (a re-emitted row records the same entry again, idempotently). A relative path is resolved against the
// turn's folder (git/records.ts turnCwd: the task's worktree, else the agent's home, else the workspace). Our own files
// tools do not report here (touched() takes such a call by its real path; none sends one now). Every key goes through the
// real path of its folder (cached, at most REAL_DIRS; a folder that does not exist yet stays as written; never for a
// network path – no connection is made for a name), so a junction, a short name or another case is one file.
// summary(): a compact "who changes what" (newest first, bounded) for other features – no UI here.
// Owns: the wiring of the ledger, run → agent/chat/task/folder, agent names, the real-folder cache.
// Never: blocks or fails the journal (every handler is guarded), persists anything, or reads file contents.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Run, RunItem } from '../../shared/model/runs.ts';
import { turnCwd } from '../git/records.ts';
import { WorkLedger, type RunningTurn, type WorkEntry } from './ledger.ts';
import { resolveFile, shownPath, type FileRef } from './paths.ts';
import { touchesOf, type WorkKind } from './touches.ts';

const FINAL: ReadonlySet<string> = new Set(['done', 'failed', 'interrupted', 'unknown']);
const SUMMARY_MAX = 50;
const REAL_DIRS = 500;
const NETWORK_PATH = /^[\\/]{2}/; // \\server\share, //server/share, \\?\UNC\…

/** Who the files tools act for (a ToolContext's part). */
export interface Actor {
  agent: { id: string; name: string };
  runId: string;
  conversationId?: string;
  taskId?: string;
}

/** One line of summary(): an agent's newest change of a file. */
export interface WorkPresenceItem {
  agentId: string;
  agentName: string;
  /** Workspace-relative ('/'), else the file's last parts. */
  path: string;
  file: string;
  kind: 'edit' | 'write';
  at: number;
  /** The turn that made the change still runs. */
  running: boolean;
  conversationId?: string;
  taskId?: string;
}

export class WorkPresence {
  readonly ledger: WorkLedger;
  private readonly services: () => RuntimeServices;
  private readonly realDirs = new Map<string, string>();

  constructor(deps: { services: () => RuntimeServices }) {
    this.services = deps.services;
    const now = () => this.services().clock.now();
    this.ledger = new WorkLedger(now);
  }

  /** Listens to the run journal's events; returns the stop. */
  start(): () => void {
    const bus = this.services().bus;
    const stops = [bus.on('run.upserted', (run) => this.onRun(run)), bus.on('run.item', (item) => this.onItem(item))];
    return () => { for (const stop of stops) stop(); };
  }

  onRun(run: Run): void {
    try {
      if (run.status === 'running') this.ledger.turnStarted({ runId: run.id, agentId: run.agentId, startedAt: run.startedAt ?? this.services().clock.now(), conversationId: run.conversationId, taskId: run.taskId });
      else if (FINAL.has(run.status)) this.ledger.turnEnded(run.id);
    } catch (error) { this.warn('run', error); }
  }

  onItem(item: RunItem): void {
    if (item.kind !== 'tool_call' || item.data.own !== true) return;
    try {
      const touches = touchesOf(item.name, item.data.args);
      if (!touches.length) return;
      const turn = this.turnOf(item.runId);
      if (!turn) return;
      const cwd = turn.cwd ?? this.cwdFor(turn.agentId, turn.taskId);
      if (this.ledger.isRunning(turn.runId)) this.ledger.turnStarted({ ...turn, cwd });
      const agentName = this.nameOf(turn.agentId);
      for (const touch of touches) {
        const named = resolveFile(touch.path, touch.base ? resolveFile(touch.base, cwd)?.file ?? cwd : cwd);
        const ref = named && this.ref(named.file);
        if (ref) this.ledger.record({ ...ref, agentId: turn.agentId, agentName, runId: turn.runId, conversationId: turn.conversationId, taskId: turn.taskId, kind: touch.kind, at: item.createdAt });
      }
    } catch (error) { this.warn('item', error); }
  }

  /** A files-tool call (no caller now): `file` (its real path) was read or written for `actor`; its ledger key. */
  touched(actor: Actor, file: string, kind: WorkKind): FileRef | undefined {
    const ref = this.ref(file);
    if (ref) this.ledger.record({ ...ref, agentId: actor.agent.id, agentName: actor.agent.name, runId: actor.runId, conversationId: actor.conversationId, taskId: actor.taskId, kind, at: this.services().clock.now() });
    return ref;
  }

  /** The ledger key of an absolute path (through its folder's real path). */
  ref(file: string): FileRef | undefined {
    const named = resolveFile(file, this.services().paths.workspace);
    return named && resolveFile(this.real(named.file), named.file);
  }

  /** `file` with its folder's real path. */
  private real(file: string): string {
    const dir = path.dirname(file);
    const real = this.realDir(dir);
    return real === dir ? file : path.join(real, path.basename(file));
  }

  /**
   * A folder's real path – the spelling the keys use: of its deepest existing ancestor plus the parts that do not exist
   * yet (only existing folders are cached, so a folder created later resolves then); as written for a network path.
   */
  realDir(dir: string): string {
    if (NETWORK_PATH.test(dir)) return dir;
    const known = this.realDirs.get(dir);
    if (known !== undefined) return known;
    try {
      const real = realpathSync.native(dir);
      this.realDirs.set(dir, real);
      if (this.realDirs.size > REAL_DIRS) this.realDirs.delete(this.realDirs.keys().next().value!);
      return real;
    } catch {
      const parent = path.dirname(dir);
      return parent === dir ? dir : path.join(this.realDir(parent), path.basename(dir));
    }
  }

  /** The folder an agent's turns work in (a task's worktree, its home, the workspace). */
  cwdFor(agentId: string, taskId?: string): string {
    const s = this.services();
    try { return turnCwd(s, taskId ? s.tasks.get(taskId) : undefined, agentId); } catch { return s.paths.workspace; }
  }

  /** Changes of the last minutes (and of running turns), one per agent and file, newest first, at most SUMMARY_MAX. */
  summary(): WorkPresenceItem[] {
    const workspace = this.realDir(this.services().paths.workspace);
    const seen = new Set<string>();
    const out: WorkPresenceItem[] = [];
    for (const entry of this.ledger.recentChanges()) {
      const id = `${entry.agentId}|${entry.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(summaryItem(entry, workspace, this.ledger.isRunning(entry.runId)));
      if (out.length >= SUMMARY_MAX) break;
    }
    return out;
  }

  private turnOf(runId: string): RunningTurn | undefined {
    const running = this.ledger.turn(runId);
    if (running) return running;
    const run = this.services().runs.get(runId); // a row journaled after its turn ended (or before this tap started)
    return run ? { runId, agentId: run.agentId, startedAt: run.startedAt ?? 0, conversationId: run.conversationId, taskId: run.taskId } : undefined;
  }

  private nameOf(agentId: string): string {
    try { return this.services().org.get(agentId)?.name || 'Another agent'; } catch { return 'Another agent'; }
  }

  private warn(what: string, error: unknown): void {
    try { this.services().log.warn('work presence: event skipped', { what, error: String(error) }); } catch { /* no log */ }
  }
}

function summaryItem(entry: WorkEntry, workspace: string, running: boolean): WorkPresenceItem {
  return {
    agentId: entry.agentId, agentName: entry.agentName, path: shownPath(entry.file, [workspace]), file: entry.file,
    kind: entry.kind === 'write' ? 'write' : 'edit', at: entry.at, running,
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}), ...(entry.taskId ? { taskId: entry.taskId } : {}),
  };
}
