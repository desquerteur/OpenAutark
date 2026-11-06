// B-058 G10 (media/vision-image.ts): images bound for a model. PNG/JPEG/WebP/GIF within 3.75 MB and 1568 px go as
// they are; others get a JPEG/PNG copy through the host's media analyzer (a fake Host.media.image here), cached by
// blob id in <temp>/vision; headless, a PNG is shrunk or cut here. Without a copy, an image within the hard limit
// (2000 px) still goes, anything else becomes a line naming media.view. Unknown files go as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { NormalizedImage } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { decodePng, pngSize } from '../../../src/runtime/computer/png.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import type { HostMedia } from '../../../src/runtime/host.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { fitsAsIs, pngHere, VISION_LIMITS, visionImage, visionInputs, visionMime, type VisionServices } from '../../../src/runtime/media/vision-image.ts';
import { harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { jpegLateSof } from './fixtures.ts';
import { halves, SVG } from './vision-image-fixture.ts';

const COPY: NormalizedImage = { data: new Uint8Array([0xff, 0xd8, 0xff, 9]), mime: 'image/jpeg', width: 40, height: 20 };

function setup(host?: { image?: HostMedia['image'] }) {
  const h = harness();
  const temp = tempDir();
  const log = new MemoryLogger();
  const files = new Blobs({ db: h.db, blobs: path.join(temp.dir, 'blobs'), clock: h.clock, log });
  const asked: Array<Parameters<NonNullable<HostMedia['image']>>[0]> = [];
  const media = host ? { keyframes: async () => { throw new Error('unused'); }, ...(host.image ? { image: (input: Parameters<NonNullable<HostMedia['image']>>[0]) => { asked.push(input); return host.image!(input); } } : {}) } : undefined;
  const s = { files, log, paths: { temp: path.join(temp.dir, 'tmp') }, host: { ...(media ? { media } : {}) } } as unknown as VisionServices;
  const stored = async (bytes: Uint8Array, name: string, mime?: string) => {
    const ref = await files.put(bytes, name, mime);
    return { ref, path: files.path(ref.id), mime: ref.mime };
  };
  return { s, temp, asked, stored, vision: path.join(temp.dir, 'tmp', 'vision') };
}

test('fitsAsIs: the four engine types within 3.75 MB and the edge go; unknown sizes count as fitting', () => {
  assert.equal(fitsAsIs({ mime: 'image/png', bytes: 1000, width: 1568, height: 900 }), true);
  assert.equal(fitsAsIs({ mime: 'image/jpg', bytes: 1000, width: 800, height: 600 }), true, 'image/jpg reads as image/jpeg');
  assert.equal(fitsAsIs({ mime: 'image/webp', bytes: 1000 }), true);
  assert.equal(fitsAsIs({ mime: 'image/png', bytes: 1000, width: 1569, height: 10 }), false, 'over the edge');
  assert.equal(fitsAsIs({ mime: 'image/png', bytes: 1000, width: 1900, height: 10 }, VISION_LIMITS.fallbackPx), true, 'the hard limit when no copy can be made');
  assert.equal(fitsAsIs({ mime: 'image/gif', bytes: VISION_LIMITS.passBytes + 1, width: 10, height: 10 }), false, 'over 3.75 MB');
  for (const mime of ['image/svg+xml', 'image/bmp', 'image/heic', 'image/tiff', 'image/avif']) assert.equal(fitsAsIs({ mime, bytes: 10, width: 10, height: 10 }), false, mime);
  assert.equal(visionMime('IMAGE/PJPEG; q=1'), 'image/jpeg');
});

test('visionInputs: a fitting image goes as it is; an unknown file as before', async () => {
  const t = setup();
  try {
    const small = await t.stored(halves(64, 32), 'small.png');
    const items = await visionInputs(t.s, [{ path: small.path, mime: 'image/png' }, { path: 'blobs/aa', mime: 'image/png' }]);
    assert.deepEqual(items, [{ type: 'image', path: small.path, mime: 'image/png' }, { type: 'image', path: 'blobs/aa', mime: 'image/png' }]);
    assert.equal(existsSync(t.vision), false, 'nothing converted');
  } finally { t.temp.cleanup(); }
});

test('visionInputs: an SVG gets the analyzer\'s copy, cached by blob id; headless it becomes a media.view line', async () => {
  const t = setup({ image: async () => COPY });
  try {
    const svg = await t.stored(SVG, 'logo.svg', 'image/svg+xml');
    assert.equal(svg.mime, 'image/svg+xml');
    const first = await visionInputs(t.s, [{ path: svg.path, mime: svg.mime }]);
    const copy = path.join(t.vision, `${svg.ref.id}.jpg`);
    assert.deepEqual(first, [{ type: 'image', path: copy, mime: 'image/jpeg' }]);
    assert.deepEqual(t.asked, [{ fileId: svg.ref.id, mime: 'image/svg+xml', maxPx: 1568 }]);
    assert.deepEqual(await visionInputs(t.s, [{ path: svg.path, mime: svg.mime }]), first, 'the second turn reads the cached copy');
    assert.equal(t.asked.length, 1);
  } finally { t.temp.cleanup(); }

  const headless = setup();
  try {
    const svg = await headless.stored(SVG, 'logo.svg', 'image/svg+xml');
    const [line] = await visionInputs(headless.s, [{ path: svg.path, mime: svg.mime }]);
    assert.equal(line.type, 'text');
    assert.match((line as { text: string }).text, /^\(Image "logo\.svg" is not attached for me to see: converting this image needs the desktop app .*media\.view/);
  } finally { headless.temp.cleanup(); }
});

test('visionInputs: headless, a big PNG is shrunk here to 1568 px (a PNG copy)', async () => {
  const t = setup();
  try {
    const big = await t.stored(halves(2000, 1000), 'wide.png');
    const [item] = await visionInputs(t.s, [{ path: big.path, mime: 'image/png' }]);
    assert.equal(item.type, 'image');
    const { path: copy, mime } = item as { path: string; mime: string };
    assert.equal(mime, 'image/png');
    assert.equal(copy, path.join(t.vision, `${big.ref.id}.png`));
    assert.deepEqual(pngSize(new Uint8Array(readFileSync(copy))), { width: 1568, height: 784 });
    assert.deepEqual(readdirSync(t.vision), [`${big.ref.id}.png`], 'no part file left');
  } finally { t.temp.cleanup(); }
});

test('visionInputs: when the analyzer fails, a photo within 2000 px still goes as it is, a bigger one becomes a line', async () => {
  const t = setup({ image: async () => { throw new WorkforceError('unavailable', 'The media analyzer is busy.'); } });
  try {
    const mid = await t.stored(jpegLateSof(1800, 1200), 'mid.jpg', 'image/jpeg');
    const huge = await t.stored(jpegLateSof(4000, 3000), 'huge.jpg', 'image/jpeg');
    const items = await visionInputs(t.s, [{ path: mid.path, mime: 'image/jpeg' }, { path: huge.path, mime: 'image/jpeg' }]);
    assert.deepEqual(items[0], { type: 'image', path: mid.path, mime: 'image/jpeg' }, 'its size is read from the header behind the APP segments');
    assert.deepEqual(items[1], { type: 'text', text: '(Image "huge.jpg" is not attached for me to see: The media analyzer is busy. media.view with its stored path tries again.)' });
    assert.equal(t.asked.length, 2, 'both were tried');
  } finally { t.temp.cleanup(); }
});

test('visionInputs: an animated GIF gets its first frame as a copy (OpenAI reads still GIFs); without a copy it goes as it is', async () => {
  const gif = (animated: boolean) => new Uint8Array(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([40, 0, 20, 0, 0x80, 0, 0]), Buffer.alloc(6), animated ? Buffer.from('!\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00', 'latin1') : Buffer.alloc(0), Buffer.from(';')]));
  const t = setup({ image: async () => COPY });
  try {
    const still = await t.stored(gif(false), 'still.gif');
    const moving = await t.stored(gif(true), 'moving.gif');
    const items = await visionInputs(t.s, [{ path: still.path, mime: 'image/gif' }, { path: moving.path, mime: 'image/gif' }]);
    assert.deepEqual(items, [{ type: 'image', path: still.path, mime: 'image/gif' }, { type: 'image', path: path.join(t.vision, `${moving.ref.id}.jpg`), mime: 'image/jpeg' }]);
    assert.deepEqual(t.asked.map((input) => input.fileId), [moving.ref.id]);
  } finally { t.temp.cleanup(); }
  const headless = setup();
  try {
    const moving = await headless.stored(gif(true), 'moving.gif');
    assert.deepEqual(await visionInputs(headless.s, [{ path: moving.path, mime: 'image/gif' }]), [{ type: 'image', path: moving.path, mime: 'image/gif' }]);
  } finally { headless.temp.cleanup(); }
});

