// AF-002: where the spotlight's cut-out and its bubble go (Spotlight.tsx; tested in test/unit/ui/spotlight-geometry.test.ts).
// The hole is the target's box plus a little room, kept inside the window. The bubble sits beside the hole on the first
// side with room (below, above, right, left – or the step's own side first), slides along that side to stay in the window
// and keeps a gutter from every edge; with no room on any side it lies at the bottom over everything. A narrow window
// (phone width) or the app's phone layout docks it as a sheet at the bottom (at the top when the target lies down there);
// a step without a target puts it in the middle.
// Owns: this arithmetic. Never: reads the DOM or draws.

export interface Box { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Side = 'bottom' | 'top' | 'right' | 'left';
export interface Placement { x: number; y: number; side: Side | 'center' | 'sheet' | 'sheet-top' }

/** Room around the target inside the hole. */
export const HOLE_PAD = 6;
/** Space between the hole and the bubble. */
export const GAP = 12;
/** Space from the window's edges. */
export const GUTTER = 16;
/** Below this window width the bubble is a sheet at the bottom. */
export const SHEET_BELOW = 560;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The cut-out: the target with HOLE_PAD around it, clipped to the window (null when the target lies outside it). */
export function holeFor(target: Box | null, view: Size, pad = HOLE_PAD): Box | null {
  if (!target || target.width <= 0 || target.height <= 0) return null;
  const left = clamp(target.x - pad, 0, view.width);
  const top = clamp(target.y - pad, 0, view.height);
  const right = clamp(target.x + target.width + pad, 0, view.width);
  const bottom = clamp(target.y + target.height + pad, 0, view.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The room on each side of the hole for a bubble of `bubble`. */
function fits(side: Side, hole: Box, bubble: Size, view: Size): boolean {
  switch (side) {
    case 'bottom': return hole.y + hole.height + GAP + bubble.height <= view.height - GUTTER;
    case 'top': return hole.y - GAP - bubble.height >= GUTTER;
    case 'right': return hole.x + hole.width + GAP + bubble.width <= view.width - GUTTER;
    default: return hole.x - GAP - bubble.width >= GUTTER;
  }
}

function at(side: Side, hole: Box, bubble: Size, view: Size): Placement {
  const maxX = Math.max(GUTTER, view.width - GUTTER - bubble.width);
  const maxY = Math.max(GUTTER, view.height - GUTTER - bubble.height);
  const alongX = clamp(hole.x + hole.width / 2 - bubble.width / 2, GUTTER, maxX);
  const alongY = clamp(hole.y + hole.height / 2 - bubble.height / 2, GUTTER, maxY);
  switch (side) {
    case 'bottom': return { x: alongX, y: hole.y + hole.height + GAP, side };
    case 'top': return { x: alongX, y: hole.y - GAP - bubble.height, side };
    case 'right': return { x: hole.x + hole.width + GAP, y: alongY, side };
    default: return { x: hole.x - GAP - bubble.width, y: alongY, side };
  }
}

/** Where the bubble goes for `hole` (null: centred), its size and the window's; `sheet` (the app's phone layout, or a narrow window) docks it at the bottom. */
export function placeBubble(hole: Box | null, bubble: Size, view: Size, prefer?: Side, sheet = view.width < SHEET_BELOW): Placement {
  if (sheet) {
    // at the bottom – or at the top when the target sits where the sheet would lie (the phone's tab bar, the composer)
    const bottom = Math.max(GUTTER, view.height - GUTTER - bubble.height);
    return hole && hole.y + hole.height > bottom - GAP ? { x: GUTTER, y: GUTTER, side: 'sheet-top' } : { x: GUTTER, y: bottom, side: 'sheet' };
  }
  if (!hole) return { x: Math.max(GUTTER, (view.width - bubble.width) / 2), y: Math.max(GUTTER, (view.height - bubble.height) / 2), side: 'center' };
  const order: Side[] = ['bottom', 'top', 'right', 'left'];
  if (prefer) order.sort((a, b) => (a === prefer ? -1 : b === prefer ? 1 : 0));
  const side = order.find((candidate) => fits(candidate, hole, bubble, view));
  if (side) return at(side, hole, bubble, view);
  // No side has room (a huge target): over it, at the bottom of the window.
  return { x: clamp((view.width - bubble.width) / 2, GUTTER, Math.max(GUTTER, view.width - GUTTER - bubble.width)), y: Math.max(GUTTER, view.height - GUTTER - bubble.height), side: 'bottom' };
}

/** True when `box` is (mostly) inside the window – else the target should be scrolled into view first. */
export function inView(box: Box, view: Size): boolean {
  return box.y >= 0 && box.x >= 0 && box.y + box.height <= view.height && box.x + box.width <= view.width;
}
