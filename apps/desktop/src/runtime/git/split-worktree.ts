// Split worktrees (B-057 S16): by default every split of a group works in the parent's folder (the parent gives each
// part its own files). A part with `worktree: true` gets its own git worktree on the branch `wf/split-<slug>-<id6>`,
// started at the branch checked out in the parent's folder (a repository folder of the workspace), in the
// `.worktrees/<repo>-<hash6>/` area, under the caps of worktree.ts (git 2.31, inside the workspace and not the
// workspace itself). Its record (records.ts, kv
// ns split_worktrees, key: the split id) lets a restart re-attach it. The part works in the same folder of its worktree
// as its parent does in the repository (a project folder of a monorepo). finish: the part's work is committed on its
// branch (the agent's identity), the folder removed, the branch kept – an empty one is deleted ('no changes'); work that
// stays uncommitted is an error (its folder kept), never a quiet 'done'; merge: --no-ff
// into that branch in the parent's folder (on that branch, clean, not mid-merge; a conflict is aborted and listed, never
// left half done); discard: folder and branch deleted. An open folder whose split ended without finish (a crash) is
// closed at the next open (not while its lane still runs) and at boot (sweepSplitWorktrees), so it never holds the
// caps; a folder an earlier close could not delete goes then too.
// Owns: canIsolate and opening, finishing, merging, discarding and sweeping a split's worktree.
// Never: touches a branch outside wf/ except the merge into the parent's branch the parent asked for, pushes, resets,
// rebases, merges a split that still runs, or works in a repository outside the workspace.

import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { SPLIT_TERMINAL, type Split, type SplitGroup } from '../../shared/model/splits.ts';
import { WORKTREE_LIMITS } from '../../shared/model/worktrees.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { SplitRepo } from '../store/splits.ts';
import { isInside } from '../tools/builtin/files.ts';
import { gitOf, type GitRunner } from './exec.ts';
import { dropRemnant, emptyStat, folderExists, realDir, sameDir, saveRecord, splitRecordOf, splitRecords, turnCwd, type WorktreeRecord } from './records.ts';
import { addFolder, checkCaps, defaultBranch, freeBranch, mainTree, reattach, readyGit, type RepoAt, type WorktreeCaps } from './worktree.ts';
import { agentIdentity, closeWorktree, commitWork, dropBranch, isAncestor, listedWorktree, midMerge, personIdentity, refreshLocked, statText } from './worktree-ops.ts';

const SUBMODULES = '--ignore-submodules=dirty';
const MERGE_TIMEOUT = 120_000;

/** The parent's working tree: its repository (main tree) and its own top folder (that tree or a linked worktree). */
interface ParentTree extends RepoAt { git: GitRunner; top: string }

async function parentTree(s: RuntimeServices, cwd: string): Promise<ParentTree> {
  const git = await readyGit(s);
  const rel = path.relative(realDir(s.paths.workspace), realDir(cwd)).split(path.sep).join('/');
  let main: { repo: string; workspace: string };
  try { main = await mainTree(s, git, rel || '.'); } catch (error) {
    if (!rel && error instanceof WorkforceError && error.message.startsWith('. is not')) {
      throw new WorkforceError('bad_request', 'The working folder is the workspace itself, not a git repository inside it.');
    }
    throw error;
  }
  const shown = await git.probe(cwd, ['rev-parse', '--show-toplevel']);
  const top = shown.code === 0 && shown.stdout.trim() ? realDir(path.resolve(shown.stdout.trim())) : '';
  if (!top || !isInside(main.workspace, top) || isInside(top, path.join(main.workspace, '.worktrees'))) {
    throw new WorkforceError('bad_request', `${rel} is not a git repository inside the workspace.`);
  }
  return { git, ...main, repoName: path.basename(main.repo), top };
}

