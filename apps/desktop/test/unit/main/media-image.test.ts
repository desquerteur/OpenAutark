// B-058 T2: preparing a stored image for a model in the media analyzer (host op media.image) with the
// real page in a fake browser – a large photo scaled down to 1568 px as JPEG, a transparent PNG kept
// PNG, a region cut by fractions, an SVG drawn from an <img> at its own scale, a photo saved as PNG
// that is too large becoming a JPEG, HEIC and decompression bombs refused before a window opens, the
// image/done routes' checks, and the rules (request, region, type sniffing, PNG header, result check).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_LIMITS } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { encodedImage, headerPixels, imageMime, imageRequest, pngSize } from '../../../src/main/media-image.ts';
import { analyzerSetup, jpeg, settle } from './media-analyzer-fakes.ts';
import { pictureFile, png } from './media-task-fakes.ts';
import type { Picture } from './media-task-fakes.ts';

const picture = (patch: Partial<Picture>): Picture => ({ kind: 'image', width: 4000, height: 3000, ...patch });
const rejectsWith = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code && (!message || message.test(error.message)));
const ascii = (text: string) => Array.from(text, (ch) => ch.charCodeAt(0));

test('rules: request and region, the type from the first bytes, PNG and JPEG sizes, the result check', () => {
  const id = 'ab'.repeat(32);
  assert.deepEqual(imageRequest({ fileId: id }), { fileId: id, maxPx: IMAGE_LIMITS.maxPx });
  assert.deepEqual(imageRequest({ fileId: id, mime: 'IMAGE/WEBP', maxPx: 512, region: { x: 0.25, y: 0.5, w: 0.75, h: 0.5 } }), { fileId: id, mime: 'image/webp', maxPx: 512, region: { x: 0.25, y: 0.5, w: 0.75, h: 0.5 } });
  assert.equal(imageRequest({ fileId: id, mime: 'video/mp4' }).mime, undefined);
  assert.throws(() => imageRequest({ fileId: id, region: { x: 0, y: 0, w: 1 } }), /region must be fractions/);
  assert.throws(() => imageRequest({ fileId: id, region: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }), /region/);

  const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0]);
  assert.equal(imageMime(ftyp('heic')), 'image/heic');
  assert.equal(imageMime(ftyp('mif1')), 'image/heic');
  assert.equal(imageMime(ftyp('avif')), 'image/avif');
  assert.equal(imageMime(ftyp('isom')), '', 'an MP4 is no image');
  assert.equal(imageMime(new Uint8Array([0x42, 0x4d, 0, 0])), 'image/bmp');
  assert.equal(imageMime(png(10, 10)), 'image/png');
  assert.equal(imageMime(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))), 'image/svg+xml');
  assert.equal(imageMime(new Uint8Array(ascii('hello'))), '');

  assert.deepEqual(pngSize(png(1568, 900)), { width: 1568, height: 900 });
  assert.equal(pngSize(jpeg(10, 10)), null);
  assert.equal(headerPixels(png(20_000, 20_000)), 400_000_000);
  assert.equal(headerPixels(jpeg(640, 480)), 307_200);
  assert.equal(headerPixels(new Uint8Array(ascii('GIF89a'))), undefined);

  assert.deepEqual(encodedImage(png(1568, 1000), 1568), { mime: 'image/png', width: 1568, height: 1000 });
  assert.deepEqual(encodedImage(jpeg(800, 600), 1568), { mime: 'image/jpeg', width: 800, height: 600 });
  assert.equal(encodedImage(png(1569, 10), 1568), null, 'larger than the edge');
  assert.equal(encodedImage(new Uint8Array(ascii('GIF89a....')), 1568), null, 'only PNG or JPEG');
  assert.equal(encodedImage(png(10, 10, IMAGE_LIMITS.maxBytes), 1568), null, 'over 5 MB');
});

