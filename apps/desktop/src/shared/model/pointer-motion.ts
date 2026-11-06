// Pointer motion paths (B-055): how an agent's mouse pointer travels to a target. One pure model is
// shared by the PC helper (runtime/computer), the browsers (CDP mouseMoved steps), the named cursors
// drawn over browsers and the feedback tour's big cursor, so every visible cursor moves the same way.
//   instant – jumps (fastest; batches and decision-model runs).
//   glide   – a short eased glide (Fitts' law, ≤ 420 ms, almost straight): the default, visible and cheap.
//   human   – how a hand moves a mouse: bell-shaped speed that peaks early, a slight arc, an overshoot
//             or undershoot with one corrective sub-movement on long moves, a little tremor (recordings).
// Owns: the styles, the duration rule, the path shape and its seeded noise. Never: timers, input, DOM
// or I/O (callers replay the steps), and nothing tuned to pass bot checks (B-055 Q12: those go to a person).
// Robust inputs (track D, 29.10.): a non-finite size, pace or sample interval falls back to its default,
// an unknown start (non-finite) jumps, and a non-finite target throws – a path never carries NaN.

export type MotionStyle = 'instant' | 'glide' | 'human';
export const MOTION_STYLES: readonly MotionStyle[] = ['instant', 'glide', 'human'];
/** The style used when a call names none. */
export const DEFAULT_MOTION: MotionStyle = 'glide';

export interface Point { x: number; y: number }
/** One step of a path: where the pointer is `t` ms after the move started. */
export interface MotionStep extends Point { t: number }

export interface MotionOptions {
  style: MotionStyle;
  /** Size of the target in px (Fitts' W); default 24. */
  targetSize?: number;
  /** Seed of the noise: the same seed gives the same path (tests, the tour's seekable replay). */
  seed?: number;
  /** Sample interval in ms (default 8 for human, 12 for glide). */
  stepMs?: number;
  /** Multiplies the duration (0.5 = twice as fast); clamped to 0.25–4. */
  pace?: number;
  /** Long moves overshoot or undershoot and correct (human only); false for drags. Default true. */
  correct?: boolean;
}

export function isMotionStyle(value: unknown): value is MotionStyle {
  return typeof value === 'string' && (MOTION_STYLES as readonly string[]).includes(value);
}

