// The frame's own header controls: the rail's sidebar toggle, and at the far right of the header row the Browser cell –
// its browser icon upright, pressed while the global pane is open, a dot while a new tab waits in the closed pane
// (workspace/attention.ts) – and after it, right before the caption controls (shell.css), the feedback cell. Both lie
// over the end of the pane's tab strip, which keeps their room free; fixed 32 px cells in both states, so nothing
// beside them moves.
// Owns: sidebar/workspace toggles, the workspace and feedback cells. Never: view content, the pane itself or
// the feedback menu.

import { FeedbackButton } from '../feedback/FeedbackButton.tsx';
import { IconButton } from '../lib/ui.tsx';
import { preferences, updatePreferences } from '../lib/store.ts';
import { comboLabel } from '../lib/hotkeys.ts';
import { toastError } from '../lib/toasts.ts';
import { workspaceAttention } from '../workspace/attention.ts';

export function toggleSidebar(): void {
  updatePreferences({ sidebarOpen: !preferences.value.sidebarOpen }).catch((error) => toastError(error));
}

export function toggleWorkspace(): void {
  updatePreferences({ workspaceOpen: !preferences.value.workspaceOpen }).catch((error) => toastError(error));
}

export function SidebarToggle() {
  const shown = preferences.value.sidebarOpen;
  return <IconButton icon="sidebar-simple" label={`${shown ? 'Hide' : 'Show'} sidebar (${comboLabel('mod+b')})`} iconSize={18}
    aria-expanded={shown} onClick={toggleSidebar} />;
}

/** The frame's workspace cell (desktop, a child of the frame; shell.css positions it). */
export function WorkspaceCell() {
  const open = preferences.value.workspaceOpen;
  const dot = workspaceAttention.value && !open;
  return (
    <span class="frame-header-cell frame-workspace-cell" data-cell="workspace">
      <IconButton icon="browsers" label="Browser" title={open ? 'Hide browser' : 'Show browser'} iconSize={18}
        pressed={open} class="frame-header-button" aria-controls="workspace" aria-expanded={open} onClick={toggleWorkspace} />
      {dot && <span class="frame-header-badge dot" aria-hidden="true" />}
    </span>
  );
}

/** The frame's feedback cell (desktop, a child of the frame at the row's far right; shell.css positions it). */
export function FeedbackCell() {
  return (
    <span class="frame-header-cell frame-feedback-cell" data-cell="feedback">
      <FeedbackButton />
    </span>
  );
}
