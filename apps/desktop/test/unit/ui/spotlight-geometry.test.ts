// AF-002: where the spotlight's cut-out and bubble go (src/ui/tour/spotlight-geometry.ts): the hole is the target with
// room around it inside the window, the bubble takes the first side with room and slides along it to stay inside,
// keeps the 16 px gutter, lies in the middle without a target and becomes a sheet at the bottom on a narrow window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAP, GUTTER, HOLE_PAD, SHEET_BELOW, holeFor, inView, placeBubble } from '../../../src/ui/tour/spotlight-geometry.ts';

const view = { width: 1280, height: 800 };
const bubble = { width: 360, height: 180 };
const inside = (place: { x: number; y: number }, size = bubble, frame = view) =>
  place.x >= GUTTER - 0.01 && place.y >= GUTTER - 0.01 && place.x + size.width <= frame.width - GUTTER + 0.01 && place.y + size.height <= frame.height - GUTTER + 0.01;

test('the hole is the target plus room, clipped to the window; none for a target outside', () => {
  assert.deepEqual(holeFor({ x: 100, y: 100, width: 50, height: 20 }, view), { x: 100 - HOLE_PAD, y: 100 - HOLE_PAD, width: 50 + 2 * HOLE_PAD, height: 20 + 2 * HOLE_PAD });
  assert.deepEqual(holeFor({ x: 0, y: 0, width: 40, height: 40 }, view), { x: 0, y: 0, width: 40 + HOLE_PAD, height: 40 + HOLE_PAD }, 'at the corner: clipped');
  assert.equal(holeFor({ x: 2000, y: 100, width: 50, height: 20 }, view), null);
  assert.equal(holeFor({ x: 10, y: 10, width: 0, height: 0 }, view), null, 'a hidden target');
  assert.equal(holeFor(null, view), null);
});

test('below the target first, then above, right, left – each inside the window', () => {
  const top = placeBubble({ x: 600, y: 40, width: 80, height: 40 }, bubble, view);
  assert.equal(top.side, 'bottom');
  assert.equal(top.y, 40 + 40 + GAP);
  assert.ok(inside(top));
  const low = placeBubble({ x: 600, y: 700, width: 80, height: 60 }, bubble, view);
  assert.equal(low.side, 'top', 'no room below: above');
  assert.equal(low.y, 700 - GAP - bubble.height);
  const tall = placeBubble({ x: 0, y: 0, width: 300, height: 800 }, bubble, view);
  assert.equal(tall.side, 'right', 'a full-height sidebar: beside it');
  assert.equal(tall.x, 300 + GAP);
  assert.ok(inside(tall));
  const rightEdge = placeBubble({ x: 980, y: 0, width: 300, height: 800 }, bubble, view);
  assert.equal(rightEdge.side, 'left');
  assert.ok(inside(rightEdge));
});

test('the bubble slides along its side to stay inside, and a preferred side goes first', () => {
  const corner = placeBubble({ x: 1240, y: 10, width: 30, height: 30 }, bubble, view);
  assert.equal(corner.side, 'bottom');
  assert.equal(corner.x, view.width - GUTTER - bubble.width, 'pushed in from the right edge');
  assert.ok(inside(corner));
  const prefer = placeBubble({ x: 600, y: 300, width: 80, height: 40 }, bubble, view, 'left');
  assert.equal(prefer.side, 'left');
});

test('a target that fills the window: the bubble lies over it at the bottom; no target: in the middle', () => {
  const full = placeBubble({ x: 0, y: 0, width: 1280, height: 800 }, bubble, view);
  assert.equal(full.side, 'bottom');
  assert.ok(inside(full));
  const centre = placeBubble(null, bubble, view);
  assert.equal(centre.side, 'center');
  assert.deepEqual([centre.x, centre.y], [(1280 - 360) / 2, (800 - 180) / 2]);
});

test('a narrow window (phone width) docks the bubble as a sheet at the bottom', () => {
  const phone = { width: 375, height: 812 };
  assert.ok(phone.width < SHEET_BELOW);
  const sheet = placeBubble({ x: 10, y: 10, width: 40, height: 40 }, { width: 343, height: 200 }, phone);
  assert.equal(sheet.side, 'sheet');
  assert.equal(sheet.y, 812 - GUTTER - 200);
  assert.equal(placeBubble(null, { width: 343, height: 200 }, phone).side, 'sheet', 'also without a target');
  const low = placeBubble({ x: 0, y: 760, width: 94, height: 52 }, { width: 343, height: 200 }, phone);
  assert.deepEqual([low.side, low.y], ['sheet-top', GUTTER], 'a target down where the sheet lies (the tab bar): the sheet goes to the top');
  assert.equal(placeBubble({ x: 10, y: 10, width: 40, height: 40 }, bubble, { width: 680, height: 800 }, undefined, true).side, 'sheet', 'the app\'s phone layout in a wider window');
});

test('inView: the target is inside the window (else it is scrolled into view)', () => {
  assert.equal(inView({ x: 10, y: 10, width: 10, height: 10 }, view), true);
  assert.equal(inView({ x: 10, y: 900, width: 10, height: 10 }, view), false);
});
