// What a pasted skill link is (AF-007): a GitHub repository (github.com/<owner>/<repo>, owner/repo, .git), one of its
// folders (/tree/<ref>/<path> – a ref may hold slashes, so every split is a try, shortest ref first), a SKILL.md in it
// (/blob/…/SKILL.md – its folder is installed), a ZIP (archive, codeload, raw, releases, any https …/x.zip) or any https
// address of a SKILL.md (raw.githubusercontent.com included – that file alone). Only https; no credentials in the address.
// Owns: the recognition and the GitHub archive address of a try. Never: fetches.

import { WorkforceError } from '../../../shared/errors.ts';

export interface GithubTry {
  /** Absent: the default branch (HEAD). */
  ref?: string;
  /** The folder in the repository, '/' separators ('' = the root). */
  folder: string;
}

export type SkillLink =
  | { kind: 'github'; url: string; owner: string; repo: string; tries: GithubTry[] }
  | { kind: 'file'; url: string; /** The folder name in the address (a name when the front matter has none). */ folder: string }
  | { kind: 'zip'; url: string; /** A name for a ZIP whose root is one skill. */ folder: string; /** A GitHub archive: every entry lies in one folder <repo>-<ref>/. */ top?: true };

const MAX_LINK = 2048;
const MAX_REF_SPLITS = 8;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHORT = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const SKILL_FILE = /^skill\.md$/i;
const ZIP_FILE = /\.zip$/i;

const refuse = (message: string): never => { throw new WorkforceError('bad_request', message); };
const HELP = 'Paste a GitHub link (a repository or a folder with SKILL.md), the address of a SKILL.md or of a ZIP.';

function segmentsOf(pathname: string): string[] {
  try {
    return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return refuse('This address is not readable.');
  }
}

/** A folder route from address segments: no '.', '..', (encoded) slashes, backslashes or control characters. */
function route(parts: readonly string[]): string {
  for (const part of parts) if (part === '.' || part === '..' || /[\\/\u0000-\u001f\u007f]/.test(part)) refuse('This address holds a folder name that is not allowed.');
  return parts.join('/');
}

/** Every split of `rest` into ref + folder, shortest ref first (a branch "feature/x" is tried after "feature"). */
export function refTries(rest: readonly string[]): GithubTry[] {
  const out: GithubTry[] = [];
  for (let index = 1; index <= Math.min(rest.length, MAX_REF_SPLITS); index++) {
    out.push({ ref: route(rest.slice(0, index)), folder: route(rest.slice(index)) });
  }
  return out;
}

/** The archive of one try: github.com/<owner>/<repo>/archive/<ref or HEAD>.zip (GitHub redirects to codeload). */
export function archiveUrl(owner: string, repo: string, ref: string | undefined): string {
  const name = route((ref ?? 'HEAD').split('/')).split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${owner}/${repo}/archive/${name}.zip`;
}

/** The folder address of a GitHub try (the source shown and kept). */
export function githubUrl(owner: string, repo: string, ref: string | undefined, folder: string): string {
  const base = `https://github.com/${owner}/${repo}`;
  if (!ref) return folder ? `${base}/tree/HEAD/${folder}` : base;
  return `${base}/tree/${ref}${folder ? `/${folder}` : ''}`;
}

function github(url: URL, parts: string[]): SkillLink {
  const [owner = '', rawRepo = '', kind, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return refuse(HELP);
  const clean = `https://github.com/${owner}/${repo}`;
  if (kind === undefined) return { kind: 'github', url: clean, owner, repo, tries: [{ folder: '' }] };
  if (kind === 'tree') {
    if (!rest.length) return { kind: 'github', url: clean, owner, repo, tries: [{ folder: '' }] };
    return { kind: 'github', url: `${clean}/tree/${route(rest)}`, owner, repo, tries: refTries(rest) };
  }
  if (kind === 'blob' || kind === 'raw') {
    const last = rest[rest.length - 1] ?? '';
    if (rest.length >= 2 && SKILL_FILE.test(last)) {
      const folder = rest.slice(0, -1);
      return { kind: 'github', url: `${clean}/tree/${route(folder)}`, owner, repo, tries: refTries(folder) };
    }
    if (rest.length >= 2 && ZIP_FILE.test(last)) return { kind: 'zip', url: `${clean}/raw/${route(rest)}`, folder: last.replace(ZIP_FILE, '') };
    return refuse('This links one file of the repository. Link the folder of the skill or its SKILL.md.');
  }
  if (kind === 'archive' || kind === 'releases') {
    const last = rest[rest.length - 1] ?? '';
    if (ZIP_FILE.test(last)) return { kind: 'zip', url: url.href, folder: repo, ...(kind === 'archive' ? { top: true as const } : {}) };
  }
  return refuse(HELP);
}

/** What `input` links, or a 'bad_request' that says what works. */
export function parseSkillLink(input: string): SkillLink {
  let value = input.trim().replace(/^<(.*)>$/, '$1').replace(/^["'](.*)["']$/, '$1').trim();
  if (!value) return refuse(HELP);
  if (value.length > MAX_LINK || /[\s\u0000-\u001f\u007f]/.test(value)) return refuse('This is not one address.');
  const short = SHORT.exec(value);
  if (short && !/\.(zip|md)$/i.test(short[2]!)) return github(new URL(`https://github.com/${value}`), [short[1]!, short[2]!]); // owner/repo
  if (/^(www\.)?github\.com\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try { url = new URL(value); } catch { return refuse(HELP); }
  if (url.protocol === 'http:') return refuse('Only https links are read (this one is http).');
  if (url.protocol !== 'https:') return refuse(HELP);
  if (url.username || url.password) return refuse('A link with a user name or password in it is not read.');
  const host = url.hostname.toLowerCase();
  const parts = segmentsOf(url.pathname);
  if (GITHUB_HOSTS.has(host)) return github(url, parts);
  const last = parts[parts.length - 1] ?? '';
  url.hash = '';
  if (host === 'codeload.github.com') return { kind: 'zip', url: url.href, folder: parts[1] ?? 'skill', top: true };
  if (SKILL_FILE.test(last)) return { kind: 'file', url: url.href, folder: parts[parts.length - 2] ?? '' };
  if (ZIP_FILE.test(last)) return { kind: 'zip', url: url.href, folder: last.replace(ZIP_FILE, '') };
  return refuse(HELP);
}
