// B-055: opening and closing the feedback menu under the header's feedback cell from anywhere
// (the cell itself, the command palette, /feedback, Settings › Feedback). lib/shell-state.ts
// `feedbackOpen` stays the request ("open, from this place"); `menuShown` is whether the menu is
// drawn. The cell's tap shows it at once (its press already sent the screenshot on its way); any
// other opening shows it only after its screenshot settled (watchFeedbackOpen), so the menu is
// never in the shot. While "Paint over" is open the menu steps aside (a modal dialog would close
// it) and comes back with it closed.
// Owns: the open/close/toggle helpers and the menu's visibility. Never: the menu, capture or sending.

import { effect, signal } from '@preact/signals';
import { feedbackOpen } from '../lib/shell-state.ts';
import { formatRoute, route } from '../lib/router.ts';
import { activeConversationId } from '../lib/store.ts';
import type { DraftPlace } from './draft.ts';

/** The menu is drawn. */
export const menuShown = signal(false);
/** "Paint over" (PaintEditor) is open. */
export const paintOpen = signal(false);
/** The header cell's button the menu hangs from (null: no cell on this screen – the phone's sheet needs none). */
export const feedbackAnchor = signal<HTMLElement | null>(null);

/** Where the person is now (the report's context, feedbackOpen's value). */
export function here(): DraftPlace {
  const current = route.peek();
  return { view: formatRoute(current), conversationId: activeConversationId.peek() ?? undefined };
}

export function openFeedback(): void { if (!feedbackOpen.value) feedbackOpen.value = here(); }
export function closeFeedback(): void { feedbackOpen.value = null; menuShown.value = false; }

/** The cell's tap or the end of its talk: the screenshot is on its way already, so the menu shows now. */
export function showFeedbackNow(): void {
  menuShown.value = true; // first: the request below must not be prepared (retaken) again
  if (!feedbackOpen.peek()) feedbackOpen.value = here();
}

/** "Paint over" opens: the menu steps aside until it closes. */
export function openPaint(): void {
  menuShown.value = false;
  paintOpen.value = true;
}

export function closePaint(): void {
  paintOpen.value = false;
  if (feedbackOpen.peek()) menuShown.value = true;
}

/**
 * Installed once by the menu host: an opening from anywhere but the cell shows the menu after
 * `prepare` (the screenshot) settled; a cleared request hides it. Returns the uninstall.
 */
export function watchFeedbackOpen(prepare: () => Promise<void>): () => void {
  let preparing = false;
  return effect(() => {
    if (feedbackOpen.value === null) { if (menuShown.peek()) menuShown.value = false; return; }
    if (menuShown.peek() || paintOpen.peek() || preparing) return;
    preparing = true;
    void prepare().catch(() => undefined).then(() => {
      preparing = false;
      if (feedbackOpen.peek() && !paintOpen.peek()) menuShown.value = true;
    });
  });
}
