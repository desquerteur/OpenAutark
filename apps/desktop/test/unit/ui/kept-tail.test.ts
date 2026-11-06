// The request line's comparison code is never cut (ui/lib/kept-tail.ts, B-044 visual pass): the code
// at the end of a host-written to-do title is split off whole; any other text stays one piece; a start cut
// to fit ends in its own ellipsis (the gap before the code stays one space). A run of parts (a Work row's
// meta line, C3 D-6) is cut as a whole: one '…' where the line ends, the parts after it left out.
// Owns: these assertions only. Never: the DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutStart, runShown, splitTail } from '../../../src/ui/lib/kept-tail.ts';

test('a run of parts is shortened as a whole: one ellipsis where it ends, the rest left out', () => {
  const parts = [{ key: 'line', text: 'Waiting for the card' }, { key: 'chat', text: 'Launch plan' }, { key: 'result', text: 'Done' }];
  assert.deepEqual(runShown(parts, null), ['Waiting for the card', 'Launch plan', 'Done'], 'whole');
  assert.deepEqual(runShown(parts, 27), ['Waiting for the card', 'Launch…', null], 'cut inside the second part');
  assert.deepEqual(runShown(parts, 20), ['Waiting for the card…', null, null], 'ends right after the first part: its own ellipsis');
  assert.deepEqual(runShown(parts, 12), ['Waiting for…', null, null], 'never after a space');
  assert.deepEqual(runShown(parts, 0), ['…', null, null]);
  const chip = [{ key: 'line', text: 'Next: review' }, { key: 'branch', node: 'chip' }, { key: 'result', text: 'Merged' }];
  assert.deepEqual(runShown(chip, 12), ['Next: review…', null, null], 'a chip that does not fit is left out whole');
  assert.deepEqual(runShown(chip, 15), ['Next: review', '', 'Me…'], 'a chip that fits shows whole (it counts as one)');
});

test('a request title keeps its code as the uncut end', () => {
  assert.deepEqual(splitTail('Pixel 8 wants to open Workforce · code 7871'), ['Pixel 8 wants to open Workforce', ' · code 7871']);
  assert.deepEqual(splitTail('Tower wants to connect · code 4821'), ['Tower wants to connect', ' · code 4821']);
  assert.deepEqual(splitTail('Android · Chrome wants to open Workforce · code 5512'), ['Android · Chrome wants to open Workforce', ' · code 5512']);
});

test('any other text is one piece', () => {
  for (const text of ['Approve the launch date', 'Send the code to Mara', 'Review · code review notes', '· code 1234', '']) {
    assert.deepEqual(splitTail(text), [text, ''], text);
  }
});

test('a cut start ends in its own ellipsis, never after a space or a separator', () => {
  assert.equal(cutStart('Pixel 8 wants to open Workforce', 26), 'Pixel 8 wants to open Work…');
  assert.equal(cutStart('Pixel 8 wants to open Workforce', 14), 'Pixel 8 wants…');
  assert.equal(cutStart('Samsung Galaxy · Chrome wants to open Workforce', 16), 'Samsung Galaxy…');
  assert.equal(cutStart('Pixel', 0), '…');
});
