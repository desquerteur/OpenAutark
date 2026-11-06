// Back in the iPhone web app (B-078 follow-up): a Home Screen app has no system Back, so a swipe that starts within 16 px
// of the left edge and travels more than 60 px to the right (mostly sideways) calls window.autarkBack() – the same
// layered Back the Android app calls (ui/pwa/back.ts: dialog, sheet, side panel, area, pushed screen). Only that edge
// zone listens, so the chat's own horizontal swipes keep working.
// Owns: recognising that one gesture. Never: decides what Back closes.

export const EDGE_PX = 16;
export const DISTANCE_PX = 60;

/** True when a touch from `start` to `end` is the edge swipe. */
export function isEdgeSwipe(start: { x: number; y: number }, end: { x: number; y: number }): boolean {
  const dx = end.x - start.x;
  return start.x <= EDGE_PX && dx > DISTANCE_PX && Math.abs(end.y - start.y) < dx / 2;
}

/** Listens on `target` (the document); returns the off switch. */
export function startEdgeBack(target: Pick<Document, 'addEventListener' | 'removeEventListener'>, back: () => unknown = () => window.autarkBack?.()): () => void {
  let start: { x: number; y: number } | undefined;
  const down = (event: TouchEvent) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch && touch.clientX <= EDGE_PX ? { x: touch.clientX, y: touch.clientY } : undefined;
  };
  const up = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (start && touch && isEdgeSwipe(start, { x: touch.clientX, y: touch.clientY })) back();
    start = undefined;
  };
  const cancel = () => { start = undefined; };
  target.addEventListener('touchstart', down, { passive: true });
  target.addEventListener('touchend', up, { passive: true });
  target.addEventListener('touchcancel', cancel, { passive: true });
  return () => {
    target.removeEventListener('touchstart', down);
    target.removeEventListener('touchend', up);
    target.removeEventListener('touchcancel', cancel);
  };
}
