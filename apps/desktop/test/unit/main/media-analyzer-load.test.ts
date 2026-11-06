// MM4 load fix (concept-agent-multimodal-capabilities, item 19): the analyzer page under load.
// The live check had found four instead of at least five distinct scenes while unit tests ran in
// parallel. Model of that failure (media-analyzer-fakes.ts `lagMs`): after a seek the picture
// drawImage reads stays the previous one until the decoder presents the new one; frame callbacks
// fire only then. The old page waited for a callback registered after 'seeked' or 80 ms, so a
// presentation later than 80 ms made it draw the previous moment – each late frame repeated the
// scene before it. Checked here: under jittered lags (with and without frame callbacks), with
// three jobs queued at once and with a late picture of an earlier seek, the page draws every
// moment it reports, so the picks and frames equal the unloaded run; a still video without frame
// callbacks stays within the page's extra-wait budget. Review fix: a first picture later than the
// longest wait keeps the frame-callback path, and past the job deadline no seek waits any more.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Keyframes } from '../../../src/shared/api/host-bridge.ts';
import { analyzerPage } from '../../../src/main/media-analyzer-page.ts';
import { newJob, serveJob } from '../../../src/main/media-analyzer-routes.ts';
import { keyframeRequest } from '../../../src/main/media-keyframes.ts';
import { blobPath } from '../../../src/main/protocols/rules.ts';
import { analyzerSetup, greyOf, pageEnv } from './media-analyzer-fakes.ts';
import type { Clip } from './media-analyzer-fakes.ts';

/** 4.8 s with cuts at 1.2, 2.4 and 3.6 s (the unloaded run picks these moments, media-analyzer.test.ts). */
const CLIP: Clip = { width: 1280, height: 720, durationMs: 4800, scenes: [[0, 40], [1200, 200], [2400, 90], [3600, 240]] };
const PICKS = [100, 1300, 1900, 2500, 3700, 4700];
const GREYS = [40, 200, 200, 90, 240, 240];
/** Presentation lags under load: mostly short, some well past the old 80 ms wait. */
const JITTER = [5, 120, 10, 160, 15, 95, 5, 30];

test('under load (late pictures, frame callbacks): the same picks and every frame drawn at its own moment', async () => {
  const s = analyzerSetup();
  try {
    const result = await s.analyzer.analyze({ fileId: s.put({ ...CLIP, lagMs: JITTER }), mime: 'video/webm', frames: 6 });
    assert.deepEqual(result.frames.map((frame) => frame.atMs), PICKS);
    assert.deepEqual(result.frames.map((frame) => greyOf(frame.data)), GREYS, 'no frame repeats the moment before it');
    assert.equal(new Set(result.frames.map((frame) => greyOf(frame.data))).size, 4, 'all four scenes');
  } finally { s.temp.cleanup(); }
});

test('three jobs queued at once under different loads: each one complete and correct, one at a time', async () => {
  const s = analyzerSetup();
  try {
    const lags = [JITTER, [130, 5, 100, 10], [5, 140, 5]];
    const jobs = lags.map((lagMs, i) => s.analyzer.analyze({ fileId: s.put({ ...CLIP, lagMs, width: 1280 + i * 2 }), frames: 6 }));
    const results = await Promise.all(jobs);
    for (const result of results) {
      assert.deepEqual(result.frames.map((frame) => frame.atMs), PICKS);
      assert.deepEqual(result.frames.map((frame) => greyOf(frame.data)), GREYS);
    }
    assert.equal(s.windows.length, 1, 'one window served the queue');
    assert.deepEqual(s.windows[0].loads, ['wf-file://media-analyzer/job/1/', 'wf-file://media-analyzer/job/2/', 'wf-file://media-analyzer/job/3/']);
  } finally { s.temp.cleanup(); }
});

test('a recording measured at its end: the late picture of that seek is not taken for the first sample', async () => {
  const s = analyzerSetup();
  try {
    // The end's picture (grey 240) is presented 300 ms late, after the first sample's seek began.
    const result = await s.analyzer.analyze({ fileId: s.put({ ...CLIP, recording: true, lagMs: [300, 20, 20, 20] }), frames: 4 });
    assert.equal(result.durationMs, 4800);
    assert.equal(greyOf(result.frames[0].data), 40, 'the opening shot, not the end');
    assert.equal(result.frames.length, 4);
  } finally { s.temp.cleanup(); }
});

