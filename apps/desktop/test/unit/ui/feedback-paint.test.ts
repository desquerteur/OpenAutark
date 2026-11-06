// B-055 Q4 "Paint over" (ui/feedback/paint.ts) and the feedback draft (draft.ts): marks are opaque
// black (a round pen about 22 px on screen whatever the shot's size, filled boxes – no outlines);
// the report's one image is the painted one flattened, ONLY that – never the raw shot beside it –,
// an unpainted shot re-encoded as JPEG (starting at 0.85) within 1600 px, nothing when the box is unchecked, and
// marks without their flattened image stop the sender instead of falling back to the raw shot.
// The draft keeps its screenshot while it has text or marks (else the next press retakes it),
// dictated words join with one space, and a host without window capture takes no screenshot.
// Owns: these assertions only. Never: a canvas, a DOM or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxOf, drawMarks, EXPORT_MAX_SIDE, EXPORT_MIME, EXPORT_QUALITY, PAINT_COLOR, PAINT_UNREADY, PEN_PX, penWidth, REPORT_IMAGE_NAME, reportImage,
} from '../../../src/ui/feedback/paint.ts';
import type { PaintContext, PaintMark } from '../../../src/ui/feedback/paint.ts';
import { fitWithin, screenshotName } from '../../../src/ui/feedback/bridge.ts';
import {
  appendDraftText, clearDraft, EMPTY_DRAFT, feedbackDraft, joinText, keepsShot, paintSettled, shotSettled, shotTaking, takeShot, updateDraft, whilePainting,
} from '../../../src/ui/feedback/draft.ts';

/** Records what the marks draw (the canvas context's calls). */
function fakeContext(): PaintContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    beginPath: () => calls.push('begin'),
    moveTo: (x, y) => calls.push(`move ${x},${y}`),
    lineTo: (x, y) => calls.push(`line ${x},${y}`),
    arc: (x, y, r) => calls.push(`arc ${x},${y} r${r}`),
    stroke() { calls.push(`stroke ${this.strokeStyle} w${this.lineWidth} ${this.lineCap}`); },
    fill() { calls.push(`fill ${this.fillStyle}`); },
    fillRect(x, y, w, h) { calls.push(`rect ${this.fillStyle} ${x},${y} ${w}x${h}`); },
  };
}

test('marks are opaque black: filled boxes from any drag direction, round pen lines, a tap is a dot', () => {
  const context = fakeContext();
  const marks: PaintMark[] = [
    { tool: 'box', from: [120, 80], to: [20, 30] },
    { tool: 'pen', width: 40, points: [[10, 10], [50, 12], [90, 20]] },
    { tool: 'pen', width: 40, points: [[300, 300]] },
  ];
  drawMarks(context, marks);
  assert.equal(PAINT_COLOR, '#000000');
  assert.deepEqual(context.calls, [
    'rect #000000 20,30 100x50',
    'begin', 'move 10,10', 'line 50,12', 'line 90,20', 'stroke #000000 w40 round',
    'begin', 'arc 300,300 r20', 'fill #000000',
  ]);
  assert.equal(context.calls.some((call) => call.startsWith('stroke') && call.includes('rect')), false, 'no outline box');
  assert.deepEqual(boxOf([5, 9], [1, 2]), { x: 1, y: 2, width: 4, height: 7 });
});

test('the pen is about 22 px on screen whatever the shot\'s size', () => {
  assert.equal(PEN_PX, 22);
  assert.equal(penWidth(1600, 800), 44, 'a 1600 px shot shown 800 px wide: 44 image px');
  assert.equal(penWidth(800, 800), 22);
  assert.ok(penWidth(100, 5000) >= 2, 'never thinner than 2 px');
});

