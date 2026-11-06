// B-055 – the feedback screenshot shows what the person sees (main/capture.ts): the page's own
// capture leaves the side browser's native view (a WebContentsView) out, so windowDataUrl copies
// every visible view into the page's bitmap at its bounds, scaled from DIP to the shot's pixels;
// hidden, destroyed and the page's own contents are skipped; without views (or without bitmap
// support) the page alone is returned.
// Owns: these assertions only. Never: Electron, a real window or real images.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blit, Capture, windowLayers } from '../../../src/main/capture.ts';
import type { CaptureDeps, ImageLike, LayeredWindow } from '../../../src/main/capture.ts';

/** A fake image: `width`×`height` pixels all of value `fill` (4 bytes each). */
function image(width: number, height: number, fill: number): ImageLike & { bitmap: Uint8Array } {
  const bitmap = new Uint8Array(width * height * 4).fill(fill);
  return {
    bitmap,
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    toPNG: () => bitmap, toJPEG: () => bitmap,
    toDataURL: () => `data:image/png;base64,${width}x${height}:${fill}`,
    toBitmap: () => new Uint8Array(bitmap),
  };
}

const pixel = (data: Uint8Array, width: number, x: number, y: number) => data[(y * width + x) * 4];

test('blit copies a layer at its place, clipped to the base', () => {
  const base = { data: new Uint8Array(4 * 3 * 4), width: 4, height: 3 };
  blit(base, { data: new Uint8Array(2 * 2 * 4).fill(9), width: 2, height: 2 }, 3, 2); // only (3,2) lies inside
  assert.equal(pixel(base.data, 4, 3, 2), 9);
  assert.equal(base.data.filter((value) => value === 9).length, 4, 'one pixel (4 bytes) copied');
  blit(base, { data: new Uint8Array(4).fill(7), width: 1, height: 1 }, -1, 0); // fully outside
  assert.equal(base.data.filter((value) => value === 7).length, 0);
  blit(base, { data: new Uint8Array(3), width: 1, height: 1 }, 0, 0); // a short buffer is never read past
  assert.equal(pixel(base.data, 4, 0, 0), 0);
});

test('windowLayers: the visible web views besides the page itself, in stacking order', () => {
  const view = (id: number, visible: boolean, x = 0) => ({
    getVisible: () => visible, getBounds: () => ({ x, y: 10, width: 20, height: 10 }),
    webContents: { id, isDestroyed: () => false, capturePage: async () => image(1, 1, id) },
  });
  const window: LayeredWindow = {
    isDestroyed: () => false, getContentBounds: () => ({ x: 100, y: 100, width: 640, height: 480 }), webContents: { id: 1 },
    contentView: { children: [view(1, true), view(2, false), { getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }) }, view(3, true, 30)] },
  };
  const layers = windowLayers(window);
  assert.equal(layers?.width, 640);
  assert.deepEqual(layers?.views.map((entry) => entry.bounds.x), [30], 'the page, a hidden tab and a plain view are skipped');
  assert.equal(windowLayers(null), null);
  assert.equal(windowLayers({ ...window, isDestroyed: () => true }), null);
});

function capture(page: ImageLike, extra: Partial<CaptureDeps>): Capture {
  return new Capture({
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1 }) },
    getSources: async () => [],
    appContents: () => ({ capturePage: async () => page }),
    ...extra,
  });
}

test('the window shot composites the side browser\'s view at its bounds, scaled to the shot\'s pixels', async () => {
  const page = image(200, 100, 1); // a 100×50 DIP window at 2× scale
  const side = image(40, 20, 5); // a 20×10 DIP view at 2×
  let made: { data: Uint8Array; size: { width: number; height: number } } | null = null;
  const url = await capture(page, {
    appLayers: () => ({ width: 100, views: [{ bounds: { x: 60, y: 30, width: 20, height: 10 }, capturePage: async () => side }] }),
    fromBitmap: (data, size) => { made = { data, size }; return { ...image(size.width, size.height, 0), toDataURL: () => 'data:image/png;base64,COMPOSITED' }; },
  }).windowDataUrl();
  assert.equal(url, 'data:image/png;base64,COMPOSITED');
  assert.ok(made);
  const shot = made as { data: Uint8Array; size: { width: number; height: number } };
  assert.deepEqual(shot.size, { width: 200, height: 100 });
  assert.equal(pixel(shot.data, 200, 120, 60), 5, 'the view starts at 60×2, 30×2');
  assert.equal(pixel(shot.data, 200, 159, 79), 5, 'and ends at its far corner');
  assert.equal(pixel(shot.data, 200, 119, 60), 1, 'the page left of it stays');
  assert.equal(pixel(shot.data, 200, 160, 80), 1, 'and below/right of it');
  assert.equal(page.bitmap[0], 1, 'the page image itself is not changed');
});

test('without views, bitmap support or on a failing view the page alone is the shot', async () => {
  const page = image(10, 10, 1);
  assert.equal(await capture(page, {}).windowDataUrl(), page.toDataURL());
  assert.equal(await capture(page, { appLayers: () => ({ width: 10, views: [] }), fromBitmap: () => image(1, 1, 0) }).windowDataUrl(), page.toDataURL());
  const failing = capture(page, {
    appLayers: () => ({ width: 10, views: [{ bounds: { x: 0, y: 0, width: 5, height: 5 }, capturePage: async () => { throw new Error('gone'); } }] }),
    fromBitmap: () => image(1, 1, 0),
  });
  assert.equal(await failing.windowDataUrl(), page.toDataURL(), 'a view that cannot be captured never loses the shot');
  const empty = capture(page, { appLayers: () => ({ width: 10, views: [{ bounds: { x: 0, y: 0, width: 5, height: 5 }, capturePage: async () => image(0, 0, 0) }] }), fromBitmap: () => image(1, 1, 0) });
  assert.equal(await empty.windowDataUrl(), page.toDataURL());
});

test('the views are read and their capture started at the call, not after the page image arrived', async () => {
  const order: string[] = [];
  let release!: (value: ImageLike) => void;
  const page = image(10, 10, 1);
  const shot = new Capture({
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1 }) },
    getSources: async () => [],
    appContents: () => ({ capturePage: () => { order.push('page'); return new Promise<ImageLike>((resolve) => { release = resolve; }); } }),
    appLayers: () => { order.push('layers'); return { width: 10, views: [{ bounds: { x: 0, y: 0, width: 2, height: 2 }, capturePage: async () => { order.push('view'); return image(2, 2, 5); } }] }; },
    fromBitmap: (data, size) => ({ ...image(size.width, size.height, 0), toDataURL: () => `composited:${data[0]}` }),
  }).windowDataUrl();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['layers', 'view', 'page'], 'a menu opening meanwhile cannot hide the view from the shot');
  release(page);
  assert.equal(await shot, 'composited:5');
});
