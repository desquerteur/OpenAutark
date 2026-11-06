// In an agent's own browser: before a click, double click, right click or hover on an
// element the page's mouse travels there along shared/model/pointer-motion.ts planMotion – real
// mouseMoved steps, so hover effects happen on the way and viewers animate the same path. `instant`
// (browser.batch's default) does not move first (Playwright's own click moves straight there); `glide`
// (default) takes ≤ 420 ms; `human` adds the dwell before the press and the press hold. The point and the
// thinned path are returned for the named cursor (runtime/pointers/hub.ts, reported by the tools).
// Owns: the move before a pointer action and the last mouse point per tab. Never: clicks itself
// (page.ts perform does), or anything tuned to pass bot checks.

import { DEFAULT_MOTION, dwellMs, planMotion, pressMs, type MotionStep, type MotionStyle, type Point } from '../../shared/model/pointer-motion.ts';
import type { BrowserAction, LocatorLike, PageLike } from './page.ts';

/** Actions whose pointer travels to the element first. */
export const POINTER_ACTIONS: ReadonlySet<BrowserAction> = new Set<BrowserAction>(['click', 'double_click', 'right_click', 'hover', 'check', 'uncheck']);

export interface PointerMove {
  /** The target point in CSS px of the viewport. */
  x: number;
  y: number;
  /** The steps the mouse took (instant: the one end point). */
  path: MotionStep[];
  /** The press hold for a click (ms), from the style. */
  pressMs: number;
}

const last = new WeakMap<PageLike, Point>();
const sleep = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); });

/** Where the mouse of `page` is now (the viewport centre before the first move). */
function startOf(page: PageLike): Point {
  const known = last.get(page);
  if (known) return known;
  const size = page.viewportSize?.();
  return size ? { x: size.width / 2, y: size.height / 2 } : { x: 640, y: 400 };
}

/**
 * Moves `page`'s mouse to the centre of `element` in `style`; undefined when the element has no box
 * (not rendered yet: Playwright's own action then waits for it and moves straight there).
 */
export async function moveTo(page: PageLike, element: LocatorLike, style: MotionStyle = DEFAULT_MOTION, timeoutMs = 3000): Promise<PointerMove | undefined> {
  if (!element.boundingBox) return undefined;
  if (style !== 'instant') await element.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
  const box = await element.boundingBox({ timeout: timeoutMs }).catch(() => null);
  if (!box || !(box.width > 0) || !(box.height > 0)) return undefined;
  const to = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const from = startOf(page);
  const seed = Math.round(from.x * 31 + from.y * 17 + to.x * 7 + to.y);
  const path = planMotion(from, to, { style, targetSize: Math.min(box.width, box.height), seed });
  const move = page.mouse.move?.bind(page.mouse);
  if (style !== 'instant' && move) {
    const start = Date.now();
    for (const step of path) {
      const wait = step.t - (Date.now() - start);
      if (wait > 1) await sleep(wait);
      await move(step.x, step.y);
    }
    const dwell = dwellMs(style, seed);
    if (dwell > 0) await sleep(dwell);
  }
  last.set(page, to); // Playwright's own action ends on the same centre
  return { ...to, path, pressMs: pressMs(style, seed) };
}
