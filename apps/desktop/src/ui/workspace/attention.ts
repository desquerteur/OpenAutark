// The dots of the two Browser cells: an agent opens a tab (WorkspaceBrowserPage.opener) in the global space while the
// pane is closed – the frame's cell (shell/WindowBar.tsx) lights up – or in the open chat's space while its area is closed
// – that chat's header cell (chat/ChatHeader.tsx); opening the surface puts it out. A page an agent shows (browser.show)
// opens its surface instead (pages.ts), when that is the global pane or the open chat's area – another chat's tab waits in
// its space. Started once by the frame (shell/Shell.tsx, both layouts), which is also where pages.ts learns how a shut
// surface opens – global the pane (the preference; in the phone layout its pushed sheet, phone-pane.ts), the open chat
// its area (lib/shell-state.ts) – and where a way in
// naming no space lands: global, or in the phone layout (no global pane there) the open chat's area.
// Owns: the signals and these rules. Never: renders or shows a page to an agent.

import { effect, signal } from '@preact/signals';
import { GLOBAL_SPACE, chatSpace } from '../../shared/api/workspace-browser.ts';
import { isChatAreaOpen, setChatArea } from '../lib/shell-state.ts';
import { activeConversationId, isMobile, preferences, updatePreferences } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { browserPages, pagesListed, setOpener, watchPersonalBrowser } from './pages.ts';
import { phonePaneOpen } from './phone-pane.ts';

/** True while the closed pane has a new tab an agent opened. */
export const workspaceAttention = signal(false);
/** The chat whose closed area has a new tab an agent opened. */
export const chatAttention = signal<string | null>(null);

let started = false;

/** Starts the rule (idempotent; also keeps the tab list current while the surfaces are closed). */
export function watchWorkspaceAttention(): () => void {
  if (started) return () => undefined;
  started = true;
  watchPersonalBrowser();
  setOpener((space) => {
    const open = activeConversationId.peek();
    if (space === GLOBAL_SPACE) {
      if (isMobile.peek()) phonePaneOpen.value = true;
      else if (!preferences.peek().workspaceOpen) updatePreferences({ workspaceOpen: true }).catch((error) => toastError(error));
    }
    else if (open && space === chatSpace(open)) setChatArea(open, true);
  }, () => {
    const open = activeConversationId.peek();
    return isMobile.peek() && open ? chatSpace(open) : GLOBAL_SPACE;
  });
  let known: ReadonlySet<string> | null = null;
  const stops = [
    effect(() => { if (preferences.value.workspaceOpen || phonePaneOpen.value) workspaceAttention.value = false; }),
    effect(() => { const id = chatAttention.value; if (id && isChatAreaOpen(id)) chatAttention.value = null; }),
    effect(() => {
      if (!pagesListed.value) return; // the first list is the baseline
      const open = activeConversationId.peek();
      const fresh = browserPages.value.filter((page) => page.opener && known !== null && !known.has(page.id));
      known = new Set(browserPages.value.filter((page) => page.opener).map((page) => page.id));
      const globalShown = isMobile.peek() ? phonePaneOpen.peek() : preferences.peek().workspaceOpen;
      if (fresh.some((page) => page.space === GLOBAL_SPACE) && !globalShown) workspaceAttention.value = true;
      if (open && fresh.some((page) => page.space === chatSpace(open)) && !isChatAreaOpen(open)) chatAttention.value = open; // another chat's tabs are no new tab here
    }),
  ];
  return () => { for (const stop of stops) stop(); started = false; };
}
