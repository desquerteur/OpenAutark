// Mark a region: the rules of a drawn rectangle. It is kept in fractions of the picture (0–1), so it survives any shown
// size; a slip (smaller than MIN_REGION on either side) is no region; the cut is whole pixels inside the picture.
// Owns: these rules. Never: the DOM or a picture itself (RegionDialog.tsx).

export interface RegionPoint { x: number; y: number }
export interface RegionBox { x: number; y: number; width: number; height: number }

/** Regions smaller than this share of the picture on either side are taken as a slip. */
export const MIN_REGION = 0.01;

const part = (value: number) => Math.min(Math.max(value, 0), 1);

/** The point's place in a picture drawn at `rect`, in fractions, held inside it. */
export function regionPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): RegionPoint {
  return { x: part((clientX - rect.left) / Math.max(1, rect.width)), y: part((clientY - rect.top) / Math.max(1, rect.height)) };
}

/** The rectangle between two corners, whatever the drag's direction. */
export function regionBox(from: RegionPoint, to: RegionPoint): RegionBox {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

/** True for a rectangle worth keeping. */
export function isRegion(box: RegionBox): boolean {
  return box.width >= MIN_REGION && box.height >= MIN_REGION;
}

/** The rectangle in the picture's own pixels (at least one, never past its edge). */
export function regionPixels(box: RegionBox, size: { width: number; height: number }): RegionBox {
  const x = Math.min(size.width - 1, Math.floor(box.x * size.width));
  const y = Math.min(size.height - 1, Math.floor(box.y * size.height));
  return { x, y, width: Math.max(1, Math.min(size.width - x, Math.round(box.width * size.width))), height: Math.max(1, Math.min(size.height - y, Math.round(box.height * size.height))) };
}