/** Seeded PRNG (mulberry32): deterministic, fast, good enough for motion noise. */
export function seededRandom(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** A finite number, else `fallback` (NaN and ±Infinity never reach a path). */
const finiteOr = (value: number | undefined, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Duration of a move in ms by Fitts' law (a + b·log2(D/W + 1)), per style, after `pace`. */
export function motionDuration(distance: number, style: MotionStyle, targetSize = 24, pace = 1): number {
  if (style === 'instant' || !(distance >= 1) || !Number.isFinite(distance)) return 0;
  const index = Math.log2(distance / Math.max(4, finiteOr(targetSize, 24)) + 1);
  const ms = style === 'glide' ? Math.min(420, 90 + 70 * index) : Math.min(1400, 180 + 140 * index);
  return Math.round(ms * clamp(finiteOr(pace, 1), 0.25, 4));
}

/** Minimum-jerk position profile: 0 → 1 with a bell-shaped speed (zero speed at both ends). */
function minJerk(tau: number): number {
  const t = clamp(tau, 0, 1);
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

function bezier(a: Point, c1: Point, c2: Point, b: Point, s: number): Point {
  const u = 1 - s;
  const w0 = u * u * u, w1 = 3 * u * u * s, w2 = 3 * u * s * s, w3 = s * s * s;
  return { x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y };
}

/** One sub-movement from `a` to `b` over `ms`, starting at `t0`, with an arc of `bend` (share of the distance). */
function segment(a: Point, b: Point, t0: number, ms: number, bend: number, early: number, stepMs: number, jitter: () => number): MotionStep[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const nx = -dy, ny = dx; // perpendicular (its length is the distance)
  const c1 = { x: a.x + dx * 0.3 + nx * bend, y: a.y + dy * 0.3 + ny * bend };
  const c2 = { x: a.x + dx * 0.7 + nx * bend * 0.6, y: a.y + dy * 0.7 + ny * bend * 0.6 };
  const steps: MotionStep[] = [];
  let t = 0;
  while (t < ms) {
    t = Math.min(ms, t + stepMs + jitter());
    // early < 1 moves the speed peak forward (hands accelerate fast and home in slowly).
    const p = bezier(a, c1, c2, b, minJerk(Math.pow(t / ms, early)));
    steps.push({ x: p.x, y: p.y, t: t0 + t });
  }
  return steps;
}

/**
 * The path from `from` to `to`. Every step has t > 0, t only grows, and the last step is exactly
 * `to` (instant: that single step at t = 0). Callers move the pointer to each step at its time.
 */
export function planMotion(from: Point, to: Point, options: MotionOptions): MotionStep[] {
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) throw new RangeError('planMotion: the target must be a finite point.');
  const style = options.style;
  // An unknown start (non-finite) cannot be travelled from: the pointer jumps.
  const distance = Number.isFinite(from.x) && Number.isFinite(from.y) ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
  const total = motionDuration(distance, style, options.targetSize, options.pace);
  if (total === 0) return [{ x: to.x, y: to.y, t: 0 }];
  const random = seededRandom(finiteOr(options.seed, Math.round(from.x * 31 + from.y * 17 + to.x * 7 + to.y)));
  if (style === 'glide') {
    const stepMs = Math.max(4, finiteOr(options.stepMs, 12));
    // A faint, direction-stable arc so a glide never looks like a ruler line.
    const steps = segment(from, to, 0, total, 0.03, 1, stepMs, () => 0);
    steps[steps.length - 1] = { x: to.x, y: to.y, t: total };
    return steps;
  }
  const stepMs = Math.max(4, finiteOr(options.stepMs, 8));
  const jitter = () => Math.round((random() - 0.5) * 4); // ±2 ms, like a real input sampling rate
  const bend = (0.04 + random() * 0.08) * (random() < 0.5 ? -1 : 1);
  const correct = options.correct !== false && distance > 240;
  let steps: MotionStep[];
  if (correct) {
    // Aim a little past (or short of) the target, then one small corrective movement.
    const over = random() < 0.65 ? 1 : -1;
    const miss = Math.min(18, distance * (0.015 + random() * 0.025)) * over;
    const ux = (to.x - from.x) / distance, uy = (to.y - from.y) / distance;
    const side = (random() - 0.5) * Math.min(8, distance * 0.01);
    const aim = { x: to.x + ux * miss - uy * side, y: to.y + uy * miss + ux * side };
    const first = Math.round(total * 0.82);
    steps = segment(from, aim, 0, first, bend, 0.85, stepMs, jitter);
    steps.push(...segment(aim, to, first, total - first, 0, 0.9, stepMs, jitter));
  } else {
    steps = segment(from, to, 0, total, bend * 0.6, 0.85, stepMs, jitter);
  }
  // Tremor: two small 8–12 Hz waves, faded in and out so start and end stay exact.
  const f1 = 8 + random() * 4, f2 = 8 + random() * 4, p1 = random() * 6.28, p2 = random() * 6.28;
  const amp = 0.25 + random() * 0.35;
  let last = 0;
  const out: MotionStep[] = [];
  for (const step of steps) {
    const t = Math.max(last + 1, Math.round(step.t));
    last = t;
    const fade = Math.sin(Math.PI * clamp(t / total, 0, 1));
    const s = t / 1000;
    out.push({
      x: step.x + amp * fade * Math.sin(2 * Math.PI * f1 * s + p1),
      y: step.y + amp * fade * Math.sin(2 * Math.PI * f2 * s + p2),
      t,
    });
  }
  out[out.length - 1] = { x: to.x, y: to.y, t: out[out.length - 1]!.t };
  return out;
}

/** How long a click holds the button down, in ms (human: 55–120, glide: 25, instant: 0). */
export function pressMs(style: MotionStyle, seed = 1): number {
  if (style === 'instant') return 0;
  if (style === 'glide') return 25;
  return Math.round(55 + seededRandom(seed)() * 65);
}

/** The pause between arriving and pressing, in ms (human: 40–110, otherwise 0). */
export function dwellMs(style: MotionStyle, seed = 1): number {
  return style === 'human' ? Math.round(40 + seededRandom(seed + 7)() * 70) : 0;
}

/** Thins a path to at most `max` steps (keeps the last), for wires with a size budget. */
export function thinSteps(steps: readonly MotionStep[], max: number): MotionStep[] {
  max = Math.max(1, Math.floor(finiteOr(max, 1)));
  if (steps.length <= max) return [...steps];
  const out: MotionStep[] = [];
  const every = steps.length / max;
  for (let i = 1; i <= max; i += 1) out.push(steps[Math.min(steps.length - 1, Math.round(i * every) - 1)]!);
  out[out.length - 1] = steps[steps.length - 1]!;
  return out;
}
