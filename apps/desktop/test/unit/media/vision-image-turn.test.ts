// B-058 G10 review fixes (media/vision-image.ts, media/vision-cache.ts): a turn waits a bounded time for its images'
// copies (a copy finished later is still cached); a copy over 3.75 MB is made once more, smaller; two turns storing the
// same copy keep one file; the cache keeps its newest copies and drops part files a crash left; an image whose header
// cannot be read goes as before instead of failing the turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NormalizedImage } from '../../../src/shared/api/host-bridge.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import type { HostMedia } from '../../../src/runtime/host.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { VISION_CACHE } from '../../../src/runtime/media/vision-cache.ts';
import { smallerEdge, VISION_LIMITS, visionInputs, type VisionServices } from '../../../src/runtime/media/vision-image.ts';
import { harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { jpegLateSof } from './fixtures.ts';
import { SVG } from './vision-image-fixture.ts';

type Ask = Parameters<NonNullable<HostMedia['image']>>[0];
const COPY: NormalizedImage = { data: new Uint8Array([0xff, 0xd8, 0xff, 9]), mime: 'image/jpeg', width: 40, height: 20 };

function setup(image: (input: Ask) => Promise<NormalizedImage>) {
  const h = harness();
  const temp = tempDir();
  const log = new MemoryLogger();
  const files = new Blobs({ db: h.db, blobs: path.join(temp.dir, 'blobs'), clock: h.clock, log });
  const asked: Ask[] = [];
  const media = { keyframes: async () => { throw new Error('unused'); }, image: (input: Ask) => { asked.push(input); return image(input); } };
  const s = { files, log, paths: { temp: path.join(temp.dir, 'tmp') }, host: { media } } as unknown as VisionServices;
  const stored = async (bytes: Uint8Array, name: string, mime?: string) => {
    const ref = await files.put(bytes, name, mime);
    return { ref, path: files.path(ref.id), mime: ref.mime };
  };
  return { s, files, temp, asked, stored, vision: path.join(temp.dir, 'tmp', 'vision') };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('visionInputs: a busy analyzer holds a turn at most its budget; the copy made later is still cached', async () => {
  let answer: (image: NormalizedImage) => void = () => undefined;
  const t = setup(() => new Promise<NormalizedImage>((resolve) => { answer = resolve; }));
  try {
    const mid = await t.stored(jpegLateSof(1800, 1200), 'mid.jpg', 'image/jpeg');
    const huge = await t.stored(jpegLateSof(4000, 3000), 'huge.jpg', 'image/jpeg');
    // The analyzer never answers within the budget: without it the turn would wait for good.
    const items = await visionInputs(t.s, [{ path: mid.path, mime: 'image/jpeg' }, { path: huge.path, mime: 'image/jpeg' }], 40);
    assert.deepEqual(items[0], { type: 'image', path: mid.path, mime: 'image/jpeg' }, 'within 2000 px: as it is');
    assert.deepEqual(items[1], { type: 'text', text: '(Image "huge.jpg" is not attached for me to see: the media analyzer is busy. media.view with its stored path tries again.)' });
    assert.deepEqual(t.asked.map((input) => input.fileId), [mid.ref.id], 'past the budget no further job is queued');

    answer(COPY);
    const late = path.join(t.vision, `${mid.ref.id}.jpg`);
    await until(() => existsSync(late));
    assert.ok(existsSync(late), 'the late copy is cached');
    assert.deepEqual(await visionInputs(t.s, [{ path: mid.path, mime: 'image/jpeg' }], 40), [{ type: 'image', path: late, mime: 'image/jpeg' }]);
    assert.equal(t.asked.length, 1, 'the next turn reads the cached copy');
  } finally { t.temp.cleanup(); }
});

test('visionInputs: a copy over 3.75 MB (a photo-like PNG) is made once more at a smaller edge', async () => {
  const big = { data: new Uint8Array(VISION_LIMITS.passBytes + 50_000), mime: 'image/png' as const, width: 1568, height: 1568 };
  const t = setup(async (input) => (input.maxPx === VISION_LIMITS.maxPx ? big : COPY));
  try {
    const svg = await t.stored(SVG, 'art.svg', 'image/svg+xml');
    const [item] = await visionInputs(t.s, [{ path: svg.path, mime: svg.mime }]);
    assert.deepEqual(item, { type: 'image', path: path.join(t.vision, `${svg.ref.id}.jpg`), mime: 'image/jpeg' });
    const edge = smallerEdge(big);
    assert.deepEqual(t.asked.map((input) => input.maxPx), [1568, edge]);
    assert.ok(edge >= 512 && edge < 1568 * Math.sqrt(VISION_LIMITS.passBytes / big.data.length), String(edge));
  } finally { t.temp.cleanup(); }
});

test('vision cache: two turns with the same image keep one copy; the newest copies stay and stale part files go', async () => {
  const t = setup(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return COPY; });
  try {
    const svg = await t.stored(SVG, 'logo.svg', 'image/svg+xml');
    const [a, b] = await Promise.all([visionInputs(t.s, [{ path: svg.path, mime: svg.mime }]), visionInputs(t.s, [{ path: svg.path, mime: svg.mime }])]);
    assert.deepEqual(a, b);
    assert.deepEqual(readdirSync(t.vision), [`${svg.ref.id}.jpg`], 'one copy, no part file');

    const old = new Date(Date.now() - 3_600_000);
    const names = Array.from({ length: VISION_CACHE.files }, (_, i) => `${i.toString(16).padStart(64, '0')}.jpg`);
    for (const [i, name] of names.entries()) {
      writeFileSync(path.join(t.vision, name), 'x');
      utimesSync(path.join(t.vision, name), old, new Date(old.getTime() + i * 1000)); // names[0] is the oldest
    }
    utimesSync(path.join(t.vision, `${svg.ref.id}.jpg`), old, new Date(old.getTime() + 500_000));
    writeFileSync(path.join(t.vision, 'crash.jpg.1.part'), 'x');
    utimesSync(path.join(t.vision, 'crash.jpg.1.part'), old, old);
    writeFileSync(path.join(t.vision, 'writing.jpg.2.part'), 'x');
    const other = await t.stored(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'), 'dot.svg', 'image/svg+xml');
    await visionInputs(t.s, [{ path: other.path, mime: other.mime }]);
    const left = new Set(readdirSync(t.vision));
    assert.equal(left.has(`${other.ref.id}.jpg`), true, 'the new copy');
    assert.equal([...left].filter((name) => name.endsWith('.jpg')).length, VISION_CACHE.files);
    assert.equal(left.has(names[0]) || left.has(names[1]), false, 'the two oldest went');
    assert.equal(left.has(`${svg.ref.id}.jpg`), true, 'a newer copy stays');
    assert.equal(left.has('crash.jpg.1.part'), false, 'a stale part file goes');
    assert.equal(left.has('writing.jpg.2.part'), true, 'a fresh one may still be written');
  } finally { t.temp.cleanup(); }
});

test('visionInputs: an image whose header cannot be read goes as before (a turn never fails over an image)', async () => {
  const t = setup(async () => COPY);
  try {
    const id = 'ab'.repeat(32);
    const where = t.files.path(id);
    mkdirSync(where, { recursive: true }); // a folder where the blob should be: opening or reading it fails
    assert.deepEqual(await visionInputs(t.s, [{ path: where, mime: 'image/png' }]), [{ type: 'image', path: where, mime: 'image/png' }]);
    assert.equal(t.asked.length, 0);
  } finally { t.temp.cleanup(); }
});
