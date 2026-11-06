// What happens to a split's worktree (B-057, split-worktree.ts) after it is open: commits on its own branch, the
// change stat, closing (unsaved work committed, folder removed, branch kept – an empty branch is deleted, a
// merged one too). Every write runs in git.serial(repo); submodules are never entered (--ignore-submodules=dirty).
// A branch is deleted only after the runtime checked that nothing is lost (rev-list, merge-base --is-ancestor).
// Owns: these operations. Never: pushes, fetches, rebases, resets or edits config.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { WORKTREE_LIMITS } from '../../shared/model/worktrees.ts';
import { gitOf, type GitRunner } from './exec.ts';
import { dropRemnant, emptyStat, folderExists, realDir, sameDir, saveRecord, storedRecord, type WorktreeRecord, type WorktreeStat } from './records.ts';

export type Identity = { name: string; email: string };
export type CloseReason = 'done' | 'cancelled' | 'removed' | 'startup';

const SUBMODULES = '--ignore-submodules=dirty';
const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
export const statText = (stat: WorktreeStat): string => `${files(stat.files)} +${stat.added} −${stat.removed}`;

/** An agent's commit identity: '<name> (Autark)' <agentId@agents.autark.invalid>. */
export function agentIdentity(s: Pick<RuntimeServices, 'org'>, agentId: string): Identity {
  const name = (s.org.get(agentId)?.name ?? agentId).replace(/[<>\r\n]/g, '').trim() || 'Agent';
  return { name: `${name} (Autark)`, email: `${agentId.replace(/[^A-Za-z0-9._-]/g, '') || 'agent'}@agents.autark.invalid` };
}

/** The person's own identity from the repo's config, else Workforce. */
export async function personIdentity(git: GitRunner, repo: string): Promise<Identity> {
  const get = async (key: string) => (await git.run(repo, ['config', '--get', key])).stdout.trim();
  return { name: (await get('user.name')) || 'Autark', email: (await get('user.email')) || 'autark@localhost.invalid' };
}

const where = (rec: WorktreeRecord) => (rec.state === 'active' && folderExists(rec.path) ? rec.path : rec.repo);
const fresh = (s: Pick<RuntimeServices, 'db'>, rec: WorktreeRecord) => storedRecord(s.db, rec) ?? rec; // B-057: a task's or a split's

/** Commits on the branch beyond its base and its start; undefined when git cannot count them. */
async function aheadOf(git: GitRunner, dir: string, rec: WorktreeRecord, tip: string): Promise<number | undefined> {
  for (const not of [[rec.base, rec.baseSha], [rec.baseSha]]) {
    const count = (await git.run(dir, ['rev-list', '--count', tip, '--not', ...not, '--'])).stdout.trim();
    if (/^\d+$/.test(count)) return Number(count);
  }
  return undefined;
}

