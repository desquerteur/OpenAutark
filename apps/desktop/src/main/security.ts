// Trust and permission rules of the desktop window (pure, unit-tested; window.ts and ipc.ts
// apply them to Electron objects).
// Owns: the IPC sender trust check (only our window's main frame at app://app), the external
// link allowlist, navigation decisions for the main frame and sub-frames, permission decisions
// and the 15 s media arming. Never: touches Electron or decides anything from page-supplied
// claims (facts come from Electron's own event objects).

import { routeSandboxUrl } from './protocols/rules.ts';

/** Arming window after mediaArm (a user gesture) for getUserMedia/getDisplayMedia. */
export const MEDIA_ARM_MS = 15_000;
const MAX_URL = 4096;

export type MediaKind = 'audio' | 'video';

/** True for app://app/… (the shipped UI). */
export function isAppUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'app:' && parsed.host === 'app';
  } catch {
    return false;
  }
}

export interface SenderFacts {
  contentsId: number; // event.sender.id
  isMainFrame: boolean; // event.senderFrame === event.sender.mainFrame
  frameUrl: string | null | undefined; // event.senderFrame?.url
}

/** IPC trust: the sender must be our window's main frame showing the app. Sub-frames never are. */
export function isTrustedSender(facts: SenderFacts, windowContentsId: number | null): boolean {
  if (windowContentsId === null || facts.contentsId !== windowContentsId) return false;
  return facts.isMainFrame && isAppUrl(facts.frameUrl);
}

/**
 * Normalizes a link that may leave the app: http(s) always, mailto only when allowed.
 * Null for anything else (file:, javascript:, custom protocols, credentials in the URL, too long).
 */
export function externalUrl(value: unknown, options: { mailto?: boolean } = {}): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_URL) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol === 'mailto:') return options.mailto ? parsed.href : null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  return parsed.href;
}

export type NavigationDecision = { allow: true } | { allow: false; openExternal?: string };

/** The main frame only ever shows app://app; web links leave through the system browser. */
export function mainFrameNavigation(url: string): NavigationDecision {
  if (isAppUrl(url)) return { allow: true };
  const external = externalUrl(url);
  return external ? { allow: false, openExternal: external } : { allow: false };
}

/** Sub-frames may only load ```app mini-tools (wf-sandbox://app/…), views of <data>/pages (wf-sandbox://page/…) or blank documents. */
export function subFrameNavigationAllowed(url: string): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  const kind = routeSandboxUrl(url)?.kind;
  return kind === 'app' || kind === 'page';
}

/** window.open / target=_blank: never a new Electron window; web links open in the browser. */
export function windowOpenDecision(url: string): { action: 'deny'; openExternal?: string } {
  const external = externalUrl(url);
  return external ? { action: 'deny', openExternal: external } : { action: 'deny' };
}

/** Per-kind arming: a user gesture in the UI allows getUserMedia for MEDIA_ARM_MS. */
export class MediaArm {
  private readonly until = new Map<MediaKind, number>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(options: { now?: () => number; windowMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? MEDIA_ARM_MS;
  }

  arm(kinds: readonly MediaKind[]): void {
    const until = this.now() + this.windowMs;
    for (const kind of kinds) this.until.set(kind, Math.max(this.until.get(kind) ?? 0, until));
  }

  disarm(kind?: MediaKind): void {
    if (kind) this.until.delete(kind);
    else this.until.clear();
  }

  armed(kind: MediaKind): boolean {
    return (this.until.get(kind) ?? 0) > this.now();
  }
}

export interface PermissionFacts {
  /** The request comes from our window's main frame at app://app (never a mini-app frame). */
  trusted: boolean;
  permission: string;
  mediaTypes?: readonly string[]; // request: what getUserMedia asks for
  mediaType?: string; // check: 'audio' | 'video' | 'unknown'
}

/** Always fine for the trusted app page (copy buttons, video fullscreen). */
const HARMLESS = new Set(['clipboard-sanitized-write', 'fullscreen']);

/** setPermissionRequestHandler: media only while armed for every requested kind; default deny. */
export function allowPermissionRequest(facts: PermissionFacts, media: MediaArm): boolean {
  if (!facts.trusted) return false;
  if (HARMLESS.has(facts.permission)) return true;
  if (facts.permission !== 'media') return false;
  const kinds = facts.mediaTypes ?? [];
  if (!kinds.length) return false;
  return kinds.every(kind => (kind === 'audio' || kind === 'video') && media.armed(kind));
}

/** setPermissionCheckHandler: mirrors the request rules for the synchronous checks. */
export function allowPermissionCheck(facts: PermissionFacts, media: MediaArm): boolean {
  if (!facts.trusted) return false;
  if (HARMLESS.has(facts.permission)) return true;
  if (facts.permission !== 'media') return false;
  return (facts.mediaType === 'audio' || facts.mediaType === 'video') && media.armed(facts.mediaType);
}
