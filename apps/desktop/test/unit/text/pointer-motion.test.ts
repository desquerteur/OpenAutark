// The shared pointer motion model (B-055 Q9, shared/model/pointer-motion.ts): exact end points,
// time that only grows, the same path for the same seed, instant = one step, bounded durations,
// a human speed peak earlier than a glide's, overshoot-and-correct only on long human moves (never
// with correct:false), no NaN for odd inputs, and thinSteps keeping the last step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOTION, dwellMs, isMotionStyle, motionDuration, MOTION_STYLES, planMotion, pressMs, seededRandom, thinSteps, type MotionStep, type MotionStyle,
} from '../../../src/shared/model/pointer-motion.ts';

const A = { x: 100, y: 200 };
const moves: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
  [A, { x: 101, y: 200 }], [A, { x: 160, y: 230 }], [A, { x: 500, y: 600 }], [{ x: 1900, y: 1000 }, { x: 10, y: 15 }], [{ x: -1200, y: 40 }, { x: 300, y: -20 }],
];

/** When the path has covered half of the straight distance (share of its duration): the speed peak of a bell profile. */
function halfwayShare(steps: readonly MotionStep[], from: { x: number; y: number }, to: { x: number; y: number }): number {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length;
  const total = steps.at(-1)!.t;
  const half = steps.find((step) => (step.x - from.x) * ux + (step.y - from.y) * uy >= length / 2)!;
  return half.t / total;
}

/** The farthest the path gets along the straight line, minus the distance (> 0: it overshoots). */
function overshoot(steps: readonly MotionStep[], from: { x: number; y: number }, to: { x: number; y: number }): number {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length;
  return Math.max(...steps.map((step) => (step.x - from.x) * ux + (step.y - from.y) * uy)) - length;
}

test('styles: three, glide is the default, unknown names are not styles', () => {
  assert.deepEqual([...MOTION_STYLES], ['instant', 'glide', 'human']);
  assert.equal(DEFAULT_MOTION, 'glide');
  assert.equal(isMotionStyle('human'), true);
  for (const value of ['fast', '', undefined, 3, 'Glide']) assert.equal(isMotionStyle(value), false, String(value));
});

test('every path ends exactly at the target, time only grows, and no step is NaN', () => {
  for (const style of MOTION_STYLES) {
    for (const [from, to] of moves) {
      for (const seed of [1, 7, 99, 12345]) {
        const steps = planMotion(from, to, { style, seed });
        assert.ok(steps.length >= 1);
        assert.deepEqual({ x: steps.at(-1)!.x, y: steps.at(-1)!.y }, to, `${style} ${seed} ends at the target`);
        steps.forEach((step, i) => {
          assert.ok(Number.isFinite(step.x) && Number.isFinite(step.y) && Number.isFinite(step.t), `${style} step ${i} is finite`);
          if (i > 0) assert.ok(step.t > steps[i - 1]!.t, `${style}: t grows at step ${i}`);
        });
        if (style !== 'instant') assert.ok(steps[0]!.t > 0, 'a travelled path starts after the move began');
      }
    }
  }
});

test('the same seed gives the same path; another seed another human path', () => {
  const to = { x: 700, y: 500 };
  assert.deepEqual(planMotion(A, to, { style: 'human', seed: 42 }), planMotion(A, to, { style: 'human', seed: 42 }));
  assert.notDeepEqual(planMotion(A, to, { style: 'human', seed: 42 }), planMotion(A, to, { style: 'human', seed: 43 }));
  assert.deepEqual(planMotion(A, to, { style: 'glide' }), planMotion(A, to, { style: 'glide' }), 'without a seed: from the coordinates');
  const random = seededRandom(5);
  const again = seededRandom(5);
  for (let i = 0; i < 10; i += 1) assert.equal(random(), again());
  assert.equal(pressMs('human', 9), pressMs('human', 9));
  assert.equal(dwellMs('human', 9), dwellMs('human', 9));
});

test('instant is one step at t = 0; so is a move that goes nowhere', () => {
  assert.deepEqual(planMotion(A, { x: 900, y: 10 }, { style: 'instant' }), [{ x: 900, y: 10, t: 0 }]);
  for (const style of MOTION_STYLES) assert.deepEqual(planMotion(A, A, { style }), [{ ...A, t: 0 }], style);
  assert.equal(motionDuration(500, 'instant'), 0);
  assert.equal(pressMs('instant'), 0);
  assert.equal(dwellMs('glide'), 0);
});

test('durations follow Fitts and stay bounded: glide ≤ 420 ms, human ≤ 1400 ms, pace scales within 0.25–4', () => {
  assert.ok(motionDuration(50, 'glide') < motionDuration(800, 'glide'), 'farther takes longer');
  assert.ok(motionDuration(400, 'glide', 8) > motionDuration(400, 'glide', 80), 'a smaller target takes longer');
  assert.ok(motionDuration(400, 'human') > motionDuration(400, 'glide'), 'a hand is slower than a glide');
  for (const distance of [1, 10, 100, 1000, 10_000, 1e7]) {
    assert.ok(motionDuration(distance, 'glide') <= 420, `glide ${distance}`);
    assert.ok(motionDuration(distance, 'human') <= 1400, `human ${distance}`);
  }
  assert.equal(motionDuration(1e7, 'glide', 24, 100), 420 * 4, 'pace is clamped to 4');
  assert.equal(motionDuration(1e7, 'glide', 24, 0), Math.round(420 * 0.25), 'and to 0.25');
  const steps = planMotion(A, { x: 1500, y: 900 }, { style: 'human', seed: 3 });
  assert.ok(steps.at(-1)!.t <= 1400 + 20, 'the path itself keeps the duration (± sampling)');
  const quick = pressMs('human', 1);
  assert.ok(quick >= 55 && quick <= 120, 'a click holds 55–120 ms');
  assert.equal(pressMs('glide'), 25);
  const dwell = dwellMs('human', 1);
  assert.ok(dwell >= 40 && dwell <= 110);
});

