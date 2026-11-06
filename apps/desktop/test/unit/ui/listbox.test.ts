// Custom Select rules: APG select-only combobox keys, type-ahead and list placement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLabel, isTypeAheadKey, listKey, placeList, TYPE_AHEAD_MS, typeAhead, TypeAheadBuffer } from '../../../src/ui/lib/listbox.ts';

const CLOSED = { open: false, active: -1 };
const at = (active: number) => ({ open: true, active });

test('closed: arrows open on the current value, Home/End open at the ends, other keys pass', () => {
  assert.deepEqual(listKey(CLOSED, { key: 'ArrowDown' }, 5, 2), { state: at(2), commit: false, handled: true });
  assert.deepEqual(listKey(CLOSED, { key: 'ArrowUp' }, 5, 2).state, at(2));
  assert.deepEqual(listKey(CLOSED, { key: 'ArrowDown' }, 5, -1).state, at(0), 'unknown value opens on the first option');
  assert.deepEqual(listKey(CLOSED, { key: 'Home' }, 5, 2).state, at(0));
  assert.deepEqual(listKey(CLOSED, { key: 'End' }, 5, 2).state, at(4));
  for (const key of ['Escape', 'Tab', 'Enter', ' ', 'x']) assert.equal(listKey(CLOSED, { key }, 5, 2).handled, false, key);
  assert.equal(listKey(CLOSED, { key: 'ArrowDown' }, 0, -1).handled, false, 'no options: nothing to open');
});

test('open: arrows move and stop at the ends, pages jump by ten', () => {
  assert.deepEqual(listKey(at(1), { key: 'ArrowDown' }, 5, 1).state, at(2));
  assert.deepEqual(listKey(at(4), { key: 'ArrowDown' }, 5, 1).state, at(4));
  assert.deepEqual(listKey(at(0), { key: 'ArrowUp' }, 5, 1).state, at(0));
  assert.deepEqual(listKey(at(3), { key: 'Home' }, 5, 1).state, at(0));
  assert.deepEqual(listKey(at(0), { key: 'End' }, 5, 1).state, at(4));
  assert.deepEqual(listKey(at(2), { key: 'PageDown' }, 40, 1).state, at(12));
  assert.deepEqual(listKey(at(35), { key: 'PageDown' }, 40, 1).state, at(39));
  assert.deepEqual(listKey(at(5), { key: 'PageUp' }, 40, 1).state, at(0));
});

test('open: Escape closes without a choice, Tab and Alt+ArrowUp choose the active option', () => {
  assert.deepEqual(listKey(at(3), { key: 'Escape' }, 5, 1), { state: CLOSED, commit: false, handled: true });
  assert.deepEqual(listKey(at(3), { key: 'Tab' }, 5, 1), { state: { open: false, active: 3 }, commit: true, handled: false });
  assert.deepEqual(listKey(at(3), { key: 'ArrowUp', altKey: true }, 5, 1), { state: { open: false, active: 3 }, commit: true, handled: true });
  assert.equal(listKey(at(3), { key: 'Enter' }, 5, 1).handled, false, 'Enter is the button click');
});

test('type-ahead: first match, repeated letters cycle, longer strings refine, accents fold', () => {
  const labels = ['Amsterdam', 'Berlin', 'Bern', 'Brussels', 'Über', 'Zürich'];
  assert.equal(typeAhead(labels, 'b', -1), 1);
  assert.equal(typeAhead(labels, 'b', 1), 2);
  assert.equal(typeAhead(labels, 'bb', 2), 3);
  assert.equal(typeAhead(labels, 'bbb', 3), 1, 'cycles back to the first B');
  assert.equal(typeAhead(labels, 'ber', 1), 1, 'the active option still matches');
  assert.equal(typeAhead(labels, 'bern', 1), 2);
  assert.equal(typeAhead(labels, 'u', 0), 4);
  assert.equal(typeAhead(labels, 'Z', 0), 5);
  assert.equal(typeAhead(labels, 'x', 0), -1);
  assert.equal(typeAhead([], 'a', 0), -1);
  assert.equal(foldLabel('Zürich'), 'zurich');
});

test('type-ahead buffer joins quick keys and restarts after a pause', () => {
  const buffer = new TypeAheadBuffer();
  assert.equal(buffer.push('b', 1000), 'b');
  assert.equal(buffer.push('e', 1100), 'be');
  assert.equal(buffer.push('r', 1100 + TYPE_AHEAD_MS), 'ber');
  assert.equal(buffer.push('z', 1101 + TYPE_AHEAD_MS * 2 + 1), 'z');
});

test('only plain printable keys start a type-ahead search', () => {
  assert.equal(isTypeAheadKey({ key: 'a' }), true);
  assert.equal(isTypeAheadKey({ key: 'Ä' }), true);
  assert.equal(isTypeAheadKey({ key: ' ' }), false);
  assert.equal(isTypeAheadKey({ key: 'ArrowDown' }), false);
  assert.equal(isTypeAheadKey({ key: 'a', ctrlKey: true }), false);
  assert.equal(isTypeAheadKey({ key: 'a', metaKey: true }), false);
});

test('placement: below when it fits, above when there is no room below, capped and clamped', () => {
  const viewport = { width: 800, height: 600 };
  const button = { left: 100, top: 100, bottom: 132, width: 180 };
  assert.deepEqual(placeList(button, { width: 200, height: 160 }, viewport), { left: 100, top: 136, maxHeight: 160, above: false });

  const low = { left: 100, top: 500, bottom: 532, width: 180 };
  const up = placeList(low, { width: 200, height: 160 }, viewport);
  assert.equal(up.above, true);
  assert.equal(up.maxHeight, 160);
  assert.equal(up.top, 500 - 4 - 160);

  const long = placeList(button, { width: 200, height: 2000 }, viewport);
  assert.equal(long.above, false, 'more room below than above');
  assert.equal(long.maxHeight, 320, 'capped');

  const cramped = placeList({ left: 100, top: 40, bottom: 72, width: 180 }, { width: 200, height: 2000 }, { width: 800, height: 200 });
  assert.equal(cramped.maxHeight, 200 - 72 - 4 - 8, 'never taller than the room');

  const edge = placeList({ left: 760, top: 100, bottom: 132, width: 30 }, { width: 200, height: 100 }, viewport);
  assert.equal(edge.left, 800 - 200 - 8, 'kept inside the viewport');
  assert.equal(placeList({ ...button, width: 300 }, { width: 120, height: 100 }, viewport).left, 100);
});
