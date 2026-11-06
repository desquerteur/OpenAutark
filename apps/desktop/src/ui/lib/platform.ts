// Platform detection for the one UI bundle: Electron desktop window or PWA in a browser/phone.
// Also exposes the preload bridge `window.workforce` typed exactly as its contract
// (WorkforceDesktopApi, src/shared/api/desktop.ts).
// Owns: platform/os facts, the isMobile signal and the bridge handle.
// Never: talks RPC or touches app state – callers decide what to do with these facts; never
// declares bridge members the preload does not implement.

import { signal } from '@preact/signals';
import type { WorkforceDesktopApi } from '../../shared/api/desktop.ts';

declare global {
  interface Window {
    workforce?: WorkforceDesktopApi;
  }
}

export type PlatformKind = 'desktop' | 'pwa';
export type OsKind = 'windows' | 'mac' | 'linux' | 'other';

const page: Window | undefined = typeof window === 'undefined' ? undefined : window;
const desktop = Boolean(page?.workforce && typeof page.workforce.connect === 'function');

function detectOs(): OsKind {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const hint = (page?.workforce?.platform ?? (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData?.platform ?? nav?.platform ?? '').toLowerCase();
  if (hint.startsWith('win')) return 'windows';
  if (hint.startsWith('mac') || hint === 'darwin') return 'mac';
  if (hint.includes('linux')) return 'linux';
  return 'other';
}

export const platform: PlatformKind = desktop ? 'desktop' : 'pwa';
export const os: OsKind = detectOs();
/** The desktop bridge (desktop window only; undefined in the PWA). */
export const bridge: WorkforceDesktopApi | undefined = desktop ? page?.workforce : undefined;

/**
 * Phone layout (bottom tabs + stack navigation): narrow windows and the PWA on touch devices.
 * A PWA opened in a wide desktop browser keeps the desktop layout.
 */
export const isMobile = signal(false);

export function watchLayout(): void {
  const narrow = matchMedia('(max-width: 719px)');
  const coarse = matchMedia('(pointer: coarse)');
  const update = () => {
    isMobile.value = narrow.matches || (platform === 'pwa' && coarse.matches);
  };
  update();
  narrow.addEventListener('change', update);
  coarse.addEventListener('change', update);
}

/** Opens a link outside the app (system browser on desktop, a new tab elsewhere). */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url) && !url.startsWith('mailto:')) return;
  const api = bridge;
  if (api) {
    // Main refuses some links (and may be gone during a restart): never an unhandled rejection.
    Promise.resolve().then(() => api.openExternal(url)).catch((error: unknown) => { console.warn('[workforce] the link could not be opened', error); });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export const modKey = os === 'mac' ? '⌘' : 'Ctrl+';
