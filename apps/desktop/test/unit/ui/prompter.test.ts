// Teleprompter: short scripts fit (no scrolling), long ones scroll; the scroll step is bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPTER_SPEEDS, prompterScrolls, prompterStep } from '../../../src/ui/blocks/ui/prompter.ts';

test('a script that fits the capped box does not scroll; a longer one does', () => {
  // Box max 300px incl. 32px padding → 268px of text fit.
  assert.equal(prompterScrolls(113, 300, 32), false, 'three lines');
  assert.equal(prompterScrolls(268, 300, 32), false, 'exactly full');
  assert.equal(prompterScrolls(269, 300, 32), false, 'sub-pixel rounding tolerated');
  assert.equal(prompterScrolls(400, 300, 32), true);
  assert.equal(prompterScrolls(280, 300), false, 'no padding given');
});

test('without a known cap the prompter keeps the scrolling behaviour', () => {
  assert.equal(prompterScrolls(50, Number.NaN, 32), true);
  assert.equal(prompterScrolls(50, 0, 32), true);
});

test('scroll step follows speed and time, stops at the end and ignores long gaps', () => {
  assert.equal(prompterStep(0, 30, 16, 1000), 0.48);
  assert.ok(Math.abs(prompterStep(990, 56, 100, 1000) - 995.6) < 1e-9);
  assert.equal(prompterStep(999, 56, 100, 1000), 1000, 'never past the end');
  assert.equal(prompterStep(10, 30, 5000, 1000), 13, 'a hidden tab does not jump');
  assert.equal(prompterStep(10, 30, -20, 1000), 10);
  assert.equal(prompterStep(0, 30, 16, -5), 0, 'nothing to scroll');
  assert.deepEqual([...PROMPTER_SPEEDS], [12, 20, 30, 42, 56]);
});
