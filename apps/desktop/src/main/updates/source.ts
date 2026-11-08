// AF-019: where updates come from – the GitHub repository (owner/name), the channel (stable or prereleases) and
// whether the app checks by itself. This build's default is the fork desquerteur/OpenAutark (release.ts,
// package.json build.publish); teydra/OpenAutark is the upstream one can switch to. Also the version comparison
// (semver with prereleases), the "nothing published there yet" error codes of electron-updater's GitHub provider
// and the release notes as plain text.
// Owns: these rules. Never: network access, files, electron.

import { RELEASE_REPOSITORY, UPSTREAM_REPOSITORY } from './release.ts';

export type UpdateChannel = 'stable' | 'prerelease';

export interface UpdateSource {
  /** GitHub repository `owner/name` whose releases feed the updater. */
  repository: string;
  channel: UpdateChannel;
  /** Checks by itself (start, every minute while the window is open); off: only "Check for updates now". */
  autoCheck: boolean;
}

export const DEFAULT_SOURCE: Readonly<UpdateSource> = { repository: RELEASE_REPOSITORY, channel: 'stable', autoCheck: true };

/** The repositories the settings page offers (any other valid `owner/name` may be typed in). */
export const KNOWN_REPOSITORIES: readonly string[] = [RELEASE_REPOSITORY, UPSTREAM_REPOSITORY];

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` (GitHub's rules) → its parts, anything else → null. Surrounding spaces and a github.com prefix are allowed. */
export function parseRepository(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** A stored or sent source, field by field; an invalid field keeps the default (or `base`). */
export function normalizeSource(raw: unknown, base: Readonly<UpdateSource> = DEFAULT_SOURCE): UpdateSource {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const parsed = parseRepository(value.repository);
  return {
    repository: parsed ? `${parsed.owner}/${parsed.repo}` : base.repository,
    channel: value.channel === 'stable' || value.channel === 'prerelease' ? value.channel : base.channel,
    autoCheck: typeof value.autoCheck === 'boolean' ? value.autoCheck : base.autoCheck,
  };
}

/** The electron-updater feed (setFeedURL) for a source. */
export function feedOptions(source: Pick<UpdateSource, 'repository'>): { provider: 'github'; owner: string; repo: string } {
  const parsed = parseRepository(source.repository) ?? parseRepository(DEFAULT_SOURCE.repository)!;
  return { provider: 'github', owner: parsed.owner, repo: parsed.repo };
}

interface Version { core: number[]; pre: string[] }

function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/**
 * Semver order: <0 when a is older than b, 0 when equal, >0 when newer. A prerelease is older than its release
 * (0.3.5-beta.1 < 0.3.5); numeric identifiers compare as numbers. Unparsable versions compare as equal.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index++) {
    const diff = left.core[index]! - right.core[index]!;
    if (diff) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Math.sign(Number(x) - Number(y));
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(version: string): boolean { return (parseVersion(version)?.pre.length ?? 0) > 0; }

/** Whether `candidate` is an update for `current` on `channel` (stable never offers a prerelease). */
export function offersUpdate(candidate: string, current: string, channel: UpdateChannel): boolean {
  if (!parseVersion(candidate)) return false;
  if (channel === 'stable' && isPrerelease(candidate)) return false;
  return compareVersions(candidate, current) > 0;
}

/**
 * electron-updater's GitHub provider says "nothing to update from here" with these: no release at all, no latest
 * (only drafts/prereleases), a release without latest.yml, or the repository not found (404).
 */
const NO_RELEASE_CODES = new Set(['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'HTTP_ERROR_404']);

export function isNoReleaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NO_RELEASE_CODES.has(code);
}

export function noReleaseText(repository: string): string {
  return `No update has been published in ${repository} yet. You have the latest version from there.`;
}

export const MAX_NOTES = 4000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML (GitHub's rendered notes) → readable plain text: block ends become line breaks, tags go, entities decode. */
export function plainNotes(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*br\s*\/?>|<\s*\/\s*(p|div|li|h[1-6]|ul|ol|pre|blockquote|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (entity, name: string) => {
      if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16) || 32);
      if (/^#\d/.test(name) && name !== '#39') return String.fromCodePoint(Number(name.slice(1)) || 32);
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** UpdateInfo.releaseNotes (a string, or a list per version with fullChangelog) → plain text, at most MAX_NOTES. */
export function releaseNotesText(notes: unknown): string | undefined {
  let text = '';
  if (typeof notes === 'string') text = plainNotes(notes);
  else if (Array.isArray(notes)) {
    text = notes
      .map(item => (item && typeof item === 'object' ? item as { version?: unknown; note?: unknown } : {}))
      .filter(item => typeof item.note === 'string' && item.note.trim())
      .map(item => `${typeof item.version === 'string' ? `${item.version}\n` : ''}${plainNotes(item.note as string)}`)
      .join('\n\n');
  }
  if (!text) return undefined;
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES - 1).trimEnd()}…` : text;
}
