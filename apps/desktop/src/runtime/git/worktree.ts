// Worktree helpers of a split (B-057, split-worktree.ts): git found (readyGit), the repository's real main working
// tree inside the workspace (mainTree), the caps on open worktrees (checkCaps), a free wf/ branch name, a branch's
// own new folder under <workspace>/.worktrees (addFolder) and re-adding a kept branch (reattach). Git LFS files
// stay pointers in a new folder (GIT_LFS_SKIP_SMUDGE: no download).
// Owns: these steps. Never: a branch outside wf/.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { WORKTREE_LIMITS } from '../../shared/model/worktrees.ts';
import { isInside, realInside } from '../tools/builtin/files.ts';
import { gitOf, type GitRunner } from './exec.ts';
import { dropRemnant, emptyStat, folderExists, realDir as real, sameDir, saveRecord, splitRecords, type WorktreeRecord } from './records.ts';
import { listedWorktree, refreshLocked } from './worktree-ops.ts';

export interface WorktreeCaps { perRepo: number; total: number }
/** B-057: the repository a worktree is opened in (its real main working tree). */
export interface RepoAt { workspace: string; repo: string; repoName: string }

const BRANCH = /^wf\/[a-z0-9][a-z0-9._-]{0,47}$/;
const ADD = { timeoutMs: 300_000, env: { GIT_LFS_SKIP_SMUDGE: '1' } };

/** NFKD, diacritics stripped, [a-z0-9-], at most `max` characters; 'task' when nothing is left. */
export function slug(text: string, max: number = WORKTREE_LIMITS.branchSlug): string {
  const plain = text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return plain.slice(0, max).replace(/-+$/, '') || 'task';
}

export function validBranch(name: string): boolean {
  return BRANCH.test(name) && !name.includes('..') && !name.endsWith('.lock');
}

/** wf/<slug(title)>-<last 6 of the task id>. */
export function defaultBranch(title: string, taskId: string): string {
  return `wf/${slug(title)}-${taskId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6)}`;
}

const toRel = (workspace: string, dir: string) => path.relative(workspace, dir).split(path.sep).join('/');

/** Git found and at least 2.31: its runner. */
export async function readyGit(s: RuntimeServices): Promise<GitRunner> {
  const git = gitOf(s);
  if (!git.resolve()) throw new WorkforceError('unavailable', 'Git is not installed on this PC.');
  const version = await git.version();
  if (!version.text) throw new WorkforceError('timeout', 'Git did not answer (git --version). Try again.');
  if (!version.ok) throw new WorkforceError('unavailable', `Git 2.31 or newer is needed (found ${version.text.replace(/^git version\s*/, '')}).`);
  return git;
}

/** The real main working tree of `repoArg` (inside the workspace, never the workspace itself). */
export async function mainTree(s: RuntimeServices, git: GitRunner, repoArg: string): Promise<{ repo: string; workspace: string }> {
  const workspace = real(s.paths.workspace);
  let dir: string;
  try { dir = await realInside(s.paths.workspace, repoArg); } catch { throw new WorkforceError('forbidden', 'The repository must lie inside the workspace.'); }
  const notRepo = () => new WorkforceError('bad_request', `${repoArg} is not a git repository inside the workspace.`);
  if (!folderExists(dir)) throw notRepo();
  const probe = await git.probe(dir, ['rev-parse', '--is-inside-work-tree', '--is-bare-repository']);
  if (probe.code !== 0 || probe.stdout.split(/\r?\n/).filter(Boolean).join(',') !== 'true,false') throw notRepo();
  const first = /^worktree ([^\0]+)/.exec(await git.out(dir, ['worktree', 'list', '--porcelain', '-z']))?.[1];
  if (!first) throw notRepo();
  const repo = real(path.resolve(first));
  const roots = path.join(workspace, '.worktrees');
  if (isInside(repo, roots)) throw new WorkforceError('bad_request', 'The workspace itself is a git repository; put the project in its own folder inside the workspace.');
  if (!isInside(workspace, repo) || isInside(roots, repo)) throw notRepo();
  return { repo, workspace };
}