test('a 4000×3000 photo becomes a 1568×1176 JPEG; a transparent PNG stays PNG; maxPx and a region', async () => {
  const s = analyzerSetup();
  try {
    const photo = s.put(pictureFile(picture({})));
    const result = await s.analyzer.image({ fileId: photo, mime: 'image/jpeg' });
    assert.deepEqual([result.mime, result.width, result.height], ['image/jpeg', 1568, 1176]);
    assert.equal(result.data[0], 0xff);
    const page = s.windows[0].pages[0];
    assert.deepEqual(page.bitmaps.map((bitmap) => [bitmap.width, bitmap.height, bitmap.crop?.join(',')]), [[4000, 3000, undefined], [1568, 1176, '0,0,4000,3000']]);
    assert.ok(page.bitmaps.every((bitmap) => bitmap.closed), 'every bitmap is closed');
    assert.deepEqual(page.canvases[0].encoded.map((out) => [out.type, out.quality]), [['image/jpeg', 0.85]]);

    const logo = s.put(pictureFile(picture({ width: 800, height: 400, alpha: true })));
    const kept = await s.analyzer.image({ fileId: logo, mime: 'image/webp' });
    assert.deepEqual([kept.mime, kept.width, kept.height], ['image/png', 800, 400], 'transparency stays: PNG, not scaled up');

    const small = await s.analyzer.image({ fileId: photo, maxPx: 400 });
    assert.deepEqual([small.width, small.height], [400, 300]);
    const corner = await s.analyzer.image({ fileId: photo, region: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
    assert.deepEqual([corner.width, corner.height], [1568, 1176]);
    assert.equal(s.windows[0].pages.at(-1)!.bitmaps[1].crop?.join(','), '2000,1500,2000,1500', 'the bottom right quarter');
    const detail = await s.analyzer.image({ fileId: photo, region: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } });
    assert.deepEqual([detail.width, detail.height], [400, 300], 'a small region is not scaled up');
    const drawn = s.windows[0].pages.at(-1)!.canvases[0].draws[0];
    assert.deepEqual(drawn.place, [400, 300, 400, 300, 0, 0, 400, 300]);
    assert.equal(s.windows.length, 1);
  } finally { s.temp.cleanup(); }
});

test('an SVG is drawn from an <img> at 1024 px; a photo saved as PNG that is too large becomes a JPEG', async () => {
  const s = analyzerSetup();
  try {
    const icon = s.put(pictureFile(picture({ width: 24, height: 12 })));
    const svg = await s.analyzer.image({ fileId: icon, mime: 'image/svg+xml' });
    assert.deepEqual([svg.mime, svg.width, svg.height], ['image/png', 1024, 512], 'vector art at its own scale, PNG');
    const page = s.windows[0].pages[0];
    assert.equal(page.images.length, 1);
    assert.equal(page.images[0].src, 'video', 'the <img> reads the job\'s own route');
    assert.equal(page.bitmaps.length, 0);
    assert.deepEqual(page.canvases[0].draws[0].place, [-0, -0, 1024, 512], 'drawn whole (no source rectangle: Chromium drops the text of an SVG without a size)');
    const right = await s.analyzer.image({ fileId: icon, mime: 'image/svg+xml', region: { x: 0.5, y: 0, w: 0.5, h: 1 } });
    assert.deepEqual([right.width, right.height], [1024, 1024], 'a region of vector art is drawn at 1024 px too');
    assert.deepEqual(s.windows[0].pages.at(-1)!.canvases[0].draws[0].place, [-1024, -0, 2048, 1024], 'the whole picture, shifted so the right half fills the canvas');

    const screenshot = s.put(pictureFile(picture({ width: 3000, height: 2000, photo: true })));
    const big = await s.analyzer.image({ fileId: screenshot, mime: 'image/png' });
    assert.deepEqual([big.mime, big.width, big.height], ['image/jpeg', 1568, 1045]);
    const encoded = s.windows[0].pages.at(-1)!.canvases.flatMap((canvas) => canvas.encoded.map((out) => out.type));
    assert.deepEqual(encoded, ['image/png', 'image/jpeg'], 'PNG first, then a JPEG on white');
  } finally { s.temp.cleanup(); }
});

test('refused: HEIC and decompression bombs before a window opens, an undecodable image, a missing blob', async () => {
  const s = analyzerSetup();
  try {
    const heic = s.put(new Uint8Array([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0, ...ascii('mif1heic')]));
    await rejectsWith(s.analyzer.image({ fileId: heic, mime: 'image/jpeg' }), 'bad_request', /HEIC\/HEIF photos cannot be read here/);
    await rejectsWith(s.analyzer.image({ fileId: s.put(new Uint8Array([1, 2, 3, 4])), mime: 'image/heic' }), 'bad_request', /HEIC/);
    await rejectsWith(s.analyzer.image({ fileId: s.put(png(20_000, 20_000)) }), 'bad_request', /over 100 megapixels/);
    assert.equal(s.windows.length, 0, 'no window for a refused image');
    await rejectsWith(s.analyzer.image({ fileId: s.put(pictureFile(picture({ broken: true }))), mime: 'image/tiff' }), 'bad_request', /format is not supported \(for example TIFF or HEIC\)/);
    await rejectsWith(s.analyzer.image({ fileId: 'ab'.repeat(32) }), 'not_found', /image is not in the file store/);
  } finally { s.temp.cleanup(); }
});

test('routes of an image job: its spec, one result checked against the edge, done without one fails', async () => {
  const s = analyzerSetup();
  const hung = async (mime: string) => {
    s.setMode('hang');
    const loads = s.windows.reduce((sum, window) => sum + window.loads.length, 0);
    const job = s.analyzer.image({ fileId: s.put(pictureFile(picture({ width: 100 + loads }))), mime, maxPx: 800, region: { x: 0, y: 0, w: 0.5, h: 1 } });
    job.catch(() => undefined);
    await settle(() => s.windows.reduce((sum, window) => sum + window.loads.length, 0) === loads + 1);
    const n = /job\/(\d+)\//.exec(s.windows.at(-1)!.loads.at(-1)!)![1];
    return { job, at: (route: string, init?: RequestInit) => s.analyzer.serve(new Request(`wf-file://media-analyzer/job/${n}/${route}`, init)) };
  };
  const post = (bytes: Uint8Array<ArrayBuffer>): RequestInit => ({ method: 'POST', body: bytes, headers: { 'Content-Type': 'image/png' } });
  try {
    const first = await hung('image/gif');
    const spec = await (await first.at('spec')).json() as Record<string, unknown>;
    assert.deepEqual(spec, { task: 'image', maxPx: 800, region: { x: 0, y: 0, w: 0.5, h: 1 }, svg: false, svgPx: 1024, lossless: true, opaque: false, quality: 0.85, maxBytes: IMAGE_LIMITS.maxBytes, inputBytes: 100 * 1024 * 1024 },
      'nothing sniffed from these bytes: the given type (GIF, line art) counts');
    assert.equal((await first.at('pcm?at=0', post(png(1, 1)))).status, 404);
    assert.equal((await first.at('image', post(png(800, 400)))).status, 204);
    assert.equal((await first.at('image', post(png(800, 400)))).status, 409, 'one result');
    await first.at('done', { method: 'POST', body: '{}' });
    assert.deepEqual(await first.job.then((image) => [image.mime, image.width, image.height]), ['image/png', 800, 400]);

    const wide = await hung('image/png');
    assert.equal((await wide.at('image', post(png(801, 10)))).status, 400, 'over the edge asked for');
    await rejectsWith(wide.job, 'bad_request', /could not be converted/);
    const none = await hung('image/png');
    await none.at('done', { method: 'POST', body: '{}' });
    await rejectsWith(none.job, 'bad_request', /could not be converted/);
    const large = await hung('image/png');
    await large.at('fail', { method: 'POST', body: JSON.stringify({ reason: 'too-large' }) });
    await rejectsWith(large.job, 'bad_request', /too large to prepare/);
  } finally { s.temp.cleanup(); }
});
