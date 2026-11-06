// Streaming URLs for stored audio and video (X09), so players seek with Range requests instead of
// reading the whole file through files.read (≤ 8 MB): the desktop window streams wf-file://<id>
// (main/protocols/handlers.ts, allowed by the app CSP's media-src), the PWA the runtime's
// same-origin GET /files/<id> with the device token in the query (runtime/http/files.ts tokenOf –
// the route reads it there for exactly this and never logs it). A player of such a token URL
// takes playerGuard(): no download, casting, picture-in-picture or context menu, so the
// browser's own menus do not hand it out.
// Owns: building the URL and the guard. Never: fetches anything, or builds a URL for something
// other than a 64-hex blob id.

import { hostedShell } from '../pwa/hosted.ts';
import { platform as currentPlatform } from './platform.ts';
import type { PlatformKind } from './platform.ts';

/** Same key as lib/rpc.ts TOKEN_KEY (a unit test guards that they stay equal). */
const TOKEN_KEY = 'wf.token';
const FILE_ID = /^[0-9a-f]{64}$/;

export interface StreamEnv {
  platform: PlatformKind;
  origin: string;
  token: string;
}

function storedToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

/** This page's origin – inside the iPhone web app plus the shell's base, whose service worker relays /files to the PC. */
function pageOrigin(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
  const hosted = hostedShell();
  return hosted && origin ? `${origin}${hosted.base.replace(/\/$/, '')}` : origin;
}

/** This page's platform, origin and device token (read when asked). */
export function currentEnv(): StreamEnv {
  return { platform: currentPlatform, origin: pageOrigin(), token: currentPlatform === 'pwa' ? storedToken() : '' };
}

/** A URL the player can stream `fileId` from, or null (no route on this platform or page, no token, not a blob id). */
export function streamUrl(fileId: string, env: StreamEnv = currentEnv()): string | null {
  if (!FILE_ID.test(fileId)) return null;
  if (env.platform === 'desktop') return `wf-file://${fileId}`;
  if (env.platform !== 'pwa' || !env.token || !env.origin) return null;
  return `${env.origin}/files/${fileId}?token=${encodeURIComponent(env.token)}`;
}

/** Player attributes that keep a token URL out of the browser's own menus. */
export interface PlayerGuard {
  controlsList?: string;
  disablePictureInPicture?: boolean;
  disableRemotePlayback?: boolean;
  onContextMenu?: (event: Event) => void;
}

const TOKEN_GUARD: PlayerGuard = {
  controlsList: 'nodownload noremoteplayback', disablePictureInPicture: true, disableRemotePlayback: true,
  onContextMenu: (event) => event.preventDefault(),
};

/**
 * For a player of `url`: when the URL carries the device token (the PWA's /files?token=), no
 * "Save as", casting, picture-in-picture or context menu ("Copy video address", "Open in new tab"),
 * which would hand the token out. Nothing for other URLs.
 */
export function playerGuard(url: string | null): PlayerGuard {
  return url && /[?&]token=/.test(url) ? TOKEN_GUARD : {};
}