test('a hand peaks early: half the way is covered sooner than with a glide (symmetric bell)', () => {
  const to = { x: 300, y: 260 }; // 206 px – below the correction threshold
  const glide = halfwayShare(planMotion(A, to, { style: 'glide' }), A, to);
  assert.ok(Math.abs(glide - 0.5) < 0.06, `glide is symmetric (${glide.toFixed(3)})`);
  for (const seed of [1, 2, 3, 4, 5]) {
    const human = halfwayShare(planMotion(A, to, { style: 'human', seed }), A, to);
    assert.ok(human < glide - 0.03, `seed ${seed}: human ${human.toFixed(3)} before glide ${glide.toFixed(3)}`);
  }
});

test('overshoot and correction only on long human moves, never with correct:false or for a glide', () => {
  const near = { x: 280, y: 300 }; // ~206 px
  const far = { x: 1100, y: 700 }; // ~1118 px
  for (let seed = 1; seed <= 30; seed += 1) {
    assert.ok(overshoot(planMotion(A, near, { style: 'human', seed }), A, near) < 1.5, `short move ${seed}: no overshoot beyond tremor`);
    assert.ok(overshoot(planMotion(A, far, { style: 'human', seed, correct: false }), A, far) < 1.5, `correct:false ${seed} (drags)`);
    assert.ok(overshoot(planMotion(A, far, { style: 'glide', seed }), A, far) < 0.5, `glide ${seed}`);
  }
  const corrected = Array.from({ length: 30 }, (_v, i) => overshoot(planMotion(A, far, { style: 'human', seed: i + 1 }), A, far));
  const over = corrected.filter((value) => value > 5).length;
  assert.ok(over >= 10 && over < 30, `long human moves mostly overshoot, some fall short (${over}/30 overshoot)`);
  // A corrective sub-movement: around 82 % of the time the pointer is still off target by several pixels.
  const steps = planMotion(A, far, { style: 'human', seed: 4 });
  const total = steps.at(-1)!.t;
  const at = steps.reduce((best, step) => (Math.abs(step.t - total * 0.82) < Math.abs(best.t - total * 0.82) ? step : best));
  assert.ok(Math.hypot(at.x - far.x, at.y - far.y) > 5, 'the first sub-movement aims beside the target');
});

test('odd inputs never produce NaN: a size, pace or interval that is not finite falls back; an unknown start jumps', () => {
  const to = { x: 400, y: 300 };
  for (const style of ['glide', 'human'] as MotionStyle[]) {
    for (const options of [{ targetSize: Number.NaN }, { pace: Number.NaN }, { stepMs: Number.NaN }, { seed: Number.NaN }, { pace: Number.POSITIVE_INFINITY }, { targetSize: 0 }, { stepMs: -5 }]) {
      const steps = planMotion(A, to, { style, ...options });
      assert.ok(steps.length > 1, `${style} ${JSON.stringify(options)} still travels`);
      assert.ok(steps.every((step) => Number.isFinite(step.x) && Number.isFinite(step.y) && Number.isFinite(step.t)), `${style} ${JSON.stringify(options)}`);
      assert.deepEqual({ x: steps.at(-1)!.x, y: steps.at(-1)!.y }, to);
    }
  }
  assert.deepEqual(planMotion({ x: Number.NaN, y: 3 }, to, { style: 'human' }), [{ ...to, t: 0 }], 'unknown start: a jump');
  assert.throws(() => planMotion(A, { x: Number.NaN, y: 1 }, { style: 'glide' }), RangeError);
  assert.equal(motionDuration(Number.NaN, 'glide'), 0);
  assert.equal(motionDuration(Number.POSITIVE_INFINITY, 'human'), 0);
});

test('thinSteps keeps at most max steps, in order, always with the exact last one', () => {
  const steps = planMotion(A, { x: 1500, y: 900 }, { style: 'human', seed: 8, pace: 4 });
  assert.ok(steps.length > 200);
  for (const max of [1, 2, 3, 40, 199]) {
    const thin = thinSteps(steps, max);
    assert.equal(thin.length, max, `max ${max}`);
    assert.deepEqual(thin.at(-1), steps.at(-1));
    thin.forEach((step, i) => { if (i > 0) assert.ok(step.t > thin[i - 1]!.t); });
  }
  assert.deepEqual(thinSteps(steps.slice(0, 5), 40), steps.slice(0, 5), 'short paths stay as they are');
  assert.deepEqual(thinSteps(steps, 0), [steps.at(-1)], 'max below 1 keeps the last step');
  assert.deepEqual(thinSteps(steps, Number.NaN), [steps.at(-1)]);
  assert.deepEqual(thinSteps([], 10), []);
});
