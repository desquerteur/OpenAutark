// A split's worktree record (B-057, split-worktree.ts) in kv ns 'split_worktrees' (key and `taskId`: the split
// id), folder spellings, removing what a worktree removal left behind (dropRemnant), and the working folder of a
// turn (turnCwd: the agent's home project, else the workspace). Task worktrees are gone: agents use git in the
// shell.
// Owns: the record shape and its kv reads/writes. Never: runs git (worktree.ts, worktree-ops.ts do).

import { realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/agent-core.ts'; // B-044: turnCwd falls back to the agent's home project
import type { Db } from '../db/database.ts';
import { KvRepo } from '../store/kv.ts';
import type { Task } from '../../shared/model/tasks.ts';
import { WORKTREE_LIMITS, type WorktreeState } from '../../shared/model/worktrees.ts';

/** B-057: the worktree records of splits (key: the split id). */
export const SPLIT_WORKTREE_NS = 'split_worktrees';

export interface WorktreeStat { files: number; added: number; removed: number; ahead: number; dirty: boolean; names: string[]; at: number }

export interface WorktreeRecord {
  v: 1;
  taskId: string;
  /** Real absolute path of the repository's main working tree. */
  repo: string;
  repoName: string;
  /** Absolute folder of the worktree. */
  path: string;
  /** The folder, workspace-relative and '/'-separated. */
  rel: string;
  branch: string;
  /** The person's branch it merges into. */
  base: string;
  /** Where the branch started: the stat and the commit count are measured from here. */
  baseSha: string;
  /** Started on another task's branch (at its tip): merged only once that work is in `base`. */
  on?: string;
  /** The branch tip at the last stat (an agent's merge runs only on the tip its card showed). */
  tip?: string;
  state: WorktreeState;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  stat: WorktreeStat;
  /** The last merge attempt: sha on success, else the conflicts or the error. */
  merge?: { at: number; sha?: string; conflicts?: string[]; error?: string };
  /** The folder could not be (fully) removed – a locked file, a process working in it; retried at the next start and on reopen. */
  leftover?: true;
  /** B-057: a split's worktree (`taskId` holds the split id); `into`: the real top folder of the parent's working tree it merges into (on `base`). */
  split?: { groupId: string; into: string };
}

export const emptyStat = (at: number): WorktreeStat => ({ files: 0, added: 0, removed: 0, ahead: 0, dirty: false, names: [], at });

function valid(value: unknown): value is WorktreeRecord {
  const rec = value as WorktreeRecord | undefined;
  return !!rec && rec.v === 1 && typeof rec.taskId === 'string' && typeof rec.repo === 'string' && typeof rec.path === 'string'
    && typeof rec.branch === 'string' && typeof rec.base === 'string' && typeof rec.state === 'string' && !!rec.stat;
}

export function saveRecord(s: Pick<RuntimeServices, 'db' | 'clock'>, rec: WorktreeRecord): WorktreeRecord {
  rec.updatedAt = s.clock.now();
  new KvRepo(s.db).set(SPLIT_WORKTREE_NS, rec.taskId, rec, rec.updatedAt);
  return rec;
}

/** B-057: a split's worktree record. */
export function splitRecordOf(db: Db, splitId: string): WorktreeRecord | undefined {
  const value = new KvRepo(db).get<unknown>(SPLIT_WORKTREE_NS, splitId);
  return valid(value) && value.split ? value : undefined;
}

/** B-057: every split's worktree record. */
export function splitRecords(db: Db): WorktreeRecord[] {
  return new KvRepo(db).list<unknown>(SPLIT_WORKTREE_NS).map((row) => row.value).filter((rec): rec is WorktreeRecord => valid(rec) && !!rec.split);
}

/** The stored version of a split's record. */
export function storedRecord(db: Db, rec: Pick<WorktreeRecord, 'taskId' | 'split'>): WorktreeRecord | undefined {
  return splitRecordOf(db, rec.taskId);
}

export function folderExists(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/** The real path of a folder (resolved when it does not exist). */
export const realDir = (dir: string): string => { try { return realpathSync.native(dir); } catch { return path.resolve(dir); } };
export const sameDir = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Deletes what a removal left behind – git unregisters a folder it cannot delete fully (on Windows a
 * process's cwd); its work was committed before, the rest is ignored or locked files. Only strictly
 * below <workspace>/.worktrees, and only for a folder git no longer lists (the caller checks); clears
 * `leftover` once it is gone, else logs and keeps it.
 */
export async function dropRemnant(s: Pick<RuntimeServices, 'paths' | 'log'>, rec: WorktreeRecord): Promise<void> {
  const inside = path.relative(realDir(path.join(s.paths.workspace, '.worktrees')), realDir(rec.path));
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) { s.log.warn('worktree remnant outside .worktrees left alone', { taskId: rec.taskId }); return; }
  try {
    await rm(realDir(rec.path), { recursive: true, force: true, maxRetries: 2 });
    delete rec.leftover;
  } catch (error) { s.log.warn('worktree remnant not removed', { taskId: rec.taskId, error: String(error) }); }
}

/** The working folder of a turn: the agent's usable home project (agent-core/home.ts), else the workspace. */
export function turnCwd(s: Pick<RuntimeServices, 'paths' | 'agentCore'>, _task?: Task, agentId?: string): string {
  try { const home = agentId ? s.agentCore?.homes.usable(agentId) : undefined; if (home) return home; } catch { /* the workspace */ }
  return s.paths.workspace;
}

