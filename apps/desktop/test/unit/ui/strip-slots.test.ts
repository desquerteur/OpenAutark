// The tab strip's rules (src/ui/workspace/strip-slots.ts): a closed tab under the pointer keeps its place until the
// pointer leaves, a new tab joins at the end, the tabs share the room after "+" like Chrome's (between MIN_TAB and
// MAX_TAB), the view holds whole tabs only once even the narrowest do not fit, and a tab in view is never scrolled.
// Owns: these assertions only. Never: the DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellFit, hasGhosts, MAX_TAB, MIN_TAB, NEW_TAB_CELL, placeSlots, revealTarget } from '../../../src/ui/workspace/strip-slots.ts';

const keys = (list: Array<{ key: string; ghost?: true }>) => list.map((slot) => `${slot.key}${slot.ghost ? '*' : ''}`);

test('a tab closed while the pointer is on the strip leaves an empty place; letting go removes it', () => {
  const start = placeSlots([], ['a', 'b', 'c'], false);
  assert.deepEqual(keys(start), ['a', 'b', 'c']);
  const held = placeSlots(start, ['a', 'c'], true);
  assert.deepEqual(keys(held), ['a', 'b*', 'c'], 'c stays where it was');
  assert.equal(hasGhosts(held), true);
  const closedToo = placeSlots(held, ['a'], true);
  assert.deepEqual(keys(closedToo), ['a', 'b*', 'c*'], 'the next close at the same pointer place moves nothing either');
  const released = placeSlots(closedToo, ['a'], false);
  assert.deepEqual(keys(released), ['a']);
  assert.equal(hasGhosts(released), false);
});

test('a tab that comes joins at the end, also while the strip is held; one that comes back takes its own place', () => {
  const start = placeSlots([], ['a', 'b'], false);
  assert.deepEqual(keys(placeSlots(start, ['a', 'b', 'n'], false)), ['a', 'b', 'n']);
  const held = placeSlots(start, ['b'], true);
  assert.deepEqual(keys(placeSlots(held, ['b', 'n'], true)), ['a*', 'b', 'n']);
  assert.deepEqual(keys(placeSlots(held, ['a', 'b'], true)), ['a', 'b'], 'a tab known again (main reports it) keeps its place');
});

test('at rest the places follow the list: a panel in a blank tab\'s place stays there and its neighbours do not slide', () => {
  const start = placeSlots([], ['a', 'blank', 'b'], false);
  assert.deepEqual(keys(placeSlots(start, ['a', 'day', 'b'], false)), ['a', 'day', 'b']);
});

test('the tabs share the room after "+": at most MAX_TAB, narrower with more tabs, never below MIN_TAB', () => {
  const room = (client: number) => client - NEW_TAB_CELL - 2;
  assert.deepEqual(cellFit(800, 2, 1), { width: MAX_TAB, count: 1, view: MAX_TAB }, 'one tab: the widest, "+" right after it');
  assert.equal(cellFit(800, 2, 3).width, MAX_TAB);
  const four = cellFit(400, 2, 4);
  assert.equal(four.count, 4, 'every tab in view');
  assert.equal(four.width, Math.floor((room(400) - 3 * 2) / 4));
  assert.ok(four.view <= room(400) && room(400) - four.view < 4 + 2, `the room is shared (${room(400) - four.view} px over)`);
  assert.ok(cellFit(400, 2, 6).width < four.width, 'more tabs, narrower tabs');
  for (const client of [120, 194, 216, 280, 400, 512, 736, 1400]) {
    for (const tabs of [1, 2, 3, 5, 8, 13, 30]) {
      const fit = cellFit(client, 2, tabs);
      assert.ok(fit.count >= 1 && fit.count <= tabs, `${client}/${tabs}: 1…${tabs} tabs in view`);
      assert.equal(fit.view, fit.count * fit.width + (fit.count - 1) * 2, `${client}/${tabs}: exactly whole tabs`);
      assert.ok(fit.view <= Math.max(fit.width, room(client)), `${client}/${tabs}: "+" keeps its cell`);
      assert.ok(fit.width <= MAX_TAB, `${client}/${tabs}: at most ${MAX_TAB}`);
      if (room(client) >= MIN_TAB) assert.ok(fit.width >= MIN_TAB, `${client}/${tabs}: at least ${MIN_TAB} (${fit.width})`);
    }
  }
});

test('when even the narrowest tabs do not fit, the view holds whole tabs only and the strip scrolls', () => {
  const fit = cellFit(194, 2, 8); // the owner's 420 px pane in the title row: 194 px beside the frame's cells
  assert.equal(fit.count, Math.floor((194 - NEW_TAB_CELL - 2 + 2) / (MIN_TAB + 2)), 'whole tabs of at least MIN_TAB');
  assert.ok(fit.count < 8);
  assert.ok(fit.width >= MIN_TAB && fit.width < MIN_TAB + 2 + MIN_TAB);
  assert.equal(cellFit(60, 2, 3).count, 1, 'one tab when even one narrow tab hardly fits');
});

test('a tab in view is not scrolled to; one out of view comes in with the least slide', () => {
  assert.equal(revealTarget(110, 220, 0, 332, 500), 0, 'wholly in view');
  assert.equal(revealTarget(440, 550, 0, 332, 500), 218, 'to the right: its end meets the view\'s end');
  assert.equal(revealTarget(110, 220, 330, 332, 500), 110, 'to the left: its start meets the view\'s start');
  assert.equal(revealTarget(880, 990, 0, 332, 500), 500, 'never past the end');
});
