// Element anchors for precise pointer steps (23.10.2026): a drag from one element to another (or by
// an exact offset) and wheel scrolling over an element, by refs from computer.ui_tree instead of
// guessed coordinates – e.g. a clip onto a timeline track, a slider handle to 30 % of its track, a
// row onto a folder. A point is a fraction (0–1) inside the element's rectangle as the latest
// observation showed it (physical screen pixels), kept one pixel inside its edges.
// Owns: the anchor arguments and their resolution to screen points. Never: reads the screen, moves
// the pointer or guesses an element's position (an element observed without a rectangle is refused).

import { WorkforceError } from '../../shared/errors.ts';
import type { Point } from './geometry.ts';

/** A point inside an element: its ref and the fraction across (x) and down (y), default the centre. */
export interface Anchor { ref: string; x?: number; y?: number }
/** An exact move from the start point, in physical screen pixels. */
export interface Offset { dx: number; dy: number }

export type ElementRect = [number, number, number, number];

export const ANCHOR_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', minLength: 2, maxLength: 16, description: 'an element ref from computer.ui_tree' },
    x: { type: 'number', minimum: 0, maximum: 1, description: 'fraction across the element (0 = left edge, default 0.5)' },
    y: { type: 'number', minimum: 0, maximum: 1, description: 'fraction down the element (0 = top edge, default 0.5)' },
  },
  required: ['ref'], additionalProperties: false,
} as const;

export const OFFSET_SCHEMA = {
  type: 'object',
  properties: { dx: { type: 'integer', minimum: -10_000, maximum: 10_000 }, dy: { type: 'integer', minimum: -10_000, maximum: 10_000 } },
  required: ['dx', 'dy'], additionalProperties: false,
  description: 'move by exactly these screen pixels from the start point',
} as const;

const fraction = (value: number | undefined, name: string): number => {
  const out = value ?? 0.5;
  if (!Number.isFinite(out) || out < 0 || out > 1) throw new WorkforceError('bad_request', `${name} is a fraction from 0 to 1.`);
  return out;
};

/** The screen point of an anchor in `rect` (see the header). */
export function anchorPoint(rect: ElementRect, anchor: Pick<Anchor, 'x' | 'y'>): Point {
  const [left, top, width, height] = rect;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new WorkforceError('unavailable', 'This element has no position on the screen (hidden or off-screen). Scroll it into view and observe again.');
  const inside = (start: number, size: number, part: number) => Math.round(Math.min(start + size - 1, Math.max(start, start + size * part)));
  return { x: inside(left, width, fraction(anchor.x, 'x')), y: inside(top, height, fraction(anchor.y, 'y')) };
}

/** Resolves an anchor with `rectOf` (the service's latest observation); unknown refs are refused. */
export function resolveAnchor(anchor: Anchor, rectOf: (ref: string) => ElementRect | undefined): Point {
  const rect = rectOf(anchor.ref);
  if (!rect) throw new WorkforceError('not_found', `Unknown ref "${anchor.ref}" or no position for it. Observe again with computer.ui_tree and use a ref from that output.`);
  return anchorPoint(rect, anchor);
}

/** A drag's two screen points: from an anchor to another anchor or by an exact offset. */
export function dragPoints(from: Anchor, to: Anchor | Offset, rectOf: (ref: string) => ElementRect | undefined): { from: Point; to: Point } {
  const start = resolveAnchor(from, rectOf);
  if ('ref' in to) return { from: start, to: resolveAnchor(to, rectOf) };
  if (!Number.isFinite(to.dx) || !Number.isFinite(to.dy) || (!to.dx && !to.dy)) throw new WorkforceError('bad_request', 'Move by at least one pixel (dx, dy).');
  return { from: start, to: { x: start.x + Math.round(to.dx), y: start.y + Math.round(to.dy) } };
}
