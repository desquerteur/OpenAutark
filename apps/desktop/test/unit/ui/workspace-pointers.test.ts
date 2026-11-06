// B-055 Q8: named cursors over a live view (ui/workspace/pointer-overlay.ts) – the surface of a
// chat's browser and of an agent's own, which pointers a view draws (its surface's, live, never the
// person's own), a page point mapped onto the letterboxed picture, a move replayed along the motion
// model's path (shared/model/pointer-motion.ts planMotion), and the person's own pointer throttled to about 8 reports a second (the newest position wins).
// Owns: these assertions. Never: a DOM, a runtime or a real timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMotion } from '../../../src/shared/model/pointer-motion.ts';
import { POINTER_TTL_MS, type PointerPoint } from '../../../src/shared/model/pointers.ts';
import { createPointerReporter, pagePointInView, pathMs, positionAt, shownPointers, viewSurface } from '../../../src/ui/workspace/pointer-overlay.ts';

const at = (actor: PointerPoint['actor'], x: number, y: number, when: number, surface = 'chat:c1/t1'): PointerPoint => ({ surface, actor, x, y, at: when });

test("surfaces: a chat's browser and an agent's own", () => {
  assert.equal(viewSurface('chat:c_1', 't7'), 'chat:c_1/t7');
  assert.equal(viewSurface('ag_ada', 't7'), 'agent:ag_ada/t7');
});

test('a view draws its surface\'s live pointers, never the person\'s own', () => {
  const ada = { kind: 'agent' as const, id: 'ag_ada', name: 'Ada' };
  const me = { kind: 'person' as const, id: 'human', name: 'Lukas' };
  const mara = { kind: 'person' as const, id: 'p_mara', name: 'Mara' };
  const now = 100_000;
  const points = [at(ada, 10, 10, now - 1000), at(me, 50, 60, now - 100), at(mara, 5, 5, now - 200), at(ada, 1, 1, now - 500, 'chat:c1/t2'), at({ ...ada, id: 'ag_old' }, 0, 0, now - POINTER_TTL_MS)];
  assert.deepEqual(shownPointers(points, 'chat:c1/t1', now, { id: 'human' }).map((point) => point.actor.id), ['ag_ada', 'p_mara'], 'own id known');
  assert.deepEqual(shownPointers(points, 'chat:c1/t1', now, { last: { x: 50, y: 60 } }).map((point) => point.actor.id), ['ag_ada', 'p_mara'], 'before the runtime named it: the point just sent');
  assert.deepEqual(shownPointers(points, 'chat:c1/t1', now, {}).map((point) => point.actor.id), ['ag_ada', 'human', 'p_mara']);
});

test('a page point lies on the letterboxed picture (CSS px of the page → px in the view)', () => {
  const frame = { width: 1280, height: 800 };
  const view = { left: 100, top: 50, width: 700, height: 500 };
  // the picture box is the view; contain: 700 × 437.5, 31.25 px bars above and below
  assert.deepEqual(pagePointInView(0, 0, frame, view, view), { left: 0, top: 31.25 });
  assert.deepEqual(pagePointInView(1280, 800, frame, view, view), { left: 700, top: 468.75 });
  assert.deepEqual(pagePointInView(640, 400, frame, { left: 150, top: 60, width: 320, height: 200 }, view), { left: 210, top: 110 }, 'a smaller picture inside the view');
  assert.equal(pagePointInView(1, 1, { width: 0, height: 0 }, view, view), undefined);
});

test('a move is replayed along the path the agent\'s mouse took', () => {
  const path = planMotion({ x: 0, y: 0 }, { x: 400, y: 100 }, { style: 'glide', seed: 3 });
  const total = pathMs(path);
  assert.ok(total > 0 && total <= 420, 'a glide is short');
  assert.deepEqual(positionAt(path, -5), { x: path[0]!.x, y: path[0]!.y }, 'before the start: its first point');
  assert.deepEqual(positionAt(path, total + 50), { x: 400, y: 100 }, 'after it: the target');
  const middle = positionAt(path, total / 2)!;
  assert.ok(middle.x > 0 && middle.x < 400, 'under way');
  const steps = [{ x: 0, y: 0, t: 0 }, { x: 10, y: 20, t: 100 }];
  assert.deepEqual(positionAt(steps, 50), { x: 5, y: 10 }, 'between two steps: in between');
  assert.equal(positionAt([], 10), undefined);
  assert.equal(pathMs(undefined), 0);
});

test("the person's pointer: the first move at once, then at most one report per 125 ms, the newest wins", () => {
  let now = 0;
  const sent: Array<{ x: number; y: number }> = [];
  const clock: { timer: { run: () => void; at: number } | null } = { timer: null };
  const reporter = createPointerReporter({
    send: (point) => sent.push(point), now: () => now,
    set: (run, ms) => { clock.timer = { run, at: now + ms }; return clock.timer; }, clear: () => { clock.timer = null; },
  });
  reporter.move({ x: 1, y: 1 });
  assert.deepEqual(sent, [{ x: 1, y: 1 }]);
  now = 20; reporter.move({ x: 2, y: 2 });
  now = 60; reporter.move({ x: 3, y: 3 });
  assert.equal(sent.length, 1, 'held back');
  assert.equal(clock.timer?.at, 125, 'one trailing timer');
  now = 125; clock.timer?.run();
  assert.deepEqual(sent.at(-1), { x: 3, y: 3 }, 'the newest position');
  now = 400; reporter.move({ x: 4, y: 4 });
  assert.deepEqual(sent.at(-1), { x: 4, y: 4 }, 'after a pause: at once again');
  now = 410; reporter.move({ x: 5, y: 5 });
  reporter.stop();
  assert.equal(clock.timer, null, 'stopped: nothing pending');
  assert.equal(sent.length, 3);
  // about 8 a second at most over a steady stream of moves
  const many: number[] = [];
  let clockNow = 0;
  const queued: { run: (() => void) | null; due: number } = { run: null, due: 0 };
  const steady = createPointerReporter({ send: () => many.push(clockNow), now: () => clockNow, set: (run, ms) => { queued.run = run; queued.due = clockNow + ms; return 1; }, clear: () => { queued.run = null; } });
  for (clockNow = 0; clockNow <= 1000; clockNow += 10) {
    const run = queued.run;
    if (run && clockNow >= queued.due) { queued.run = null; run(); }
    steady.move({ x: clockNow, y: 0 });
  }
  assert.ok(many.length <= 9, `${many.length} reports in one second`);
});