/** Refuses one more open worktree (the owner's own – a task id or a split id – not counted; B-057: splits' count too). */
export function checkCaps(s: RuntimeServices, ownerKey: string, repo: string, repoName: string, caps: WorktreeCaps): void {
  const active = splitRecords(s.db).filter((rec) => rec.state === 'active' && rec.taskId !== ownerKey);
  if (active.filter((rec) => sameDir(rec.repo, repo)).length >= caps.perRepo) {
    throw new WorkforceError('conflict', `${repoName} already has ${caps.perRepo} open worktrees. Finish or cancel a task there first.`);
  }
  if (active.length >= caps.total) throw new WorkforceError('conflict', `Autark already has ${caps.total} open worktrees. Finish or cancel a task first.`);
}

/** The first of `stem`, `stem-2` … `stem-9` that is a valid wf/ name and no branch yet. */
export async function freeBranch(git: GitRunner, repo: string, stem: string): Promise<string> {
  for (let n = 1; n <= 9; n++) {
    const name = n === 1 ? stem : `${stem}-${n}`;
    if (validBranch(name) && !await git.hasBranch(repo, name)) return name;
  }
  throw new WorkforceError('conflict', `The branch ${stem} already exists (also with -2 … -9). Pass another branch.`);
}

const folderFor = (workspace: string, repo: string, repoName: string, branch: string) => {
  const hash = createHash('sha256').update(process.platform === 'win32' ? repo.toLowerCase() : repo).digest('hex').slice(0, 6);
  return path.join(workspace, '.worktrees', `${slug(repoName)}-${hash}`, branch.slice('wf/'.length));
};

/** The leftover folder is still this branch's worktree. */
async function isOwnFolder(git: GitRunner, folder: string, branch: string): Promise<boolean> {
  if (!folderExists(folder)) return false;
  const top = await git.probe(folder, ['rev-parse', '--show-toplevel']);
  const head = await git.probe(folder, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return top.code === 0 && sameDir(real(path.resolve(top.stdout.trim())), real(folder)) && head.stdout.trim() === branch;
}

/** The folder of an owner's kept branch, added again (lock held, caps checked): the record active again – not saved yet. */
export async function reattach(s: RuntimeServices, git: GitRunner, at: RepoAt, existing: WorktreeRecord, caps: WorktreeCaps): Promise<WorktreeRecord> {
  checkCaps(s, existing.taskId, at.repo, at.repoName, caps);
  const folder = folderFor(at.workspace, at.repo, at.repoName, existing.branch);
  if (!await isOwnFolder(git, folder, existing.branch)) {
    // What an earlier close left behind (a folder git no longer lists): taken away, then added again.
    if (existing.leftover && sameDir(real(folder), real(existing.path)) && !await listedWorktree(git, existing)) await dropRemnant(s, existing);
    if (folderExists(folder)) throw new WorkforceError('conflict', `The folder ${toRel(at.workspace, folder)} already exists. Remove it, then try again.`);
    await git.run(at.repo, ['worktree', 'prune']);
    await mkdir(path.dirname(folder), { recursive: true });
    await git.out(at.repo, ['worktree', 'add', folder, existing.branch], ADD);
  }
  const record: WorktreeRecord = { ...existing, path: folder, rel: toRel(at.workspace, folder), state: 'active' };
  delete record.leftover;
  return record;
}

/** A new branch at `baseSha` in its own new folder under .worktrees (lock held). */
export async function addFolder(git: GitRunner, at: RepoAt, branch: string, baseSha: string): Promise<{ path: string; rel: string }> {
  const folder = folderFor(at.workspace, at.repo, at.repoName, branch);
  if (folderExists(folder)) throw new WorkforceError('conflict', `The folder ${toRel(at.workspace, folder)} already exists. Pass another branch.`);
  await mkdir(path.dirname(folder), { recursive: true });
  await git.out(at.repo, ['worktree', 'add', '-b', branch, folder, baseSha], ADD);
  return { path: folder, rel: toRel(at.workspace, folder) };
}
