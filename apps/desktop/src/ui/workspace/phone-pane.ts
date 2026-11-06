// The global space's surface in the phone layout, where no pane fits beside a screen: one pushed full-screen sheet
// (shell/MobileShell.tsx). A way in that lands in global opens it (the frame's opener, attention.ts) – Watch on My day,
// say –, so does the top row's Browser cell in the desktop app's narrow window; its Back or any navigation closes it.
// Owns: whether it is open. Never: the tabs (pages.ts) or how it looks (mobile.css).

import { signal } from '@preact/signals';

export const phonePaneOpen = signal(false);