test('pngHere: cuts a region and keeps it within 1568 px; refuses PNGs it cannot read', () => {
  const cut = pngHere(halves(200, 100), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.ok(cut);
  assert.deepEqual([cut.width, cut.height, cut.mime], [100, 100, 'image/png']);
  const pixels = decodePng(cut.data)!.pixels;
  assert.ok(pixels.every((value, index) => value === [0, 0, 255][index % 3]), 'only the blue half');
  assert.equal(pngHere(new Uint8Array([1, 2, 3])), undefined);
});

test('visionImage: a region goes to the analyzer; headless a PNG region is cut here and a JPEG region falls back to the whole image', async () => {
  const t = setup({ image: async (input) => ({ ...COPY, width: input.region ? 20 : 40 }) });
  try {
    const photo = await t.stored(jpegLateSof(800, 600), 'photo.jpg', 'image/jpeg');
    const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const shown = await visionImage(t.s, { fileId: photo.ref.id, mime: 'image/jpeg', region });
    assert.deepEqual([shown.mime, shown.width, shown.converted, shown.cut], ['image/jpeg', 20, true, true]);
    assert.deepEqual(t.asked, [{ fileId: photo.ref.id, mime: 'image/jpeg', maxPx: 1568, region }]);
    assert.equal(existsSync(t.vision), false, 'a region is not cached');
    const whole = await visionImage(t.s, { fileId: photo.ref.id, mime: 'image/jpeg' });
    assert.deepEqual([whole.converted, whole.cut, whole.data.length], [false, false, photo.ref.size], 'a fitting whole image goes as it is');
  } finally { t.temp.cleanup(); }

  const headless = setup();
  try {
    const png = await headless.stored(halves(200, 100), 'halves.png');
    const right = await visionImage(headless.s, { fileId: png.ref.id, mime: 'image/png', region: { x: 0.5, y: 0, w: 0.5, h: 1 } });
    assert.deepEqual([right.width, right.height, right.cut], [100, 100, true]);
    const jpeg = await headless.stored(jpegLateSof(800, 600), 'photo.jpg', 'image/jpeg');
    const fallback = await visionImage(headless.s, { fileId: jpeg.ref.id, mime: 'image/jpeg', region: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    assert.deepEqual([fallback.cut, fallback.converted, fallback.width], [false, false, 800]);
    const svg = await headless.stored(SVG, 'logo.svg', 'image/svg+xml');
    await assert.rejects(visionImage(headless.s, { fileId: svg.ref.id, mime: 'image/svg+xml' }), /This image cannot be shown: converting this image needs the desktop app/);
  } finally { headless.temp.cleanup(); }
});
