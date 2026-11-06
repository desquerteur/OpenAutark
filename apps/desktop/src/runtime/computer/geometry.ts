// Coordinate math for computer use: validation (Number.isFinite – a valid 0 coordinate must
// never be skipped or rejected), screenshot downscale sizes, and mapping points between a
// downscaled screenshot and physical screen pixels.
// Owns: pure functions only. Never: touches the screen or remembers state.

import { WorkforceError } from '../../shared/errors.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a screenshot came from: its image size and the physical screen rectangle it shows. */
export interface ShotGeometry {
  width: number; // image pixels
  height: number;
  origin: Point; // physical screen position of image pixel (0, 0)
  scale: number; // physical pixels per image pixel (>= 1 when downscaled)
}

/** Largest size within `maxEdge` on the long side that keeps the aspect ratio (never upscales). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
  if (!(width > 0) || !(height > 0)) throw new WorkforceError('bad_request', 'Image size must be positive.');
  const factor = Math.min(1, maxEdge / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * factor));
  const outHeight = Math.max(1, Math.round(height * factor));
  return { width: outWidth, height: outHeight, scale: width / outWidth };
}

/** A finite number (0 and negatives allowed – multi-monitor setups have negative coordinates). */
export function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkforceError('bad_request', `${name} must be a finite number (got ${typeof value === 'number' ? String(value) : typeof value}).`);
  }
  return value;
}

/** Validates a point and rounds it to whole pixels. */
export function validPoint(x: unknown, y: unknown, names: [string, string] = ['x', 'y']): Point {
  return { x: Math.round(finite(x, names[0])), y: Math.round(finite(y, names[1])) };
}

/** Checks that a point lies inside a rectangle (e.g. the virtual screen). */
export function insideRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

/** Bounding rectangle of several rectangles (the virtual desktop of all screens). */
export function union(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Screenshot pixel → physical screen pixel. */
export function toScreen(point: Point, shot: ShotGeometry): Point {
  if (point.x < 0 || point.y < 0 || point.x >= shot.width || point.y >= shot.height) {
    throw new WorkforceError('bad_request', `(${point.x}, ${point.y}) is outside the last screenshot (${shot.width}×${shot.height}).`);
  }
  return {
    x: Math.round(shot.origin.x + (point.x + 0.5) * shot.scale - 0.5),
    y: Math.round(shot.origin.y + (point.y + 0.5) * shot.scale - 0.5),
  };
}

/** Physical screen pixel → screenshot pixel (for marking elements on a screenshot). */
export function toImage(point: Point, shot: ShotGeometry): Point {
  return {
    x: Math.round((point.x - shot.origin.x + 0.5) / shot.scale - 0.5),
    y: Math.round((point.y - shot.origin.y + 0.5) / shot.scale - 0.5),
  };
}

/** Centre of a rectangle given as [x, y, width, height]. */
export function centre(rect: [number, number, number, number]): Point {
  return { x: Math.round(rect[0] + rect[2] / 2), y: Math.round(rect[1] + rect[3] / 2) };
}