test('the report image: painted → only the flattened image; unpainted → the original to re-encode; unchecked → none', () => {
  const shot = 'data:image/png;base64,RAW';
  const painted = 'data:image/jpeg;base64,FLAT';
  const box: PaintMark = { tool: 'box', from: [0, 0], to: [10, 10] };
  assert.deepEqual(reportImage({ shot, marks: [box], painted, withShot: true }), { kind: 'painted', image: painted });
  const chosen = reportImage({ shot, marks: [box], painted, withShot: true });
  assert.ok(chosen && chosen.kind === 'painted' && !chosen.image.includes('RAW'), 'the raw shot is never the painted report\'s image');
  assert.deepEqual(reportImage({ shot, marks: [], painted: null, withShot: true }), { kind: 'original', image: shot });
  assert.equal(reportImage({ shot, marks: [box], painted, withShot: false }), null, 'unchecked: text only');
  assert.equal(reportImage({ shot: null, marks: [], painted: null, withShot: true }), null, 'no shot taken (a phone)');
  assert.deepEqual(reportImage({ shot, marks: [box], painted: null, withShot: true }), { kind: 'unready' }, 'marks without their image: never the raw shot');
  assert.match(PAINT_UNREADY, /not ready/);
});

test('every report image starts as one JPEG at quality 0.85 within 1600 px', () => {
  assert.equal(EXPORT_MIME, 'image/jpeg');
  assert.equal(EXPORT_QUALITY, 0.85);
  assert.equal(EXPORT_MAX_SIDE, 1600);
  assert.equal(REPORT_IMAGE_NAME, 'screenshot.jpg');
  assert.deepEqual(fitWithin(2880, 1800, EXPORT_MAX_SIDE), { width: 1600, height: 1000 }, 'a 1.5× window shot is scaled down');
  assert.deepEqual(fitWithin(1280, 820, EXPORT_MAX_SIDE), { width: 1280, height: 820 }, 'never up');
  assert.equal(screenshotName('data:image/jpeg;base64,x'), 'screenshot.jpg');
});

test('the draft keeps its screenshot while it has text or marks; dictated words join with one space', () => {
  const box: PaintMark = { tool: 'box', from: [0, 0], to: [1, 1] };
  assert.equal(keepsShot({ shot: 'data:x', text: '', marks: [] }), false, 'an empty draft: the next press retakes');
  assert.equal(keepsShot({ shot: 'data:x', text: '  ', marks: [] }), false);
  assert.equal(keepsShot({ shot: 'data:x', text: 'The list jumps', marks: [] }), true);
  assert.equal(keepsShot({ shot: 'data:x', text: '', marks: [box] }), true, 'painted: never thrown away by a press');
  assert.equal(keepsShot({ shot: null, text: 'x', marks: [] }), false);
  assert.equal(joinText('', ' The list jumps. '), 'The list jumps.');
  assert.equal(joinText('The list jumps.', 'Also the button.'), 'The list jumps. Also the button.');
  assert.equal(joinText('The list jumps. ', 'Also'), 'The list jumps. Also');
  assert.equal(joinText('Text', '   '), 'Text');
});

test('the draft: checked by default, text appends, cleared after sending; no window capture without a bridge', async () => {
  clearDraft();
  assert.deepEqual(feedbackDraft.value, EMPTY_DRAFT);
  assert.equal(EMPTY_DRAFT.withShot, true, 'the Screenshot box is checked by default');
  appendDraftText('The list jumps.');
  appendDraftText('Also the button.');
  assert.equal(feedbackDraft.value.text, 'The list jumps. Also the button.');
  updateDraft({ withShot: false });
  await takeShot({ view: 'home' });
  assert.equal(feedbackDraft.value.shot, null, 'a phone takes no screenshot');
  assert.equal(shotTaking.value, false);
  await shotSettled(10);
  clearDraft();
  assert.equal(feedbackDraft.value.text, '');
  assert.equal(feedbackDraft.value.withShot, true);
});

test('a Send waits for marks being flattened (whilePainting → paintSettled)', async () => {
  const order: string[] = [];
  let finish!: () => void;
  void whilePainting(new Promise<void>((resolve) => { finish = resolve; }).then(() => { order.push('painted'); }));
  const sent = paintSettled().then(() => order.push('sent'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  finish();
  await sent;
  assert.deepEqual(order, ['painted', 'sent']);
  await paintSettled(); // nothing pending: resolves at once
});

test('a failed image export also rejects a Send waiting for its painted screenshot', async () => {
  let fail!: (error: Error) => void;
  const work = whilePainting(new Promise<void>((_resolve, reject) => { fail = reject; }));
  const results = [assert.rejects(work, /image export failed/), assert.rejects(paintSettled(), /image export failed/)];
  fail(new Error('image export failed'));
  await Promise.all(results);
  await paintSettled(); // the failed work no longer blocks a new attempt
});