/** Commits everything in the folder on the task's branch (lock held). */
async function commitLocked(s: RuntimeServices, rec: WorktreeRecord, message: string, author: Identity): Promise<{ sha?: string; nothing?: true }> {
  const git = gitOf(s);
  const head = (await git.probe(rec.path, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (head !== rec.branch) throw new WorkforceError('conflict', `The worktree is on '${head || 'a detached HEAD'}', not ${rec.branch}; switch back first.`);
  await git.out(rec.path, ['add', '-A']);
  const staged = await git.run(rec.path, ['diff', '--cached', '--quiet', '--no-ext-diff', SUBMODULES]);
  if (staged.code === 0) return { nothing: true };
  if (staged.code !== 1) throw new WorkforceError('conflict', `git diff failed: ${git.firstLine(staged)}`);
  const [first = '', ...rest] = message.trim().slice(0, WORKTREE_LIMITS.commitMessage).split('\n');
  const body = rest.join('\n').trim();
  const text = `${excerpt(first, 120) || 'Autark changes'}${body ? `\n\n${body}` : ''}\n\nAutark-${rec.split ? 'Split' : 'Task'}: ${rec.taskId}`;
  await git.out(rec.path, ['commit', '--no-verify', '-q', '-m', text], { identity: author });
  return { sha: (await git.out(rec.path, ['rev-parse', 'HEAD'])).trim() };
}

export function commitWork(s: RuntimeServices, rec: WorktreeRecord, input: { message: string; author: Identity }): Promise<{ sha?: string; nothing?: true; record: WorktreeRecord }> {
  return gitOf(s).serial(rec.repo, async () => {
    const current = fresh(s, rec);
    if (current.state !== 'active' || !folderExists(current.path)) throw new WorkforceError('conflict', 'Open the worktree first (git.worktree).');
    const done = await commitLocked(s, current, input.message, input.author);
    // New work after a failed merge attempt: its conflicts or error no longer describe the branch.
    if (done.sha && current.merge && !current.merge.sha) { delete current.merge; saveRecord(s, current); }
    return { ...done, record: await refreshLocked(s, current) };
  });
}

function numstat(text: string, into: { added: number; removed: number; names: Set<string> }): void {
  for (const entry of text.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    into.added += Number(match[1]) || 0;
    into.removed += Number(match[2]) || 0;
    into.names.add(match[3]);
  }
}

/** Recomputes the stat and the tip (lock held); saves and announces only a change. Throws when git cannot tell. */
export async function refreshLocked(s: RuntimeServices, rec: WorktreeRecord): Promise<WorktreeRecord> {
  const git = gitOf(s);
  const acc = { added: 0, removed: 0, names: new Set<string>() };
  let dirty = false;
  let at: [dir: string, tip: string];
  const diff = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', SUBMODULES, rec.baseSha];
  if (rec.state === 'active' && folderExists(rec.path)) {
    const status = await git.out(rec.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', SUBMODULES]);
    for (const entry of status.split('\0')) if (entry.length > 3) { dirty = true; acc.names.add(entry.slice(3)); }
    numstat(await git.out(rec.path, diff), acc);
    at = [rec.path, 'HEAD'];
  } else if (rec.state === 'closed' && await git.hasBranch(rec.repo, rec.branch)) {
    numstat(await git.out(rec.repo, [...diff, rec.branch]), acc);
    at = [rec.repo, rec.branch];
  } else return rec;
  const ahead = await aheadOf(git, at[0], rec, at[1]);
  if (ahead === undefined) throw new WorkforceError('conflict', `git rev-list could not count the commits of ${rec.branch}.`);
  const tip = (await git.out(at[0], ['rev-parse', '--verify', `${at[1]}^{commit}`])).trim();
  const names = [...acc.names].sort().slice(0, WORKTREE_LIMITS.storedNames);
  const stat: WorktreeStat = { files: acc.names.size, added: acc.added, removed: acc.removed, ahead, dirty, names, at: s.clock.now() };
  const old = rec.stat;
  const same = old.files === stat.files && old.added === stat.added && old.removed === stat.removed && old.ahead === stat.ahead
    && old.dirty === stat.dirty && old.names.join('\0') === names.join('\0') && rec.tip === tip;
  if (same) return rec;
  Object.assign(rec, { stat, tip });
  saveRecord(s, rec);
  return rec;
}

/** Deletes the branch when the runtime verified that nothing is lost (`check` true). */
export async function dropBranch(git: GitRunner, rec: WorktreeRecord, check: () => Promise<boolean>): Promise<boolean> {
  if (!await git.hasBranch(rec.repo, rec.branch) || !await check()) return false;
  return (await git.run(rec.repo, ['branch', '-D', rec.branch])).code === 0;
}

export const isAncestor = (git: GitRunner, repo: string, commit: string, of: string) => async () =>
  (await git.probe(repo, ['merge-base', '--is-ancestor', commit, of])).code === 0;

/** git still lists the record's folder as a worktree of its repo. */
export async function listedWorktree(git: GitRunner, rec: WorktreeRecord): Promise<boolean> {
  const want = realDir(rec.path);
  return (await git.out(rec.repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0')
    .some((line) => line.startsWith('worktree ') && sameDir(realDir(line.slice('worktree '.length)), want));
}

// Ends the folder of a task: leftovers committed (owner's identity), folder removed (no --force: a failure keeps
// `leftover`, retried at the next start; what git unregistered but could not delete goes by dropRemnant), an empty
// branch deleted, a merged one too.
export function closeWorktree(s: RuntimeServices, rec: WorktreeRecord, why: CloseReason): Promise<WorktreeRecord> {
  const git = gitOf(s);
  return git.serial(rec.repo, async () => {
    let current = fresh(s, rec);
    if (current.state !== 'active' && !current.leftover) return current;
    const wasActive = current.state === 'active';
    const task = s.tasks.get(current.taskId);
    if (!folderExists(current.path)) delete current.leftover;
    else if (await listedWorktree(git, current)) {
      if (wasActive) {
        try {
          await commitLocked(s, current, `Autark: unsaved work of "${excerpt(task?.title ?? current.branch, 100)}"`, agentIdentity(s, current.createdBy));
        } catch (error) { s.log.warn('worktree leftovers not committed', { taskId: current.taskId, error: String(error) }); }
        current = await refreshLocked(s, current);
      }
      const removed = await git.run(current.repo, ['worktree', 'remove', current.path]);
      if (removed.code === 0) delete current.leftover;
      else { current.leftover = true; s.log.warn('worktree folder not removed', { taskId: current.taskId, error: git.firstLine(removed) }); }
    } else if (current.leftover) await dropRemnant(s, current);
    else s.log.warn('worktree folder is no longer a worktree; left as it is', { taskId: current.taskId });
    await git.run(current.repo, ['worktree', 'prune']);
    current.state = 'closed';
    const empty = current.stat.files === 0 && current.stat.ahead === 0;
    if (!current.leftover) {
      try {
        if (empty && await dropBranch(git, current, async () => await aheadOf(git, current.repo, current, current.branch) === 0)) {
          current.stat = emptyStat(s.clock.now());
        } else if (!empty && current.merge?.sha && await dropBranch(git, current, isAncestor(git, current.repo, current.branch, current.base))) {
          current.state = 'merged';
        }
      } catch (error) { s.log.warn('task branch not checked', { taskId: current.taskId, error: String(error) }); }
    }
    saveRecord(s, current);
    return current;
  });
}

/** A merge (or with `mergeOnly` false also a rebase) is in progress in the checkout. */
export async function midMerge(git: GitRunner, repo: string, mergeOnly = false): Promise<boolean> {
  if ((await git.probe(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) return true;
  if (mergeOnly) return false;
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const dir = (await git.probe(repo, ['rev-parse', '--git-path', name])).stdout.trim();
    if (dir && existsSync(path.resolve(repo, dir))) return true;
  }
  return false;
}
