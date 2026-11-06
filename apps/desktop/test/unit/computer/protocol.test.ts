// Pure parts of computer use: helper wire protocol, key combos, coordinate math, PNG downscale,
// UI tree rendering and refs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_WINDOW, appHit, asciiJson, classify, encodeRequest, errorCodeOf, HELPER_PROTOCOL, LineDecoder, HUMAN_ACTIVE } from '../../../src/runtime/computer/protocol.ts';
import { forbiddenCombo, parseCombo } from '../../../src/runtime/computer/keys.ts';
import { fitWithin, toImage, toScreen, validPoint } from '../../../src/runtime/computer/geometry.ts';
import { decodePng, encodePng, pngSize, shrinkPng } from '../../../src/runtime/computer/png.ts';
import { RefTable, renderTree, parseNodes, type UiNode } from '../../../src/runtime/computer/tree.ts';

test('helper requests are pure-ASCII JSON lines that round-trip unicode text', () => {
  const line = encodeRequest({ id: 7, op: 'type', args: { text: 'Grüße 👋 "quoted"\n' } });
  assert.ok(line.endsWith('\n'));
  assert.match(line, /^[\x20-\x7e]*\n$/);
  assert.deepEqual(JSON.parse(line), { id: 7, op: 'type', args: { text: 'Grüße 👋 "quoted"\n' } });
  assert.equal(asciiJson('é'), '"\\u00e9"');
});

test('line decoder handles split chunks, CRLF, ready lines, errors and noise', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"ready":true,"protocol":1,"pid":42,"dpi'), []);
  const first = decoder.push('Aware":true}\r\n{"id":1,"ok":true,"result":{"x":0}}\nWARNING: something\n');
  assert.equal(first.length, 3);
  assert.deepEqual(first[0], { kind: 'ready', ready: { ready: true, protocol: 1, pid: 42, dpiAware: true } });
  assert.deepEqual(first[1], { kind: 'response', response: { id: 1, ok: true, result: { x: 0 } } });
  assert.equal(first[2].kind, 'noise');
  const failed = classify('{"id":2,"ok":false,"error":{"code":"conflict","message":"The element changed"}}');
  assert.deepEqual(failed, { kind: 'response', response: { id: 2, ok: false, error: { code: 'conflict', message: 'The element changed' } } });
  assert.equal(classify('{"id":"x"}').kind, 'noise');
});

test('protocol 4 (B-044 app_window, B-055 path): an app_window refusal keeps only the well-formed parts of what it would hit', () => {
  assert.equal(HELPER_PROTOCOL, 4);
  assert.equal(errorCodeOf(APP_WINDOW), 'forbidden');
  assert.equal(errorCodeOf(HUMAN_ACTIVE), 'conflict', 'the person moved the mouse mid-path: a conflict, nothing pressed');
  const hit = classify('{"id":3,"ok":false,"error":{"code":"app_window","message":"m","app":{"window":66,"rect":[1,2,3,4],"keyboard":true,"point":{"x":"1"}}}}');
  assert.deepEqual(hit, { kind: 'response', response: { id: 3, ok: false, error: { code: 'app_window', message: 'm', app: { window: 66, rect: [1, 2, 3, 4], keyboard: true } } } });
  assert.deepEqual(appHit({ window: 0, rect: [1, 2, 3], point: { x: 5, y: 6 } }), { point: { x: 5, y: 6 } }, 'window 0 and a short rectangle are dropped');
  assert.deepEqual(appHit(null), {}, 'still a Workforce window, just nothing more known');
  const other = classify('{"id":4,"ok":false,"error":{"code":"forbidden","message":"m","app":{"window":66}}}');
  assert.deepEqual(other, { kind: 'response', response: { id: 4, ok: false, error: { code: 'forbidden', message: 'm' } } }, 'app travels with app_window only');
});

test('key combos map to virtual keys with modifiers first; dangerous ones are refused', () => {
  assert.deepEqual(parseCombo('ctrl+shift+s'), [0x11, 0x10, 0x53]);
  assert.deepEqual(parseCombo('S+ctrl'), [0x11, 0x53]);
  assert.deepEqual(parseCombo('enter'), [0x0d]);
  assert.deepEqual(parseCombo('alt+F4'), [0x12, 0x73]);
  assert.deepEqual(parseCombo('ctrl++'), [0x11, 0xbb]);
  assert.throws(() => parseCombo('ctrl+banana'), /Unknown key "banana"/);
  assert.throws(() => parseCombo('a+b'), /one main key/);
  assert.match(forbiddenCombo(parseCombo('ctrl+alt+delete')) ?? '', /secure screen/);
  assert.match(forbiddenCombo(parseCombo('win+l')) ?? '', /lock/);
  assert.equal(forbiddenCombo(parseCombo('ctrl+c')), undefined);
});

