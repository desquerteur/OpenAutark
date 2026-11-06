// B-044 layout stability helper for window tests (test/ui/lib/stable.mjs) with a fake page:
// unchanged boxes pass, moves beyond the tolerance fail with a readable list, missing elements
// before the action fail early.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectStable, layoutChanges } from '../../ui/lib/stable.mjs';

type Box = { x: number; y: number; width: number; height: number } | null;

/** A page whose measurements come from a queue (one array per measureBoxes call). */
function fakePage(measurements: Box[][]) {
  const queue = [...measurements];
  return {
    async evaluate(_fn: unknown, arg?: unknown) { return Array.isArray(arg) ? queue.shift() : true; },
  };
}

const box = (x: number, y: number, width = 32, height = 32): Box => ({ x, y, width, height });

test('nothing moved: passes and returns both measurements; sub-pixel jitter is within the tolerance', async () => {
  let ran = 0;
  const page = fakePage([[box(20, 8), box(240, 8)], [box(20.3, 8), box(240, 8)]]);
  const result = await expectStable(page, ['h2', '[data-cell=search]'], async () => { ran++; });
  assert.equal(ran, 1);
  assert.equal(result.after[0].x, 20.3);
});

test('a move fails with every element that moved, its axes and the delta', async () => {
  const page = fakePage([[box(20, 8), box(240, 8), box(0, 48, 288, 400)], [box(4, 8), box(240, 8), box(-16, 93, 304, 400)]]);
  await assert.rejects(
    expectStable(page, ['.sidebar h2', '.sidebar [data-cell=search]', '.chat-rows'], async () => undefined),
    (error: Error) => {
      assert.match(error.message, /2 of 3 element\(s\) moved \(tolerance 0\.5 px\)/);
      assert.match(error.message, /\.sidebar h2: x 20 -> 4 \(-16\)/);
      assert.match(error.message, /\.chat-rows: x 0 -> -16 \(-16\), y 48 -> 93 \(\+45\), width 288 -> 304 \(\+16\)/);
      assert.doesNotMatch(error.message, /data-cell=search/);
      return true;
    },
  );
});

test('missing before the action fails early; disappearing counts as a change', async () => {
  let ran = false;
  await assert.rejects(expectStable(fakePage([[box(0, 0), null]]), ['a', 'b'], async () => { ran = true; }), /not found before the action: b/);
  assert.equal(ran, false);
  assert.deepEqual(layoutChanges(['a'], [box(0, 0)], [null]), ['a: disappeared']);
  assert.deepEqual(layoutChanges(['a'], [box(0, 0)], [box(2, 0)], 3), [], 'a larger tolerance');
});
