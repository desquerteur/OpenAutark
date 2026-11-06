// MM4: the pure rules of the media analyzer (src/main/media-keyframes.ts) – the checked host-op
// request, the sample count, picking keyframes (opening shot, biggest scene changes spaced apart,
// even coverage, nearly black ones last), checking the page's measurements and reading a JPEG's
// size from its frame header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYFRAME_LIMITS } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { checkFacts, jpegSize, keyframeRequest, pickKeyframes, sampleCount, SCENE_CHANGE } from '../../../src/main/media-keyframes.ts';
import type { Sample } from '../../../src/main/media-keyframes.ts';

const ID = 'ab'.repeat(32);

/** A minimal JPEG: SOI, an APP0 segment, a baseline frame header of the size, EOI. */
export function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
    0xff, sof, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

/** Samples every 100 ms; `scenes` are the indexes where a new scene starts. */
function samples(count: number, scenes: number[], dark: number[] = []): Sample[] {
  return Array.from({ length: count }, (_, i) => ({ atMs: 50 + i * 100, change: i === 0 ? 1 : scenes.includes(i) ? 0.4 + i / 1000 : 0.01, dark: dark.includes(i) }));
}

test('keyframeRequest: blob id, 1–12 frames (default 6), only a video MIME type is passed on', () => {
  assert.deepEqual(keyframeRequest({ fileId: ID }), { fileId: ID, frames: KEYFRAME_LIMITS.defaultFrames });
  assert.deepEqual(keyframeRequest({ fileId: ID, frames: 12, mime: 'Video/WebM; codecs=vp8' }), { fileId: ID, frames: 12, mime: 'video/webm' });
  assert.deepEqual(keyframeRequest({ fileId: ID, frames: 1, mime: 'text/html' }), { fileId: ID, frames: 1 });
  for (const bad of [{ fileId: 'AB'.repeat(32) }, { fileId: '../etc/passwd' }, { fileId: 7 }, { fileId: ID, frames: 0 }, { fileId: ID, frames: 13 }, { fileId: ID, frames: 2.5 }, { fileId: ID, frames: '6' }]) {
    assert.throws(() => keyframeRequest(bad), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request', JSON.stringify(bad));
  }
});

test('sampleCount: four signatures per frame, 16 to 48', () => {
  assert.equal(sampleCount(1), 16);
  assert.equal(sampleCount(6), 24);
  assert.equal(sampleCount(12), 48);
});

test('pickKeyframes: the opening shot, then the scene changes, in time order', () => {
  const picks = pickKeyframes(samples(24, [4, 8, 12, 16, 20]), 6);
  assert.deepEqual(picks.map((pick) => pick.atMs), [50, 450, 850, 1250, 1650, 2050]);
  assert.deepEqual(picks.map((pick) => pick.scene), [false, true, true, true, true, true]);
});

test('pickKeyframes: more changes than frames → the biggest ones, spaced apart', () => {
  // Cuts at 5, 6, 7 (one after another) and 20: 5 and 7 are too close to the biggest one, 6.
  const list = samples(24, [5, 6, 7, 20]);
  list[5].change = 0.5;
  list[6].change = 0.9;
  list[7].change = 0.6;
  list[20].change = 0.7;
  const picks = pickKeyframes(list, 3);
  assert.deepEqual(picks.map((pick) => pick.atMs), [50, 650, 2050]);
  assert.ok(picks.slice(1).every((pick) => pick.scene));
});

test('pickKeyframes: few changes are filled up evenly over the time', () => {
  const picks = pickKeyframes(samples(24, [6, 16]), 6);
  assert.deepEqual(picks.map((pick) => pick.atMs), [50, 650, 950, 1650, 1850, 2350]);
  assert.deepEqual(picks.map((pick) => pick.scene), [false, true, false, true, false, false]);
});

test('pickKeyframes: one long shot is covered evenly; nearly black moments come last', () => {
  const still = pickKeyframes(samples(24, []), 4);
  assert.deepEqual(still.map((pick) => pick.atMs), [50, 850, 1550, 2350], 'from the opening to the last moment');
  assert.ok(still.every((pick) => !pick.scene));
  const gaps = still.slice(1).map((pick, i) => pick.atMs - still[i].atMs);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 100, `even gaps ${gaps.join(',')}`);

  const fade = pickKeyframes(samples(8, [], [0, 7]), 3);
  assert.equal(fade[0].atMs, 150, 'a black opening is skipped for the first visible frame');
  assert.ok(!fade.some((pick) => pick.atMs === 750), 'the black end is not chosen while visible moments are left');
  assert.equal(pickKeyframes(samples(3, [], [0, 1, 2]), 2).length, 2, 'an all-black video still gets frames');
});

test('pickKeyframes: never more frames than samples; a change below the threshold is no scene', () => {
  assert.equal(pickKeyframes(samples(3, [1]), 12).length, 3);
  assert.deepEqual(pickKeyframes([], 6), []);
  const soft = samples(16, []);
  soft[8].change = SCENE_CHANGE - 0.001;
  assert.ok(pickKeyframes(soft, 4).every((pick) => !pick.scene));
});

test('checkFacts: numbers in range, times rising inside the video, at most the asked samples', () => {
  const good = { durationMs: 2400, width: 1280, height: 720, samples: samples(24, [4]) };
  assert.deepEqual(checkFacts(good, 24), good);
  const bad: unknown[] = [
    null, 'x', { ...good, durationMs: 0 }, { ...good, width: 1.5 }, { ...good, height: 99_999 }, { ...good, samples: [] },
    { ...good, samples: samples(25, []) }, { ...good, samples: [{ atMs: 3000, change: 0, dark: false }] },
    { ...good, samples: [{ atMs: 10, change: 0, dark: false }, { atMs: 10, change: 0, dark: false }] },
    { ...good, samples: [{ atMs: 10, change: 2, dark: false }] }, { ...good, samples: [{ atMs: 10, change: Number.NaN, dark: false }] },
    { ...good, samples: [{ atMs: 10, change: 0.1, dark: 'no' }] }, { ...good, samples: [7] },
  ];
  for (const value of bad) assert.equal(checkFacts(value, 24), null, JSON.stringify(value));
});

test('jpegSize: the frame header after other segments; not a JPEG → null', () => {
  assert.deepEqual(jpegSize(jpeg(768, 432)), { width: 768, height: 432 });
  assert.deepEqual(jpegSize(jpeg(300, 768, 0xc2)), { width: 300, height: 768 }, 'progressive');
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(jpegSize(jpeg(0, 10)), null);
  assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0])), null, 'scan before a frame header');
  assert.equal(jpegSize(jpeg(10, 10).slice(0, 12)), null, 'cut off');
});
