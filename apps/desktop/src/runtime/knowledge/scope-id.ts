// The normal ids of the shared operational scopes: a website is its host (lowercase, without
// "www." – browser/hosts.ts normalHost, the same rule the browser tools judge pages by), an app is
// its process name (lowercase, without folder and ".exe"/".app"). KnowledgeStore.save and
// knowledge.remember store these and recall finds them, so 'https://www.x.com/feed', 'www.x.com' and 'x.com'
// are one site.
// Owns: those rules, the site key form ('website:x.com' / 'app:excel') and reading a free-form
// target. Never: touches the database or treats an id as a permission.

import { normalHost, resourceHost } from '../browser/hosts.ts';

export type SiteScope = 'website' | 'app';

/** A website (host) or an app (process name) agents work in. */
export interface SiteTarget { scope: SiteScope; id: string }

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 'https://www.GitHub.com/feed', 'www.github.com:443' or 'github.com/x' → 'github.com'; undefined without a host. */
export function websiteId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  if (SCHEME.test(value)) {
    try { return normalHost(new URL(value).hostname); } catch { return undefined; }
  }
  return normalHost(value.split(/[/?#]/, 1)[0]);
}

/** 'C:\\Program Files\\Office\\EXCEL.EXE', 'excel.exe' or 'Excel' → 'excel'; undefined for no name. */
export function appId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const base = raw.trim().split(/[\\/]/).pop() ?? '';
  const name = base.toLowerCase().replace(/\.(exe|app)$/, '').trim();
  return name && name.length <= 120 ? name : undefined;
}

/** The stored form of a scope id: website and app ids normalised, every other scope's id unchanged. */
export function normalScopeId(scope: string, scopeId: string | undefined): string | undefined {
  if (scope === 'website') return websiteId(scopeId);
  if (scope === 'app') return appId(scopeId);
  return scopeId;
}

/** What a website or app scope id must look like (refusals of save and remember). */
export function scopeIdHint(scope: SiteScope): string {
  return scope === 'website' ? "the site's host (e.g. github.com) or a page URL" : "the app's process name (e.g. excel)";
}

export const siteKey = (site: SiteTarget): string => `${site.scope}:${site.id}`;

export function parseSiteKey(key: unknown): SiteTarget | undefined {
  if (typeof key !== 'string') return undefined;
  const match = /^(website|app):(.+)$/.exec(key);
  return match ? { scope: match[1] as SiteScope, id: match[2] } : undefined;
}

/** A program's path: a backslash, or a leading '/', '~/' or drive ('C:/…', '/Applications/…'). */
const PROGRAM_PATH = /\\|^(?:[a-z]:|~)?\//i;
const website = (id: string | undefined): SiteTarget | undefined => (id ? { scope: 'website', id } : undefined);

/**
 * A target as an agent names it: the site key ('website:bsky.app' / 'app:excel' – the site hints
 * print it, unambiguous), a URL or a name with a dot (website – also 'bsky.app'), else an app: a
 * process name ('notepad'), an .exe or a program's path. A dotted process name such as
 * 'Microsoft.Photos' reads as a host: only its key ('app:microsoft.photos') names the app.
 */
export function readTarget(raw: string | undefined): SiteTarget | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const value = raw.trim();
  const keyed = parseSiteKey(value);
  if (keyed) {
    const id = normalScopeId(keyed.scope, keyed.id);
    return id ? { scope: keyed.scope, id } : undefined;
  }
  if (SCHEME.test(value)) return website(websiteId(value));
  const program = /\.exe$/i.test(value) || PROGRAM_PATH.test(value);
  const host = program ? undefined : resourceHost(value.split(/[/?#]/, 1)[0]);
  if (host) return website(host);
  const app = appId(value);
  return app ? { scope: 'app', id: app } : undefined;
}
