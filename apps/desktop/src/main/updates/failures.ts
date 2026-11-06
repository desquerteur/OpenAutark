// Texts of a failed update step (SM12): a failure names the updater call that failed (check or
// download) or the restart; a failed manual-download open has its own text (manual-download.ts).
// electron-updater reports one failure twice (an 'error' event and the rejected call): both get
// the text of the call in flight, so a later failure never keeps an earlier failure's text.
// Owns: these texts and which one a failure gets. Never: changes the update state.

import type { UpdateState } from '../../shared/model/system.ts';

export const MESSAGES = {
  check: 'Could not check for updates. Retrying automatically.',
  download: 'Download failed. Click to try again.',
  restart: 'Could not restart to update. Click to try again.',
};

export type UpdaterCall = 'check' | 'download';

/** The text of a failure while `running` is in flight (undefined: an unprompted report – keep a known error's text). */
export function failureText(running: UpdaterCall | undefined, state: Pick<UpdateState, 'status' | 'message'>): string {
  if (running === 'download' || state.status === 'downloading') return MESSAGES.download;
  if (running === 'check') return MESSAGES.check;
  return (state.status === 'error' ? state.message : undefined) ?? MESSAGES.check;
}
