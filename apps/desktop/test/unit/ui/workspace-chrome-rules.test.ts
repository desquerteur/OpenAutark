// Small rules of the pane's Chrome features: Mark a region's rectangle (ui/workspace/region.ts) and the pointer "Comment
// at" puts into a chat's draft (ui/workspace/video-pointer.ts).
// Owns: these assertions. Never: a DOM, a player or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRegion, regionBox, regionPixels, regionPoint } from '../../../src/ui/workspace/region.ts';
import { joinPointer, pointerText, pointLabel } from '../../../src/ui/workspace/video-pointer.ts';

test('a region: any drag direction, held inside the picture, a slip is none, the cut is whole pixels inside it', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(regionPoint(200, 100, rect), { x: 0.5, y: 0.5 });
  assert.deepEqual(regionPoint(0, 500, rect), { x: 0, y: 1 }, 'a drag past the edge stops at the edge');
  assert.deepEqual(regionBox({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.25 }), { x: 0.25, y: 0.25, width: 0.5, height: 0.25 });
  assert.equal(isRegion({ x: 0, y: 0, width: 0.5, height: 0.001 }), false);
  assert.equal(isRegion({ x: 0, y: 0, width: 0.02, height: 0.02 }), true);
  assert.deepEqual(regionPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.5 }, { width: 800, height: 600 }), { x: 200, y: 300, width: 400, height: 300 });
  assert.deepEqual(regionPixels({ x: 1, y: 1, width: 0, height: 0 }, { width: 10, height: 10 }), { x: 9, y: 9, width: 1, height: 1 }, 'at least one pixel, never past the edge');
});

const hex = (n: number) => String(n).repeat(64).slice(0, 64);

test('the pointer: media.look\'s clock, one line, the id\'s start when the name does not say which clip', () => {
  assert.equal(pointLabel(0), '0:00.0');
  assert.equal(pointLabel(12_400), '0:12.4');
  assert.equal(pointLabel(3_723_400), '1:02:03.4');
  const a = { fileId: `1a2b3c4d${'0'.repeat(56)}`, name: 'intro.mp4' };
  const b = { fileId: hex(2), name: 'intro.mp4' };
  const c = { fileId: hex(3), name: 'outro.mp4' };
  assert.equal(pointerText(c, 12_400, [a, b, c]), '[outro.mp4 @ 0:12.4] ');
  assert.equal(pointerText(a, 12_400, [a, b, c]), '[intro.mp4 @ 0:12.4 · 1a2b3c4d] ', 'a repeated name gets the id start');
  const odd = { fileId: a.fileId, name: 'take [final]\n@ home.mp4\u0007' };
  assert.equal(pointerText(odd, 1_000, [odd]), '[take (final)@home.mp4 @ 0:01.0] ', 'one line, no brackets, no " @ ", no control characters');
  const long = { fileId: a.fileId, name: `${'a'.repeat(100)}.mp4` };
  assert.equal(pointerText(long, 1_000, [long]), `[${'a'.repeat(79)}… @ 0:01.0 · 1a2b3c4d] `, 'a long name is cut and gets the id start');
  assert.equal(joinPointer('', '[x @ 0:01.0] '), '[x @ 0:01.0] ');
  assert.equal(joinPointer('Look at ', '[x @ 0:01.0] '), 'Look at [x @ 0:01.0] ');
  assert.equal(joinPointer('Too dark here.', '[x @ 0:01.0] '), 'Too dark here.\n[x @ 0:01.0] ');
});
