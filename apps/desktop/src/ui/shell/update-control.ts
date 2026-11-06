// What the update entry shows for main's UpdateState – in the rail, as the compact item of narrow
// desktop windows (MobileShell: in the top row) and as the action in Settings (where the auto-download preference shows only where the app
// installs by itself – not on macOS). Pure: no DOM, no bridge.
//   available   → download arrow: "Update", or "Download" where the app cannot install by itself
//                 (macOS: the click opens the download page)
//   downloading → progress ring · downloaded → check ("Restart to update") · installing → spinner with
//                 "Autark is installing 0.x and opens again by itself in about a minute" (installingText)
//   error       → retry arrow only for a failed download/open of a verified available update;
//                 background check failures stay in Settings › About ("Try again")
// Owns: these rules and texts. Never: performs the action (main's UpdateService.apply does).

import type { UpdateState } from '../../shared/model/system.ts';

export type UpdateGlyph = 'download' | 'progress' | 'ready' | 'restarting' | 'retry';

export interface UpdateControlView {
  glyph: UpdateGlyph;
  label: string; // tooltip and accessible name
  action: 'apply' | 'menu' | null; // menu: Restart / Later popover
  percent: number;
}

export const RETRY_LABEL = 'Update failed. Click to try again.';

/**
 * What the person reads while the window closes for the install (B-078): the app comes back by itself, so nobody waits
 * at a closed window wondering. Linux only swaps one file; Windows runs the installer, a Mac swaps its bundle.
 */
export function installingText(state: Pick<UpdateState, 'availableVersion'> | null, platform?: string): string {
  const version = state?.availableVersion ? ` ${state.availableVersion}` : ' the update';
  return `Autark is installing${version} and opens again by itself in ${platform === 'linux' ? 'a few seconds' : 'about a minute'}.`;
}

/** The rail/compact control, or null when nothing needs the person. */
export function updateControl(state: UpdateState | null, platform?: string): UpdateControlView | null {
  if (!state) return null;
  const percent = Math.max(0, Math.min(100, Math.round(state.percent || 0)));
  switch (state.status) {
    case 'available': return { glyph: 'download', label: state.automaticInstall ? 'Update' : 'Download', action: 'apply', percent };
    case 'downloading': return { glyph: 'progress', label: `Downloading (${percent} %)`, action: null, percent };
    case 'downloaded': return { glyph: 'ready', label: 'Restart to update', action: 'menu', percent };
    case 'installing': return { glyph: 'restarting', label: installingText(state, platform), action: null, percent };
    case 'error': return state.availableVersion && (state.failure === 'download' || state.failure === 'open')
      ? { glyph: 'retry', label: state.message ?? RETRY_LABEL, action: 'apply', percent }
      : null;
    default: return null;
  }
}

export interface AboutUpdateAction {
  label: string;
  primary: boolean;
  hint?: string;
}

/** The button next to the update status in Settings › About (all of them call apply()). */
export function aboutUpdateAction(state: UpdateState | null): AboutUpdateAction | null {
  if (!state) return null;
  switch (state.status) {
    case 'downloaded': return { label: 'Restart to update', primary: true };
    case 'available': return state.automaticInstall
      ? { label: 'Update', primary: true, hint: 'Downloads the update and restarts' }
      : { label: 'Download', primary: true, hint: 'Opens the download page – install the new version by hand' };
    case 'error': return { label: 'Try again', primary: false };
    default: return null;
  }
}

/** "Download updates automatically" does something only where the app installs updates by itself. */
export function autoDownloadApplies(state: UpdateState | null): boolean {
  return state?.automaticInstall !== false;
}
