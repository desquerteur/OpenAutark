// MM4: the media analyzer in main (src/main/media-analyzer.ts) with the real analyzer page
// (media-analyzer-page.ts) in a fake browser – a job end to end (spec, the blob streamed through
// the video route, samples, picks, checked JPEGs), a recording without a duration, one job at a
// time with at most three waiting, the window reused while jobs follow and destroyed after 60 s
// idle, at once after a timeout, a crash, a failed load or a failed job, and on quit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYFRAME_LIMITS } from '../../../src/shared/api/host-bridge.ts';
import type { Keyframes } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { IDLE_MS } from '../../../src/main/media-analyzer.ts';
import { analyzerSetup, greyOf, settle } from './media-analyzer-fakes.ts';
import type { Clip } from './media-analyzer-fakes.ts';

/** 4.8 s at 1280×720 with cuts at 1.2, 2.4 and 3.6 s. */
const CLIP: Clip = { width: 1280, height: 720, durationMs: 4800, scenes: [[0, 40], [1200, 200], [2400, 90], [3600, 240]] };

const rejectsWith = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code && (!message || message.test(error.message)));

test('a job: the opening shot, the scene changes and even coverage as JPEGs ≤ 768 px in time order', async () => {
  const s = analyzerSetup();
  try {
    const id = s.put(CLIP);
    const result: Keyframes = await s.analyzer.analyze({ fileId: id, mime: 'video/webm', frames: 6 });
    assert.deepEqual([result.durationMs, result.width, result.height], [4800, 1280, 720]);
    assert.deepEqual(result.frames.map((frame) => frame.atMs), [100, 1300, 1900, 2500, 3700, 4700]);
    assert.deepEqual(result.frames.map((frame) => frame.scene), [false, true, false, true, true, false]);
    assert.deepEqual(result.frames.map((frame) => greyOf(frame.data)), [40, 200, 200, 90, 240, 240], 'each frame was drawn at its own moment');
    for (const frame of result.frames) {
      assert.deepEqual([frame.width, frame.height, frame.mime], [768, 432, 'image/jpeg']);
      assert.ok(frame.data instanceof Uint8Array && frame.data[0] === 0xff && frame.data[1] === 0xd8);
    }
    const [window] = s.windows;
    assert.equal(window.loads[0], 'wf-file://media-analyzer/job/1/');
    assert.equal(window.pages[0].videos[0].released, true, 'the page let go of the video');

    // The window stays for the next job and goes after 60 s without one.
    assert.equal(s.analyzer.windowOpen, true);
    assert.equal(s.timers.live(IDLE_MS), 1);
    const again = await s.analyzer.analyze({ fileId: id, frames: 2 });
    assert.equal(again.frames.length, 2);
    assert.equal(s.windows.length, 1, 'the window was reused');
    assert.equal(window.loads[1], 'wf-file://media-analyzer/job/2/');
    assert.equal(s.timers.live(IDLE_MS), 1, 'one idle timer, re-armed');
    assert.equal(s.timers.fire(IDLE_MS), 1);
    assert.equal(window.destroyed, true);
    assert.equal(s.analyzer.windowOpen, false);
    assert.equal(s.timers.live(KEYFRAME_LIMITS.jobMs), 0, 'no job timer is left');
  } finally { s.temp.cleanup(); }
});

test('a recording without a duration is measured by seeking to its end; a short clip gets fewer frames', async () => {
  const s = analyzerSetup();
  try {
    const recording = await s.analyzer.analyze({ fileId: s.put({ ...CLIP, recording: true }), frames: 4 });
    assert.equal(recording.durationMs, 4800);
    assert.equal(recording.frames.length, 4);
    // 0.3 s → 9 samples (30 per second at most) – never more frames than samples.
    const short = await s.analyzer.analyze({ fileId: s.put({ width: 640, height: 360, durationMs: 300, scenes: [[0, 120]] }), frames: 12 });
    assert.equal(short.frames.length, 9);
    assert.ok(short.frames.every((frame) => frame.width === 640 && frame.height === 360), 'small videos are not scaled up');
  } finally { s.temp.cleanup(); }
});

