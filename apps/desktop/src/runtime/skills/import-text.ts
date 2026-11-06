// Text helpers for SKILL.md files from outside the app (discover.ts, agent-core/home-read.ts): invisible characters
// removed (shared/text/external.ts stripInvisible), the file's hash, a name from a folder and the front matter version.
// Owns: these rules. Never: I/O.

import { createHash } from 'node:crypto';

/** stripInvisible lives in shared/text/external.ts (one rule for every text from outside this app); kept here for its callers. */
export { stripInvisible } from '../../shared/text/external.ts';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Lowercase-hyphen name (≤ 64) from a front matter name or a folder; '' when nothing usable is left. */
export function skillSlug(value: string): string {
  return value.replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

const VERSION = /^[\w.+-]{1,40}$/;

/** Front matter `version` / `metadata.version` when it is a short version text. */
export function versionOf(data: Record<string, unknown>): string | undefined {
  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : {};
  const raw = data.version ?? metadata.version;
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  return VERSION.test(value) ? value : undefined;
}
