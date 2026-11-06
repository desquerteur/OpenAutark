// B-078 ("schnell zur Seite wischen"): on the phone, a sideways swipe in a chat switches between its messages and its
// area (the chat's tabs) – the same as the header's Chat tabs cell (lib/shell-state.ts setChatArea): towards the left
// opens the area, towards the right goes back to the messages. A swipe counts only when it starts at least EDGE_PX from
// both screen edges (the system's own Back gesture keeps the edges), is clearly sideways and long enough, and does not
// start in a text field, in something that scrolls sideways itself, or on a surface that turns a finger into input of its
// own (the mirrored PC browser or screen, role="application" – a sideways drag there scrolls the PC page or moves its
// slider, it never closes the area). One passive listener set on the phone frame's main
// element (shell/MobileShell.tsx); no animation of its own, so nothing else moves.
// Owns: the gesture and its thresholds. Never: what the area shows, or swipes outside a chat.

/** 24 dp from each edge stays the system's (CSS pixels are dp in a phone's browser). */
export const EDGE_PX = 24;
/** How far the finger travels sideways before it counts. */
export const SWIPE_PX = 64;

export type SwipeTurn = 'area' | 'messages' | null;

/** What a finished touch means (pure): the area, the messages, or nothing. */
export function swipeTurn(start: { x: number; y: number }, end: { x: number; y: number }, width: number): SwipeTurn {
  if (start.x < EDGE_PX || start.x > width - EDGE_PX) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return dx < 0 ? 'area' : 'messages';
}

/** Elements whose sideways moves are their own: fields, touch surfaces of the PC browser/screen, `.no-swipe`. */
export const OWNS_SIDEWAYS = 'input, textarea, select, [contenteditable="true"], [role="application"], .browser-touch, .no-swipe';

/** True when the touch starts where a sideways move belongs to the element (OWNS_SIDEWAYS, sideways scrollers). */
export function ownsSideways(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node && node !== document.body; node = node.parentElement) {
    if (node.matches?.(OWNS_SIDEWAYS)) return true;
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

/** Listens on `root`; `chat()` names the open chat (undefined outside one), `turn` switches. Returns the stop. */
export function watchChatSwipe(root: HTMLElement, chat: () => string | undefined, turn: (chatId: string, to: Exclude<SwipeTurn, null>) => void): () => void {
  let start: { x: number; y: number } | undefined;
  const down = (event: TouchEvent) => {
    start = event.touches.length === 1 && chat() && !ownsSideways(event.target) ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : undefined;
  };
  const up = (event: TouchEvent) => {
    const from = start;
    start = undefined;
    const id = chat();
    const touch = event.changedTouches[0];
    if (!from || !id || !touch) return;
    const to = swipeTurn(from, { x: touch.clientX, y: touch.clientY }, window.innerWidth);
    if (to) turn(id, to);
  };
  const cancel = () => { start = undefined; };
  root.addEventListener('touchstart', down, { passive: true });
  root.addEventListener('touchend', up, { passive: true });
  root.addEventListener('touchcancel', cancel, { passive: true });
  return () => {
    root.removeEventListener('touchstart', down);
    root.removeEventListener('touchend', up);
    root.removeEventListener('touchcancel', cancel);
  };
}
