// Pointer motion for the real PC pointer (B-055 Q9): turns the shared motion model
// (shared/model/pointer-motion.ts) into one helper 'path' request that replays a whole move with
// precise timing and then presses, drags or turns the wheel – so a click, a drag or a scroll over
// a point is one request, and the person moving the mouse mid-path stops it (the helper answers
// 'human_active' before anything was pressed; a drag already held is let go and reported).
// Wire format: `steps` is flat [x, y, t, x, y, t, …] in whole physical pixels and whole ms since
// the start (t never falls), at most MAX_PATH_STEPS steps (thinSteps keeps the last one exact);
// `from` is where the pointer was read before planning (the helper checks it is still there).
// Owns: the request shapes, their timing (dwell, press, double-click gap, drag holds) and the
// helper timeout for them. Never: talks to the helper, judges presence or the lease, or plans
// anything the model does not (no motion tuned to pass bot checks, B-055 Q12).

import { dwellMs, planMotion, pressMs, thinSteps, type MotionStep, type MotionStyle, type Point } from '../../shared/model/pointer-motion.ts';

export const MAX_PATH_STEPS = 600;
/** A beat between arriving and pressing even for a glide (apps take the hover first; the old jump click waited 30 ms). */
const MIN_DWELL_MS = 20;
const DRAG_DOWN_MS = 60;
const DRAG_SETTLE_MS = 60;

export type PathEnd = 'none' | 'click' | 'drag' | 'wheel';
export type Button = 'left' | 'right' | 'middle';

export interface PathArgs {
  steps: number[];
  end: PathEnd;
  from?: [number, number];
  button?: Button;
  count?: number;
  pressMs?: number;
  dwellMs?: number;
  gapMs?: number;
  /** end 'drag': the path held down, from the drag's start to its end. */
  drag?: number[];
  downMs?: number;
  settleMs?: number;
  dx?: number;
  dy?: number;
}

/** A planned request: its args, the steps as planned (for the named pointers) and its length in ms. */
export interface PlannedPath { args: PathArgs; path: MotionStep[]; ms: number }

/** Flat wire steps: whole pixels, whole ms, t never falling, at most MAX_PATH_STEPS. */
export function flatSteps(steps: readonly MotionStep[]): number[] {
  const out: number[] = [];
  let last = 0;
  for (const step of thinSteps(steps, MAX_PATH_STEPS)) {
    last = Math.max(last, Math.round(step.t));
    out.push(Math.round(step.x), Math.round(step.y), last);
  }
  return out;
}

/** The same path stretched or squeezed to last `ms` (an explicit drag duration). */
export function retime(steps: readonly MotionStep[], ms: number): MotionStep[] {
  const total = steps.at(-1)?.t ?? 0;
  if (!(total > 0)) return steps.map((step, index) => ({ ...step, t: Math.round((ms * (index + 1)) / steps.length) }));
  return steps.map((step) => ({ ...step, t: Math.round((step.t * ms) / total) }));
}

const fromArg = (from: Point | undefined): { from?: [number, number] } => (from ? { from: [Math.round(from.x), Math.round(from.y)] } : {});
const seedOf = (from: Point | undefined, to: Point) => Math.round((from?.x ?? 0) * 31 + (from?.y ?? 0) * 17 + to.x * 7 + to.y);

/** The move from the pointer (`from`, unknown: a jump) to `to`. */
export function approach(from: Point | undefined, to: Point, style: MotionStyle, targetSize?: number): MotionStep[] {
  return planMotion(from ?? to, to, { style, targetSize, seed: seedOf(from, to) });
}

/** Move only (button 'none', a hover). */
export function movePath(from: Point | undefined, to: Point, style: MotionStyle): PlannedPath {
  const path = approach(from, to, style);
  return { args: { steps: flatSteps(path), end: 'none', ...fromArg(from) }, path, ms: pathMs(path) };
}

/** Move, then click `count` times with the style's hold and dwell (a double click keeps the gap Windows expects). */
export function clickPath(from: Point | undefined, to: Point, style: MotionStyle, options: { button?: Button; count?: number; targetSize?: number } = {}): PlannedPath {
  const path = approach(from, to, style, options.targetSize);
  const seed = seedOf(from, to);
  const args: PathArgs = {
    steps: flatSteps(path), end: 'click', ...fromArg(from), button: options.button ?? 'left', count: Math.min(3, Math.max(1, Math.round(options.count ?? 1))),
    pressMs: pressMs(style, seed), dwellMs: Math.max(MIN_DWELL_MS, dwellMs(style, seed)), gapMs: style === 'human' ? 70 + (seed % 40 + 40) % 40 : 60,
  };
  return { args, path, ms: pathMs(path) + clickMs(args) };
}

/** Move, then turn the wheel (dy > 0 down, dx > 0 right; one step = one notch). */
export function wheelPath(from: Point | undefined, to: Point, style: MotionStyle, dx: number, dy: number): PlannedPath {
  const path = approach(from, to, style);
  return { args: { steps: flatSteps(path), end: 'wheel', ...fromArg(from), dx, dy, dwellMs: MIN_DWELL_MS }, path, ms: pathMs(path) + MIN_DWELL_MS };
}

/**
 * Move to the drag's start, press, travel to its end and let go. The held part never overshoots
 * (correct: false – a drop target must not be passed); `durationMs` sets its length, else the
 * style's (instant: the shortest glide, since a jump does not drag in most apps).
 */
export function dragPath(pointer: Point | undefined, from: Point, to: Point, style: MotionStyle, options: { button?: Button; durationMs?: number } = {}): PlannedPath {
  const lead = approach(pointer, from, style);
  const heldStyle = style === 'instant' ? 'glide' : style;
  let held = planMotion(from, to, { style: heldStyle, correct: false, seed: seedOf(from, to), ...(style === 'instant' ? { pace: 0.25 } : {}) });
  if (options.durationMs !== undefined) held = retime(held, options.durationMs);
  const dwell = Math.max(40, dwellMs(style, seedOf(pointer, from)));
  const args: PathArgs = {
    steps: flatSteps(lead), end: 'drag', ...fromArg(pointer), button: options.button ?? 'left', drag: flatSteps(held),
    dwellMs: dwell, downMs: DRAG_DOWN_MS, settleMs: DRAG_SETTLE_MS,
  };
  return { args, path: [...lead, ...held.map((step) => ({ ...step, t: step.t + pathMs(lead) + dwell + DRAG_DOWN_MS }))], ms: pathMs(lead) + dwell + DRAG_DOWN_MS + pathMs(held) + DRAG_SETTLE_MS };
}

/** How long the helper may take for a planned path: its length plus a margin for a slow PC. */
export function pathTimeout(planned: Pick<PlannedPath, 'ms'>): number {
  return Math.round(planned.ms) + 10_000;
}

function pathMs(path: readonly MotionStep[]): number {
  return Math.max(0, Math.round(path.at(-1)?.t ?? 0));
}

function clickMs(args: PathArgs): number {
  const count = args.count ?? 1;
  return (args.dwellMs ?? 0) + count * (args.pressMs ?? 0) + (count - 1) * (args.gapMs ?? 0);
}
