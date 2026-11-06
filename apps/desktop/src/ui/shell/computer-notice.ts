// The status line's computer-use line: while an agent uses this PC's screen, mouse or keyboard (and the person has not
// stopped computer use) one info line says who and what, with [Watch] – it opens the Screen tab of the side pane
// (workspace/pages.ts openScreen). The only way into that tab. The line has one action cell; it is there for the whole
// time the line is (no Watch without the screen preview: the line then only informs).
// Owns: this notice (computerNotice is pure) and its registration (shell/StatusLine.tsx registerShellNotices, once per
// app start). Never: stops or resumes computer use (Workspace › Screen holds Stop / Resume) or fetches the screen.

import type { ComputerActivityState } from '../../shared/model/computer.ts';
import { can } from '../lib/session.ts';
import { openScreen } from '../workspace/pages.ts';
import { computerActivity, watchComputerActivity } from './computer-activity.ts';
import { NOTICE_PRIORITY, registerNotice, type Notice } from './notices.ts';

export const COMPUTER_NOTICE_ID = 'computer-use';

/** The line while an agent uses this PC (and computer use is not stopped), or null. */
export function computerNotice(state: ComputerActivityState | null, canWatch: boolean, watch: () => void): Notice | null {
  if (!state?.active || state.stopped) return null;
  const text = `${state.agent ?? 'An agent'} is using this PC${state.summary ? ` · ${state.summary}` : ''}`;
  return {
    id: COMPUTER_NOTICE_ID, tone: 'info', text, priority: NOTICE_PRIORITY.computer,
    ...(canWatch ? { actions: [{ label: 'Watch', run: watch }] } : {}),
  };
}

/** Registers the provider (once per app start); returns the function that removes it. */
export function registerComputerNotice(): () => void {
  watchComputerActivity();
  return registerNotice(() => computerNotice(computerActivity.value, can('computer.preview'), openScreen));
}
