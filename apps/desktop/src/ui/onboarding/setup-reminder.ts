// AF-002: while the setup assistant is open and the person looks at another place than My day (Chats, Team, Settings …),
// the status line says the setup is not finished, with Continue setup (back to My day, where the assistant is). Before,
// one click on any rail button left the assistant without a trace until the next start. A status, not an offer: no
// Dismiss; it goes when the setup ends (Start, Skip on the last step, or a link to another PC).
// Owns: this notice (setupNotice is pure) and its registration (shell/StatusLine.tsx registerShellNotices).
// Never: shows on My day itself, on a window that does not run the setup, or changes the setup's step.

import { navigate } from '../lib/router.ts';
import { route } from '../lib/store.ts';
import { NOTICE_PRIORITY, registerNotice, type Notice } from '../shell/notices.ts';
import { LAYER_VIEWS } from './first-run-model.ts';
import { firstRunActive } from './first-run.ts';

export const SETUP_NOTICE_ID = 'setup-open';
export const SETUP_NOTICE_TEXT = 'Setup is not finished yet.';

/** The line while the assistant is open away from My day, or null. */
export function setupNotice(input: { open: boolean; view: string }, resume: () => void): Notice | null {
  if (!input.open || LAYER_VIEWS.includes(input.view)) return null;
  return {
    id: SETUP_NOTICE_ID, tone: 'info', priority: NOTICE_PRIORITY.setup,
    text: SETUP_NOTICE_TEXT,
    actions: [{ label: 'Continue setup', run: resume, primary: true }],
  };
}

/** Registers the provider (once per app start); returns the function that removes it. */
export function registerSetupNotice(): () => void {
  return registerNotice(() => setupNotice({ open: firstRunActive(), view: route.value.view }, () => navigate({ view: 'home' })));
}
