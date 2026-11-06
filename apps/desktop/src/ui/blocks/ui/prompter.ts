// Teleprompter rules for the `record` widget (Record.tsx): a short script gets a box only as
// tall as its text (CSS keeps at least three lines), a long one the full box (min(40vh,300px))
// and scrolls by itself while recording; scrolling stops at the end.
// Owns: the fit test, the speed steps and the per-frame scroll step. Never: touches the DOM.

/** Auto-scroll speeds in px per second (the widget shows them as 1..5). */
export const PROMPTER_SPEEDS: readonly number[] = [12, 20, 30, 42, 56];

/** Longest frame gap that still counts as running (a hidden tab must not jump on return). */
const MAX_FRAME_MS = 100;

/**
 * True when the script is taller than the box can show at its maximum height, so it has to
 * scroll. `paddingY` is the box's top + bottom padding (inside its border-box max height).
 */
export function prompterScrolls(contentHeight: number, boxMaxHeight: number, paddingY = 0): boolean {
  if (!Number.isFinite(boxMaxHeight) || boxMaxHeight <= 0) return true; // no cap known: keep scrolling on
  return contentHeight > boxMaxHeight - paddingY + 1;
}

/** Scroll position after one frame of `elapsedMs` at `speed` px/s, never past `maxScroll`. */
export function prompterStep(position: number, speed: number, elapsedMs: number, maxScroll: number): number {
  const elapsed = Math.max(0, Math.min(MAX_FRAME_MS, elapsedMs));
  return Math.max(0, Math.min(maxScroll, position + (speed * elapsed) / 1000));
}