test('coordinates: 0 is valid, non-finite values are rejected, screenshot pixels map to the screen', () => {
  assert.deepEqual(validPoint(0, 0), { x: 0, y: 0 }); // the UI-TARS "if (x && y)" bug class
  assert.deepEqual(validPoint(-1920, 10.6), { x: -1920, y: 11 });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '12', undefined, null]) {
    assert.throws(() => validPoint(bad, 1), /finite number/);
  }
  const fit = fitWithin(3840, 2160, 1600);
  assert.deepEqual(fit, { width: 1600, height: 900, scale: 2.4 });
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600, scale: 1 });
  const shot = { width: 1600, height: 900, origin: { x: -3840, y: 0 }, scale: 2.4 };
  assert.deepEqual(toScreen({ x: 0, y: 0 }, shot), { x: -3839, y: 1 });
  assert.deepEqual(toScreen({ x: 800, y: 450 }, shot), { x: -3840 + 1921, y: 1081 });
  assert.deepEqual(toImage(toScreen({ x: 333, y: 222 }, shot), shot), { x: 333, y: 222 });
  assert.throws(() => toScreen({ x: 1600, y: 10 }, shot), /outside the last screenshot/);
});

function solid(width: number, height: number, rgb: [number, number, number], alpha?: number) {
  const channels = alpha === undefined ? 3 : 4;
  const pixels = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    pixels.set(alpha === undefined ? rgb : [...rgb, alpha], i * channels);
  }
  return { width, height, channels: channels as 3 | 4, pixels };
}

test('PNG encode/decode round-trips and screenshots shrink to the long-edge limit', () => {
  const image = solid(5, 3, [10, 200, 30]);
  image.pixels.set([255, 0, 0], 0); // one red pixel exercises the Sub filter
  const png = encodePng(image);
  assert.deepEqual(pngSize(png), { width: 5, height: 3 });
  const decoded = decodePng(png)!;
  assert.deepEqual([...decoded.pixels], [...image.pixels]);

  const big = solid(400, 200, [0, 0, 0]);
  for (let x = 0; x < 200; x++) for (let y = 0; y < 200; y++) big.pixels.set([255, 255, 255], (y * 400 + x) * 3); // left half white
  const small = shrinkPng(encodePng(big), 100);
  assert.equal(small.width, 100);
  assert.equal(small.height, 50);
  assert.equal(small.scale, 4);
  const pixels = decodePng(small.data)!.pixels;
  assert.deepEqual([...pixels.subarray(0, 3)], [255, 255, 255]);
  assert.deepEqual([...pixels.subarray(99 * 3, 100 * 3)], [0, 0, 0]);

  const transparent = shrinkPng(encodePng(solid(20, 10, [0, 0, 0], 0)), 10);
  assert.deepEqual([...decodePng(transparent.data)!.pixels.subarray(0, 3)], [255, 255, 255]); // composited on white

  const notPng = new Uint8Array([1, 2, 3]);
  assert.equal(shrinkPng(notPng, 100).data, notPng);
});

test('UI trees collapse unnamed wrappers and keep refs stable per element', () => {
  const nodes: UiNode[] = parseNodes([
    { d: 0, p: -1, rid: '42.1', role: 'window', name: 'Editor', rect: [0, 0, 800, 600], patterns: ['window'] },
    { d: 1, p: 0, rid: '42.2', role: 'pane' },
    { d: 2, p: 1, rid: '42.3', role: 'button', name: 'Export', rect: [700, 10, 80, 30], patterns: ['invoke'] },
    { d: 2, p: 1, rid: '42.4', role: 'edit', name: 'Title', value: 'Draft "1"', patterns: ['value'], focused: true },
    { d: 3, p: 3, rid: '42.5', role: 'checkbox', name: 'Loop', toggle: 'on', patterns: ['toggle'], disabled: true },
    { bogus: true },
  ]);
  assert.equal(nodes.length, 5);
  const refs = new RefTable();
  const first = renderTree(nodes, 1234, refs);
  assert.equal(first.count, 4); // the unnamed pane is collapsed
  assert.equal(first.text, [
    '- window "Editor" [ref=e1] (window) @400,300',
    '  - button "Export" [ref=e2] (invoke) @740,25',
    '  - edit "Title" [ref=e3] = "Draft \\"1\\"" [focused]',
    '    - checkbox "Loop" [ref=e4] [on] [disabled] (toggle)',
  ].join('\n'));
  const again = renderTree(nodes, 1234, refs);
  assert.equal(again.text, first.text); // same elements → same refs
  assert.deepEqual(refs.get('e2'), { hwnd: 1234, rid: '42.3', name: 'Export', role: 'button', rect: [700, 10, 80, 30], patterns: ['invoke'] }); // patterns: quiet-actions.ts
  assert.equal(refs.get('[ref=e2]')?.rid, '42.3');
  assert.equal(renderTree(nodes.slice(0, 1), 999, refs).text.includes('[ref=e5]'), true); // other window, new ref
});
