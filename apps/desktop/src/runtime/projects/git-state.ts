// AF-018: a project's git state – branch, HEAD, changed paths, ahead/behind its upstream, the newest commit and the
// local branches – read with three read-only git calls through the runtime's GitRunner (git/exec.ts: no shell, no
// prompt, capped and timed out). A folder that is no repository, or a PC without git, has no git state.
// Owns: those calls and parsing their output. Never: writes, fetches or changes the repository.

import type { ProjectGit } from '../../shared/model/project.ts';
import type { GitRunner } from '../git/exec.ts';

const MAX_BRANCHES = 50;
const TIMEOUT_MS = 10_000;

export interface StatusParts { branch: string | null; head: string; dirty: number; ahead: number; behind: number; upstream?: string }

/** Parses `git status --porcelain=v2 --branch -z` (NUL-separated; a rename entry carries its old path as an extra field). */
export function parseStatus(out: string): StatusParts {
  const fields = out.split('\0');
  const parts: StatusParts = { branch: null, head: '', dirty: 0, ahead: 0, behind: 0 };
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i]!;
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      parts.head = oid === '(initial)' ? '' : oid.slice(0, 7);
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      parts.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      parts.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) { parts.ahead = Number(match[1]); parts.behind = Number(match[2]); }
    } else if (line.startsWith('#')) {
      continue;
    } else {
      parts.dirty++;
      if (line.startsWith('2 ')) i++; // renamed or copied: the next field is the original path
    }
  }
  return parts;
}

/** Parses `git log -1 --format=%h%x00%s%x00%ct` (undefined in a repository without commits). */
export function parseLastCommit(out: string): ProjectGit['lastCommit'] {
  const [sha, subject, at] = out.replace(/\r?\n$/, '').split('\0');
  if (!sha || !at) return undefined;
  const seconds = Number(at);
  return { sha: sha.trim(), subject: (subject ?? '').trim(), at: Number.isFinite(seconds) ? seconds * 1000 : 0 };
}

/** Parses `git for-each-ref --format=%(refname:short) refs/heads` – at most 50, the checked-out one kept. */
export function parseBranches(out: string, current: string | null): string[] {
  const names = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const unique = [...new Set(names)];
  const capped = unique.slice(0, MAX_BRANCHES);
  if (current && unique.includes(current) && !capped.includes(current)) capped[capped.length - 1] = current;
  return capped;
}

/** The git state of `dir`; undefined when it is no repository or git is not available. */
export async function readGit(git: GitRunner, dir: string): Promise<ProjectGit | undefined> {
  let status;
  try {
    status = await git.run(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { timeoutMs: TIMEOUT_MS });
  } catch {
    return undefined; // git missing
  }
  if (status.code !== 0 || status.timedOut) return undefined;
  const parts = parseStatus(status.stdout);
  const [log, refs] = await Promise.all([
    parts.head ? git.run(dir, ['log', '-1', '--format=%h%x00%s%x00%ct'], { timeoutMs: TIMEOUT_MS }).catch(() => undefined) : Promise.resolve(undefined),
    git.run(dir, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES * 2}`, '--format=%(refname:short)', 'refs/heads'], { timeoutMs: TIMEOUT_MS }).catch(() => undefined),
  ]);
  const lastCommit = log && log.code === 0 ? parseLastCommit(log.stdout) : undefined;
  const branches = refs && refs.code === 0 ? parseBranches(refs.stdout, parts.branch) : (parts.branch ? [parts.branch] : []);
  return {
    branch: parts.branch,
    head: parts.head,
    dirty: parts.dirty,
    ahead: parts.ahead,
    behind: parts.behind,
    ...(parts.upstream ? { upstream: parts.upstream } : {}),
    ...(lastCommit ? { lastCommit } : {}),
    branches,
  };
}
