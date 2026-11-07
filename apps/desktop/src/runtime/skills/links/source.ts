// Reading a skill source into a view (AF-007): a GitHub link through its archive (github.com/<o>/<r>/archive/<ref>.zip;
// each ref/folder split of a /tree/ link is tried in turn, a 404 or a missing folder moves on), a SKILL.md address, a ZIP
// address or an uploaded ZIP. A kept source (an update) is read again with the ref and folder it was resolved to. Nothing
// but HTTPS GETs (links/fetch.ts); private repositories are not reachable this way.
// Owns: which address a source is read from and the source record's shape. Never: writes or keeps bytes beyond the view.

import type { SkillLinkSource } from '../../../shared/model/skill-links.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { skillSlug } from '../import-text.ts';
import { fileView, LINK_LIMITS, zipView, type SourceView } from './archive.ts';
import { download, type LinkFetch } from './fetch.ts';
import { archiveUrl, githubUrl, parseSkillLink, type GithubTry, type SkillLink } from './url.ts';

export interface LoadedSource {
  source: SkillLinkSource;
  view: SourceView;
  /** A name for a skill at the source's root whose SKILL.md names none. */
  fallbackName: string;
}

const lastPart = (route: string): string => route.split('/').filter(Boolean).pop() ?? '';

async function github(fetchFn: LinkFetch, owner: string, repo: string, tries: readonly GithubTry[]): Promise<LoadedSource> {
  let reached = false;
  for (const attempt of tries) {
    const got = await download(fetchFn, archiveUrl(owner, repo, attempt.ref), { maxBytes: LINK_LIMITS.archiveBytes });
    if (!got) continue; // no such repository or ref: the next split
    reached = true;
    const view = zipView(got.bytes, { stripTop: true, prefix: attempt.folder });
    if (!view.files.size) continue; // the ref has no such folder
    const source: SkillLinkSource = {
      kind: 'github', url: githubUrl(owner, repo, attempt.ref, attempt.folder), repo: `${owner}/${repo}`,
      ...(attempt.ref ? { ref: attempt.ref } : {}), ...(attempt.folder ? { folder: attempt.folder } : {}),
    };
    return { source, view, fallbackName: lastPart(attempt.folder) || repo };
  }
  throw new WorkforceError('not_found', reached
    ? 'GitHub has no such folder in this repository.'
    : 'GitHub has no such repository, branch or folder (a private repository cannot be read this way).');
}

/** The view of a parsed link. */
export async function loadLink(fetchFn: LinkFetch, link: SkillLink): Promise<LoadedSource> {
  if (link.kind === 'github') return github(fetchFn, link.owner, link.repo, link.tries);
  if (link.kind === 'file') {
    const got = await download(fetchFn, link.url, { maxBytes: LINK_LIMITS.skillFileBytes });
    if (!got) throw new WorkforceError('not_found', 'There is no file at this address.');
    return { source: { kind: 'file', url: link.url }, view: fileView(got.bytes), fallbackName: link.folder || 'skill' };
  }
  const got = await download(fetchFn, link.url, { maxBytes: LINK_LIMITS.archiveBytes });
  if (!got) throw new WorkforceError('not_found', 'There is no file at this address.');
  return { source: { kind: 'zip', url: link.url }, view: zipView(got.bytes, { stripTop: link.top === true }), fallbackName: link.folder || 'skill' };
}

/** The view of an uploaded file: a ZIP, or one SKILL.md. */
export function loadUpload(name: string, bytes: Buffer): LoadedSource {
  const base = name.replace(/\.(zip|md)$/i, '');
  const fallbackName = skillSlug(base) || 'skill';
  const source: SkillLinkSource = { kind: 'upload', url: name };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
    return { source, view: zipView(bytes), fallbackName };
  }
  if (/\.md$/i.test(name)) return { source, view: fileView(bytes), fallbackName };
  throw new WorkforceError('bad_request', 'Choose a ZIP with a skill folder in it, or a SKILL.md.');
}

/** A kept source read again (an update). An upload is read from its new file by the caller. */
export async function reloadSource(fetchFn: LinkFetch, source: SkillLinkSource): Promise<LoadedSource> {
  if (source.kind === 'upload') throw new WorkforceError('bad_request', 'This skill came from a file. Choose its new ZIP to update it.');
  if (source.kind === 'github') {
    const [owner = '', repo = ''] = (source.repo ?? '').split('/');
    const link = parseSkillLink(`https://github.com/${owner}/${repo}`); // checks the names again
    if (link.kind !== 'github') throw new WorkforceError('bad_request', 'The kept source is not readable.');
    return github(fetchFn, link.owner, link.repo, [{ ...(source.ref ? { ref: source.ref } : {}), folder: source.folder ?? '' }]);
  }
  return loadLink(fetchFn, parseSkillLink(source.url));
}
