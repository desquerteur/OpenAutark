// Full view of a surface (the owner's "Vollansicht machen oder Vollansicht zurück"), per space: the global pane covers the
// main zone's body (shell/Shell.tsx adds `pane-full` to .app-frame, shell.css places the pane), a chat's area takes its
// whole column above the composer (chat/ChatView.tsx adds `area-full`, chat-area.css); what lies under keeps its size and
// state. The surface's menu holds the switch (PaneMenu.tsx); closing the surface ends it (WorkspacePane.tsx).
// Owns: the signal. Never: geometry (CSS) or whether a surface is open.

import { signal } from '@preact/signals';

/** The space whose surface is in full view, if any. */
export const fullView = signal<string | null>(null);

export function toggleFullView(space: string): void {
  fullView.value = fullView.peek() === space ? null : space;
}