/** Runs the page directly against one job whose spec the test sets (short waits). */
async function runPage(clip: Clip, spec: Record<string, number>) {
  const s = analyzerSetup();
  const id = s.put(clip);
  const file = blobPath(path.join(s.temp.dir, 'blobs'), id);
  const bytes = new TextEncoder().encode(JSON.stringify(clip)).byteLength;
  const job = newJob(1, { kind: 'keyframes', request: keyframeRequest({ fileId: id, frames: 6 }) }, file, bytes, 'video/webm');
  const serve = async (request: Request) => {
    const response = await serveJob(request, job);
    if (!request.url.endsWith('/spec')) return response;
    return new Response(JSON.stringify({ ...(await response.json()), ...spec }), { headers: { 'Content-Type': 'application/json' } });
  };
  const started = Date.now();
  void analyzerPage(pageEnv(serve, 'wf-file://media-analyzer/job/1/'));
  try {
    const result = await job.done as Keyframes;
    return { result, ms: Date.now() - started };
  } finally { s.temp.cleanup(); }
}

test('a window that presents no frames: the picture is compared with the last one before it counts', async () => {
  const { result } = await runPage({ ...CLIP, lagMs: [30, 60, 45, 70], frameCallbacks: false }, { waitMs: 100, lookMs: 80, budgetMs: 400 });
  assert.deepEqual(result.frames.map((frame) => frame.atMs), PICKS);
  assert.deepEqual(result.frames.map((frame) => greyOf(frame.data)), GREYS);
});

test('a still video without frame callbacks stays within the extra-wait budget', async () => {
  const still: Clip = { width: 640, height: 360, durationMs: 4800, scenes: [[0, 120]], lagMs: [5], frameCallbacks: false };
  const { result, ms } = await runPage(still, { waitMs: 100, lookMs: 20, budgetMs: 200 });
  assert.equal(result.frames.length, 6);
  assert.ok(result.frames.every((frame) => greyOf(frame.data) === 120));
  // 24 samples + 6 frames: one look each (20 ms) + the budget (200 ms) + the first wait for a callback (100 ms).
  assert.ok(ms < 2500, `took ${ms} ms`);
});

test('a picture later than the longest wait: the late one does not count for the next seek', async () => {
  // The seek to 1.1 s gets its picture after both waits (600 ms); the seek to 1.3 s (the first cut)
  // starts before that and must not take the late picture (media time 1.1 s) for its own.
  const lagMs = Array.from({ length: 24 }, (_, i) => (i === 5 ? 600 : i === 6 ? 200 : 10));
  const { result } = await runPage({ ...CLIP, lagMs }, { waitMs: 250, lookMs: 20, budgetMs: 1000 });
  assert.deepEqual(result.frames.map((frame) => frame.atMs), PICKS);
  assert.deepEqual(result.frames.map((frame) => greyOf(frame.data)), GREYS);
});

test('a first picture later than the longest wait: the window still counts as presenting frames', async () => {
  // Review fix: the first seek's picture comes after waitMs; later ones take longer than a look
  // (lookMs) but less than waitMs. The page must keep waiting for presented frames, not fall back
  // to comparing pictures for the rest of the job (whose small budget would run out).
  const lagMs = [400, ...Array.from({ length: 29 }, () => 100)];
  const { result } = await runPage({ ...CLIP, lagMs }, { waitMs: 150, lookMs: 20, budgetMs: 60 });
  assert.deepEqual(result.frames.map((frame) => frame.atMs), PICKS);
  assert.deepEqual(result.frames.map((frame) => greyOf(frame.data)), GREYS);
});

test('past the job deadline no seek waits any more: pictures that always come late end the job in time', async () => {
  // The first picture comes in time (the window presents frames), every later one after waitMs.
  const late: Clip = { ...CLIP, lagMs: [10, ...Array.from({ length: 30 }, () => 300)] };
  const { result, ms } = await runPage(late, { waitMs: 250, lookMs: 20, budgetMs: 1000, deadlineMs: 600 });
  assert.equal(result.frames.length, 6);
  // Without the deadline: 29 seeks × 250 ms plus the extra waits (over 8 s).
  assert.ok(ms < 3000, `took ${ms} ms`);
});
