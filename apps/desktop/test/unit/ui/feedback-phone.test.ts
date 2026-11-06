// SM6: feedback from the phone (no desktop bridge). The panel offers "Add
// screenshot" there: a picked image (gallery or camera) is checked, scaled down and re-encoded
// (no photo metadata) before the panel shows it for marking and uploads it; Send opens the issue
// once in a new tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCaptureWindow, captureWindow, dataUrlToBlob, fitWithin, PICK_MAX_BYTES, PICK_MAX_SIDE, pickedImage, pickedMime, pickProblem, screenshotName,
} from '../../../src/ui/feedback/bridge.ts';

test('without a bridge the window cannot be captured, so the panel offers a picker', async () => {
  assert.equal(canCaptureWindow(), false);
  assert.equal(await captureWindow(), null);
});

test('a picked file must be an image within 30 MB; images are scaled down, never up', () => {
  assert.equal(pickProblem({ type: 'image/jpeg', size: 4_000_000 }), null);
  assert.equal(pickProblem({ type: 'image/heic', size: 2_000_000 }), null);
  assert.equal(pickProblem({ type: '', size: 10 }), null, 'an unknown type is left to decoding');
  assert.match(pickProblem({ type: 'application/pdf', size: 10 }) ?? '', /Choose an image/);
  assert.match(pickProblem({ type: 'image/png', size: PICK_MAX_BYTES + 1 }) ?? '', /larger than 30 MB/);
  assert.deepEqual(fitWithin(4032, 3024), { width: PICK_MAX_SIDE, height: 1200 });
  assert.deepEqual(fitWithin(1080, 2400), { width: 720, height: PICK_MAX_SIDE });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1 });
  assert.equal(pickedMime('image/jpeg'), 'image/jpeg');
  assert.equal(pickedMime('image/HEIC'), 'image/jpeg');
  assert.equal(pickedMime('image/png'), 'image/png');
  assert.equal(pickedMime('image/webp'), 'image/png');
  assert.equal(screenshotName('data:image/jpeg;base64,AAAA'), 'screenshot.jpg');
  assert.equal(screenshotName('data:image/png;base64,AAAA'), 'screenshot.png');
});

/** Minimal browser image pipeline: decoded size per object URL, canvases record what they export. */
function fakeImagePipeline(sizes: Record<string, { width: number; height: number } | 'broken'>) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { Image: globals.Image, document: globals.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const revoked: string[] = [];
  const canvases: Array<{ width: number; height: number; drawn?: [number, number]; exported?: [string, number | undefined] }> = [];
  let next = 0;
  const names = new Map<string, string>();
  URL.createObjectURL = ((blob: Blob & { name?: string }) => { const url = `blob:fake/${++next}`; names.set(url, blob.name ?? ''); return url; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  globals.Image = class {
    src = '';
    naturalWidth = 0;
    naturalHeight = 0;
    async decode() {
      const size = sizes[names.get(this.src) ?? ''];
      if (!size || size === 'broken') throw new Error('EncodingError');
      this.naturalWidth = size.width;
      this.naturalHeight = size.height;
    }
  };
  globals.document = {
    createElement: () => {
      const canvas: (typeof canvases)[number] & Record<string, unknown> = { width: 0, height: 0 };
      canvas.getContext = () => ({ drawImage: (_image: unknown, _x: number, _y: number, width: number, height: number) => { canvas.drawn = [width, height]; } });
      canvas.toDataURL = (type: string, quality?: number) => { canvas.exported = [type, quality]; return `data:${type};base64,QUJD`; };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    revoked, canvases,
    restore() { globals.Image = saved.Image; globals.document = saved.document; URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; },
  };
}

test('pickedImage scales a camera photo or phone screenshot and re-encodes it (no metadata), then frees it', async () => {
  const fake = fakeImagePipeline({ 'photo.jpg': { width: 4032, height: 3024 }, 'shot.png': { width: 1080, height: 2400 }, 'broken.png': 'broken' });
  try {
    const photo = await pickedImage(new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
    assert.equal(photo, 'data:image/jpeg;base64,QUJD');
    const { width, height, drawn, exported } = fake.canvases[0];
    assert.deepEqual({ width, height, drawn, exported }, { width: 1600, height: 1200, drawn: [1600, 1200], exported: ['image/jpeg', 0.9] });
    const shot = await pickedImage(new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }));
    assert.equal(shot, 'data:image/png;base64,QUJD');
    assert.deepEqual([fake.canvases[1].width, fake.canvases[1].height], [720, 1600]);
    await assert.rejects(pickedImage(new File([new Uint8Array([1])], 'broken.png', { type: 'image/png' })), /could not be opened/);
    assert.deepEqual(fake.revoked, ['blob:fake/1', 'blob:fake/2', 'blob:fake/3'], 'every object URL is freed, also after a failure');
    await assert.rejects(pickedImage(new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })), /Choose an image/);
    assert.equal(fake.revoked.length, 3, 'a non-image is refused before anything is decoded');
    // What the panel uploads: the re-encoded bytes with a matching name.
    const blob = dataUrlToBlob(photo);
    assert.equal(blob.type, 'image/jpeg');
    assert.equal(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())), 'ABC');
    assert.equal(screenshotName(photo), 'screenshot.jpg');
  } finally {
    fake.restore();
  }
});