/** The branch checked out in the parent's folder and its tip. */
async function parentTip(git: GitRunner, top: string): Promise<{ base: string; baseSha: string }> {
  const base = (await git.probe(top, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (!base) throw new WorkforceError('conflict', 'The working folder is on a detached HEAD: check out a branch first.');
  const sha = await git.probe(top, ['rev-parse', '--verify', '-q', `${base}^{commit}`]);
  if (sha.code !== 0 || !sha.stdout.trim()) throw new WorkforceError('conflict', 'This repository has no commits yet. Commit once, then open a worktree.');
  return { base, baseSha: sha.stdout.trim() };
}

/** undefined when `cwd` can give a split its own worktree, else the reason (one clear sentence). */
export async function canIsolate(s: RuntimeServices, cwd: string): Promise<string | undefined> {
  try {
    const at = await parentTree(s, cwd);
    await parentTip(at.git, at.top);
    return undefined;
  } catch (error) {
    if (error instanceof WorkforceError) return error.message;
    s.log.warn('split worktree check failed', { error: String(error) });
    return 'Git could not check the working folder.';
  }
}

const saved = (s: RuntimeServices, rec: WorktreeRecord): Promise<WorktreeRecord> => { saveRecord(s, rec); return refreshLocked(s, rec); };

/**
 * Closes the open folders of splits that ended without finishSplitWorktree (or are gone): they would hold the caps.
 * Removes what an earlier close or discard could not delete (a leftover folder git no longer lists – Windows locks).
 */
async function closeEnded(s: RuntimeServices): Promise<void> {
  const due = splitRecords(s.db).filter((rec) => rec.state === 'active' || rec.leftover);
  if (!due.length) return;
  const rows = new SplitRepo(s.db);
  // A part stopped while it ran is terminal at once, but its lane (the engine and what it started in the folder) ends later.
  let onLane = new Set<string>();
  try { onLane = new Set((s.dispatcher?.splitLanes?.() ?? []).map((lane) => lane.splitId)); } catch { /* no lane listing */ }
  for (const rec of due) {
    const status = rows.getSplit(rec.taskId)?.status;
    if (rec.state === 'active' && ((status && !SPLIT_TERMINAL.includes(status)) || onLane.has(rec.taskId))) continue;
    try {
      if (rec.state === 'active' || rec.state === 'closed') await closeWorktree(s, rec, 'done'); // closed: only its remnant goes
      else await dropLeftover(s, rec); // merged or discarded: a close would turn it 'closed' again
    } catch (error) { s.log.warn('split worktree not closed', { splitId: rec.taskId, error: String(error) }); }
  }
}

/**
 * The boot recovery's sweep (splits/reconcile.ts): the folders of parts that ended without their finish (the app stopped)
 * are closed like at the next open – their work committed on their branch, a clean folder removed, a dirty one kept;
 * a branch with work on it is never deleted (only an empty one goes).
 */
export async function sweepSplitWorktrees(s: RuntimeServices): Promise<void> {
  await closeEnded(s);
}

/** The remnant folder of a merged or discarded split, once git no longer lists it. */
function dropLeftover(s: RuntimeServices, rec: WorktreeRecord): Promise<void> {
  const git = gitOf(s);
  return git.serial(rec.repo, async () => {
    const current = splitRecordOf(s.db, rec.taskId) ?? rec;
    if (!current.leftover || (folderExists(current.path) && await listedWorktree(git, current))) return;
    if (folderExists(current.path)) await dropRemnant(s, current); else delete current.leftover;
    saveRecord(s, current);
  });
}

/**
 * Opens the split's worktree from the group's folder (again: its open one, or its kept branch re-attached); its folder
 * and branch. `caps` defaults to WORKTREE_LIMITS (tests inject smaller ones). Refusals name the part.
 */
export async function openSplitWorktree(s: RuntimeServices, group: SplitGroup, split: Split, caps: WorktreeCaps = WORKTREE_LIMITS): Promise<{ cwd: string; branch: string }> {
  try {
    await closeEnded(s);
    const from = group.cwd ?? turnCwd(s, group.taskId ? s.tasks.get(group.taskId) : undefined, group.agentId);
    const at = await parentTree(s, from);
    const { git } = at;
    const record = await git.serial(at.repo, async () => {
      const existing = splitRecordOf(s.db, split.id);
      const kept = existing && (existing.state === 'active' || existing.state === 'closed');
      if (existing && kept && !sameDir(existing.repo, at.repo)) throw new WorkforceError('conflict', `It already works in ${existing.repoName} (${existing.branch}).`);
      if (existing?.state === 'active' && folderExists(existing.path)) return refreshLocked(s, existing);
      if (existing && kept && await git.hasBranch(at.repo, existing.branch)) return saved(s, await reattach(s, git, at, existing, caps));
      checkCaps(s, split.id, at.repo, at.repoName, caps);
      const { base, baseSha } = await parentTip(git, at.top);
      const branch = await freeBranch(git, at.repo, defaultBranch(`split ${split.title}`, split.id));
      const place = await addFolder(git, at, branch, baseSha);
      const now = s.clock.now();
      return saved(s, {
        v: 1, taskId: split.id, repo: at.repo, repoName: at.repoName, ...place, branch, base, baseSha, state: 'active',
        createdBy: split.agentId, createdAt: now, updatedAt: now, stat: emptyStat(now), split: { groupId: group.id, into: at.top },
      });
    });
    return { cwd: samePlace(record.path, at.top, from), branch: record.branch };
  } catch (error) {
    if (error instanceof WorkforceError) throw new WorkforceError(error.code, `Part #${split.idx} got no worktree: ${error.message}`, { details: { splitId: split.id } });
    throw error;
  }
}

/** The parent's folder inside its repository (a project folder of a monorepo), found again in the part's worktree; else its top. */
function samePlace(worktree: string, top: string, cwd: string): string {
  const sub = path.relative(top, realDir(cwd));
  if (!sub || sub.startsWith('..') || path.isAbsolute(sub)) return worktree;
  const dir = path.join(worktree, sub);
  return folderExists(dir) ? dir : worktree;
}

/** The top folder of a split's worktree while it is open, else undefined. */
export function splitWorktreeCwd(s: Pick<RuntimeServices, 'db'>, splitId: string): string | undefined {
  const rec = splitRecordOf(s.db, splitId);
  return rec?.state === 'active' && folderExists(rec.path) ? rec.path : undefined;
}

/** The stat line of a split's branch: 'no changes', else files and lines. */
export const splitStat = (rec: Pick<WorktreeRecord, 'stat'>): string => (rec.stat.files === 0 && rec.stat.ahead === 0 ? 'no changes' : statText(rec.stat));

/**
 * Commits the ended split's work on its branch, removes its folder (the branch stays; an empty one goes); the diff stat.
 * Call it for every ended split that had a worktree (done, failed or stopped); without one it returns {}.
 * Throws when work stays uncommitted (the close tries once more; a dirty folder is kept), so the part does not count as done.
 */
export async function finishSplitWorktree(s: RuntimeServices, split: Split): Promise<{ stat?: string }> {
  const rec = splitRecordOf(s.db, split.id);
  if (!rec) return {};
  let why = '';
  if (rec.state === 'active' && folderExists(rec.path)) {
    try {
      await commitWork(s, rec, { message: `Split #${split.idx} of ${split.of}: ${split.title}`, author: agentIdentity(s, split.agentId) });
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
      s.log.warn('split work not committed', { splitId: split.id, error: why });
    }
  }
  const closed = await closeWorktree(s, rec, 'done');
  if (closed.stat.dirty) throw new WorkforceError('conflict', `its changes stay uncommitted in ${closed.rel}${why ? ` (${why.replace(/\.$/, '')})` : ''}.`);
  return { stat: splitStat(closed) };
}

/** The parent merges the ended split's branch into its folder, or discards it; the worktree is closed either way. `by`: the parent agent (or HUMAN_ID). */
export async function mergeSplit(s: RuntimeServices, split: Split, action: 'merge' | 'discard', by: string): Promise<{ outcome: 'merged' | 'discarded' | 'conflict'; conflicts?: string[] }> {
  const rec = splitRecordOf(s.db, split.id);
  const part = `Part #${split.idx}`;
  if (!rec) throw new WorkforceError('not_found', `${part} has no branch of its own: it worked in my folder.`);
  if (!SPLIT_TERMINAL.includes(split.status)) throw new WorkforceError('conflict', `${part} is still ${split.status}. Merge or discard it once it has ended.`);
  if (action === 'discard') return discard(s, split, rec);
  if (rec.state === 'merged' || rec.state === 'discarded') throw new WorkforceError('conflict', `${part} is already ${rec.state}.`);
  return merge(s, split, await closeWorktree(s, rec, 'done'), by);
}

async function merge(s: RuntimeServices, split: Split, rec: WorktreeRecord, by: string): Promise<{ outcome: 'merged' | 'conflict'; conflicts?: string[] }> {
  const git = gitOf(s);
  const part = `part #${split.idx}`;
  return git.serial(rec.repo, async () => {
    let current = splitRecordOf(s.db, split.id) ?? rec;
    const into = current.split?.into ?? '';
    if (!folderExists(into)) throw new WorkforceError('conflict', `The folder ${part} started in is gone: I merge ${current.branch} where ${current.base} is checked out, or discard it.`);
    const nothing = () => new WorkforceError('conflict', `No changes in ${part} to merge: I discard it.`);
    if (!await git.hasBranch(current.repo, current.branch)) throw nothing();
    current = await refreshLocked(s, current);
    const head = (await git.probe(into, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    if (head !== current.base) throw new WorkforceError('conflict', `My folder is on '${head || 'a detached HEAD'}', not '${current.base}' where ${part} started: I switch back to ${current.base}, then merge.`);
    if ((await git.out(into, ['status', '--porcelain=v1', '-z', '--untracked-files=no', SUBMODULES])).length) {
      throw new WorkforceError('conflict', `My folder has uncommitted changes: I commit them first, then merge ${part}.`);
    }
    if (await midMerge(git, into)) throw new WorkforceError('conflict', 'My folder is in the middle of a merge or rebase: I finish it first.');
    if (current.stat.ahead <= 0) throw nothing();
    const identity = by === HUMAN_ID ? await personIdentity(git, into) : agentIdentity(s, by);
    const merged = await git.run(into, ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', `Merge ${current.branch}: part #${split.idx} ${excerpt(split.title, 80)}`, current.branch],
      { identity, timeoutMs: MERGE_TIMEOUT });
    const at = s.clock.now();
    if (merged.code === 0) {
      current.merge = { at, sha: (await git.out(into, ['rev-parse', 'HEAD'])).trim() };
      if (await dropBranch(git, current, isAncestor(git, current.repo, current.branch, current.base))) current.state = 'merged';
      else current = await refreshLocked(s, current);
      saveRecord(s, current);
      return { outcome: 'merged' };
    }
    const conflicts = (await git.run(into, ['diff', '--name-only', '--diff-filter=U', '-z', SUBMODULES])).stdout.split('\0').filter(Boolean);
    if (await midMerge(git, into, true)) {
      await git.run(into, ['merge', '--abort']);
      if (await midMerge(git, into, true)) {
        current.merge = { at, error: 'merge --abort failed' };
        saveRecord(s, current);
        throw new WorkforceError('conflict', `The merge of ${current.branch} stopped and could not be undone: I run git merge --abort in my folder.`);
      }
    }
    if (conflicts.length) {
      current.merge = { at, conflicts: conflicts.slice(0, WORKTREE_LIMITS.viewNames) };
      saveRecord(s, current);
      return { outcome: 'conflict', conflicts };
    }
    current.merge = { at, error: git.firstLine(merged) };
    saveRecord(s, current);
    throw new WorkforceError('conflict', `The merge failed: ${current.merge.error}`);
  });
}

/** Deletes the split's folder (unsaved work too) and its branch. */
function discard(s: RuntimeServices, split: Split, rec: WorktreeRecord): Promise<{ outcome: 'discarded' }> {
  const git = gitOf(s);
  return git.serial(rec.repo, async () => {
    const current = splitRecordOf(s.db, split.id) ?? rec;
    if (current.state === 'discarded') return { outcome: 'discarded' as const };
    if (current.state === 'merged') throw new WorkforceError('conflict', `Part #${split.idx} is already merged.`);
    if (folderExists(current.path) && await listedWorktree(git, current)) await git.run(current.repo, ['worktree', 'remove', '--force', current.path]);
    await git.run(current.repo, ['worktree', 'prune']);
    if (folderExists(current.path) && !await listedWorktree(git, current)) await dropRemnant(s, current);
    if (await git.hasBranch(current.repo, current.branch)) await git.out(current.repo, ['branch', '-D', current.branch]);
    current.state = 'discarded';
    if (folderExists(current.path)) current.leftover = true; else delete current.leftover;
    saveRecord(s, current);
    return { outcome: 'discarded' as const };
  });
}
