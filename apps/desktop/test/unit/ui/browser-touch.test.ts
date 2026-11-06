// X02 touch on a taken-over agent browser (src/ui/workspace/browser-touch.ts): a tap is a left
// click at the frame point (down + up, clicks 1), a second tap close by is a double click, jitter
// stays a tap, a drag at 1x scrolls the page in frame units, a drag at 2x sends nothing, more
// fingers are ignored; the hidden key field's proxy turns text, the deleted sentinel and Enter
// into page input and always goes back to the sentinel.
// Owns: these assertions only. Never: a DOM or a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_SENTINEL, keyProxy, touchGestures, type TouchLike, type TouchMap } from '../../../src/ui/workspace/browser-touch.ts';
import type { BrowserInput } from '../../../src/shared/model/browser.ts';

/** The picture drawn 640 px wide for a 1280 × 720 frame at the top left: frame point = 2 × client point. */
function rig(zoom: 1 | 2 = 1) {
  const sent: BrowserInput[] = [];
  const map: TouchMap = {
    point: (x, y) => (x >= 0 && y >= 0 && x <= 640 && y <= 360 ? { x: x * 2, y: y * 2, width: 1280, height: 720 } : undefined),
    scale: () => 2,
    zoom: () => zoom,
  };
  const gestures = touchGestures(map, (input) => sent.push(input));
  const at = (points: Array<[number, number]>, timeStamp: number): TouchLike => ({ touches: points.map(([clientX, clientY]) => ({ clientX, clientY })), timeStamp });
  /** One finger down at (x, y), moved through `path`, lifted after `ms`. */
  const finger = (x: number, y: number, t: number, ms = 80, path: Array<[number, number]> = []) => {
    gestures.start(at([[x, y]], t));
    for (const point of path) gestures.move(at([point], t + 10));
    return gestures.end(at([], t + ms));
  };
  return { sent, gestures, at, finger };
}

test('a tap clicks at the mapped frame point; a quick second tap close by double-clicks', () => {
  const r = rig();
  assert.equal(r.finger(100, 50, 1000), true, 'handled: the synthetic mouse events are cancelled');
  assert.deepEqual(r.sent, [
    { kind: 'mouse', type: 'down', x: 200, y: 100, width: 1280, height: 720, button: 'left', buttons: 1, clicks: 1 },
    { kind: 'mouse', type: 'up', x: 200, y: 100, width: 1280, height: 720, button: 'left', buttons: 0, clicks: 1 },
  ]);
  r.sent.length = 0;
  r.finger(110, 55, 1200); // 120 ms after the first tap ended, 11 px away
  assert.deepEqual(r.sent.map((input) => input.kind === 'mouse' && [input.type, input.clicks]), [['down', 2], ['up', 2]]);
  r.sent.length = 0;
  r.finger(400, 300, 1300); // far away: a new single click
  r.finger(100, 50, 2000); // too late for a double click
  assert.deepEqual(r.sent.filter((input) => input.kind === 'mouse' && input.type === 'down').map((input) => input.kind === 'mouse' && input.clicks), [1, 1]);
});

test('jitter under 8 px stays a tap; a long press and a tap outside the picture send nothing', () => {
  const r = rig();
  r.finger(100, 50, 1000, 80, [[103, 52], [105, 54]]);
  assert.deepEqual(r.sent.map((input) => input.kind === 'mouse' && input.type), ['down', 'up']);
  r.sent.length = 0;
  assert.equal(r.finger(100, 50, 3000, 900), true);
  assert.equal(r.finger(700, 500, 5000), true);
  assert.deepEqual(r.sent, []);
});

test('a 120 px upward drag at 1x scrolls down by 240 frame px (wheel at the start point); at 2x it sends nothing', () => {
  const r = rig(1);
  const handled = r.finger(300, 300, 1000, 200, [[300, 290], [300, 240], [300, 180]]);
  assert.equal(handled, true);
  assert.ok(r.sent.every((input) => input.kind === 'wheel' && input.x === 600 && input.y === 600), 'at the start point');
  assert.equal(r.sent.reduce((sum, input) => sum + (input.kind === 'wheel' ? input.deltaY : 0), 0), 240, 'positive deltaY in frame units');
  assert.ok(!r.sent.some((input) => input.kind === 'mouse'), 'a drag is no click');

  const zoomed = rig(2);
  assert.equal(zoomed.finger(300, 300, 1000, 200, [[300, 240], [300, 180]]), false, 'the zoom box pans natively');
  assert.equal(zoomed.sent.length, 0);
  zoomed.finger(100, 50, 3000);
  assert.deepEqual(zoomed.sent.map((input) => input.kind === 'mouse' && input.type), ['down', 'up'], 'at 2x a tap still clicks');
});

test('two fingers are ignored until all are lifted', () => {
  const r = rig();
  r.gestures.start(r.at([[100, 100]], 1000));
  r.gestures.start(r.at([[100, 100], [200, 200]], 1010));
  r.gestures.move(r.at([[100, 40], [200, 140]], 1020));
  assert.equal(r.gestures.end(r.at([[200, 140]], 1030)), false);
  assert.equal(r.gestures.end(r.at([], 1040)), false);
  assert.deepEqual(r.sent, []);
  r.finger(100, 50, 2000);
  assert.equal(r.sent.length, 2, 'the next single tap clicks again');
});

test('the key proxy: text, the deleted sentinel as Backspace, Enter, passed keys; back to the sentinel every time', () => {
  const sent: BrowserInput[] = [];
  const proxy = keyProxy((input) => sent.push(input));
  const key = (name: string) => ({ key: name, code: name, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
  assert.equal(proxy.input(`${KEY_SENTINEL}abc`), KEY_SENTINEL);
  assert.equal(proxy.input(`a${KEY_SENTINEL}`), KEY_SENTINEL, 'text before the sentinel counts too');
  assert.equal(proxy.input(''), KEY_SENTINEL, 'the sentinel was deleted');
  assert.equal(proxy.input('é'), KEY_SENTINEL, 'the sentinel replaced by text: text, no Backspace');
  assert.equal(proxy.input(KEY_SENTINEL), KEY_SENTINEL, 'nothing changed: nothing sent');
  assert.equal(proxy.key(key('Enter'), 'down'), true);
  assert.equal(proxy.key(key('Enter'), 'up'), true, 'swallowed: Enter was already sent down and up');
  assert.equal(proxy.key(key('ArrowLeft'), 'down'), true);
  assert.equal(proxy.key(key('a'), 'down'), false, 'letters arrive as text');
  assert.deepEqual(sent, [
    { kind: 'text', text: 'abc' },
    { kind: 'text', text: 'a' },
    { kind: 'key', type: 'down', key: 'Backspace', code: 'Backspace', keyCode: 8 },
    { kind: 'key', type: 'up', key: 'Backspace', code: 'Backspace', keyCode: 8 },
    { kind: 'text', text: 'é' },
    { kind: 'key', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13 },
    { kind: 'key', type: 'up', key: 'Enter', code: 'Enter', keyCode: 13 },
    { kind: 'key', type: 'down', key: 'ArrowLeft', code: 'ArrowLeft' },
  ]);
  assert.equal(proxy.input(`${KEY_SENTINEL}x\u0007`), KEY_SENTINEL);
  assert.deepEqual(sent.at(-1), { kind: 'text', text: 'x' }, 'control characters are dropped');
});
