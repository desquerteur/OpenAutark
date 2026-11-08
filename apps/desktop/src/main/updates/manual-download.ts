// Manual update install where the app cannot install by itself (unsigned macOS builds,
// automaticInstall=false): the update action opens the release download in the system browser
// instead of downloading in the background.
// Owns: which address is opened and the failure text. Never: imports electron (the opener is
// injected by updates-wiring.ts) or opens anything but the release addresses of release.ts.

import type { UpdateState } from '../../shared/model/system.ts';
import { releasesURL } from './release.ts';

export const OPEN_FAILED = 'Could not open the download page. Click to try again.';

/** This platform's installer when known, otherwise the latest release page (AF-019: of the chosen source). */
export function manualDownloadURL(state: Pick<UpdateState, 'downloadURL' | 'source'>): string {
  return state.downloadURL ?? `${releasesURL(state.source)}/latest`;
}

/** Opens the download; resolves to the state change (null on success, an error state on failure). */
export async function openManualDownload(
  state: Pick<UpdateState, 'downloadURL' | 'source'>,
  open: (url: string) => Promise<void> | void,
): Promise<Partial<UpdateState> | null> {
  try {
    await open(manualDownloadURL(state));
    return null;
  } catch {
    return { status: 'error', restartAt: undefined, message: OPEN_FAILED, failure: 'open' };
  }
}