test('clear failures: bad request, missing blob, not decodable, sound only – a failed job closes the window', async () => {
  const s = analyzerSetup();
  try {
    await rejectsWith(s.analyzer.analyze({ fileId: '../../etc/passwd' }), 'bad_request');
    await rejectsWith(s.analyzer.analyze({ fileId: 'ab'.repeat(32), frames: 13 }), 'bad_request');
    await rejectsWith(s.analyzer.analyze({ fileId: 'ab'.repeat(32) }), 'not_found', /not in the file store/);
    assert.equal(s.windows.length, 0, 'nothing opened for a missing file');

    await rejectsWith(s.analyzer.analyze({ fileId: s.put(new Uint8Array([1, 2, 3])) }), 'unavailable', /format or codec is not supported/);
    assert.equal(s.windows[0].destroyed, true);
    await rejectsWith(s.analyzer.analyze({ fileId: s.put({ ...CLIP, width: 0, height: 0 }) }), 'unavailable', /only sound\. Use media\.transcribe/);
    assert.equal(s.windows.length, 2, 'the next job opened a fresh window');
    assert.equal(s.windows[1].destroyed, true);
    assert.equal(s.analyzer.windowOpen, false);
    assert.equal(s.timers.live(IDLE_MS), 0, 'no idle timer without a window');
  } finally { s.temp.cleanup(); }
});

test('timeout, crash and a failed load end the job and destroy the window; the next job starts fresh', async () => {
  const s = analyzerSetup();
  try {
    const id = s.put(CLIP);
    s.setMode('hang');
    const hung = s.analyzer.analyze({ fileId: id });
    await settle(() => s.timers.live(KEYFRAME_LIMITS.jobMs) === 1);
    assert.equal(s.timers.fire(KEYFRAME_LIMITS.jobMs), 1);
    await rejectsWith(hung, 'timeout', /longer than 30 s/);
    assert.equal(s.windows[0].destroyed, true);

    s.setMode('crash');
    await rejectsWith(s.analyzer.analyze({ fileId: id }), 'unavailable', /reader stopped/);
    assert.equal(s.windows[1].destroyed, true, 'a crashed renderer leaves no hidden window behind');

    s.setMode('refuse');
    await rejectsWith(s.analyzer.analyze({ fileId: id }), 'unavailable', /did not start/);
    assert.equal(s.windows[2].destroyed, true);

    s.setMode('run');
    assert.equal((await s.analyzer.analyze({ fileId: id, frames: 3 })).frames.length, 3);
    assert.equal(s.windows.length, 4);
    assert.equal(s.timers.live(KEYFRAME_LIMITS.jobMs), 0);
  } finally { s.temp.cleanup(); }
});

test('one job at a time, at most three waiting; quit fails the running job and closes the window', async () => {
  const s = analyzerSetup();
  try {
    const id = s.put(CLIP);
    s.setMode('hang');
    const jobs = [1, 2, 3, 4].map(() => s.analyzer.analyze({ fileId: id }));
    for (const job of jobs) job.catch(() => undefined);
    await rejectsWith(s.analyzer.analyze({ fileId: id }), 'conflict', /Several videos/);
    await settle(() => s.windows.length === 1);
    await settle();
    assert.equal(s.windows.length, 1);
    assert.deepEqual(s.windows[0].loads, ['wf-file://media-analyzer/job/1/'], 'only the first job runs');

    s.setMode('run');
    s.timers.fire(KEYFRAME_LIMITS.jobMs); // job 1 times out, job 2 runs in a fresh window
    await rejectsWith(jobs[0], 'timeout');
    assert.equal((await jobs[1]).frames.length, KEYFRAME_LIMITS.defaultFrames);
    assert.equal(s.windows.length, 2);

    s.setMode('hang');
    await settle(() => s.windows[1].loads.length === 2);
    s.analyzer.dispose();
    await rejectsWith(jobs[2], 'unavailable', /closing/);
    await rejectsWith(jobs[3], 'unavailable', /closing/);
    assert.equal(s.windows[1].destroyed, true);
    assert.equal(s.windows[1].loads.length, 2, 'the waiting job never started');
    await rejectsWith(s.analyzer.analyze({ fileId: id }), 'unavailable', /closing/);
    assert.equal(s.analyzer.windowOpen, false);
    assert.equal(s.timers.live(IDLE_MS), 0, 'no idle timer after quit');
  } finally { s.temp.cleanup(); }
});
