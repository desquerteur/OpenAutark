// MM4 + B-058 T2: the host ops media.analyze, media.audio and media.image end to end between the
// runtime and main without Electron – the runtime's Electron host asks main over the host bridge
// (with a wait long enough for the analyzer's one queue), main's HostServices checks the arguments
// again and hands the job to the media analyzer, answers with bytes of their own, and answers
// 'unavailable' when this build has no analyzer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_DECODE_LIMITS, IMAGE_LIMITS, KEYFRAME_LIMITS } from '../../../src/shared/api/host-bridge.ts';
import type { DecodedAudio, HostOp, HostRequest, Keyframes, NormalizedImage } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HostServices } from '../../../src/main/host-services.ts';
import type { HostServicesDeps } from '../../../src/main/host-services.ts';
import type { AudioRequest } from '../../../src/main/media-audio.ts';
import type { ImageRequest } from '../../../src/main/media-image.ts';
import type { KeyframeRequest } from '../../../src/main/media-keyframes.ts';
import { HostBridgeClient, createElectronHost } from '../../../src/runtime/host-electron.ts';

const ID = 'cd'.repeat(32);
const APP = { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: '/e' };
const KEYFRAMES: Keyframes = { durationMs: 4000, width: 1280, height: 720, frames: [{ atMs: 100, scene: false, data: new Uint8Array([0xff, 0xd8, 1]), width: 768, height: 432, mime: 'image/jpeg' }] };
/** The most a job can take in the queue: each task holds `waiting` + 1 jobs (the running one counted), all at their own time. */
const QUEUE_MS = (KEYFRAME_LIMITS.waiting + 1) * KEYFRAME_LIMITS.jobMs + (AUDIO_DECODE_LIMITS.waiting + 1) * AUDIO_DECODE_LIMITS.jobMs + (IMAGE_LIMITS.waiting + 1) * IMAGE_LIMITS.jobMs;

const services = (media?: HostServicesDeps['media']) => new HostServices({ media } as unknown as HostServicesDeps);
const ask = (host: HostServices, args: unknown, op: HostOp = 'media.analyze') => host.handle({ id: 1, type: 'host', op, args } as HostRequest);
const rejectsWith = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code && (!message || message.test(error.message)));

test('HostServices media.analyze: checked arguments, the analyzer\'s keyframes in bytes of their own', async () => {
  const asked: KeyframeRequest[] = [];
  const shared = new Uint8Array(64);
  shared.set([0xff, 0xd8, 1], 8);
  const host = services({
    analyze: async (request) => {
      asked.push(request);
      return { ...KEYFRAMES, frames: [{ ...KEYFRAMES.frames[0], data: shared.subarray(8, 11) }] };
    },
  });
  const result = await ask(host, { fileId: ID, mime: 'video/mp4; codecs=avc1', frames: 4 }) as Keyframes;
  assert.deepEqual(asked, [{ fileId: ID, mime: 'video/mp4', frames: 4 }]);
  assert.deepEqual([...result.frames[0].data], [0xff, 0xd8, 1]);
  assert.equal(result.frames[0].data.buffer.byteLength, 3, 'a view of a larger buffer is copied before it is posted');
  assert.deepEqual(await ask(host, { fileId: ID }).then(() => asked.at(-1)), { fileId: ID, frames: KEYFRAME_LIMITS.defaultFrames });

  for (const args of [{}, { fileId: 'xyz' }, { fileId: ID, frames: 0 }, { fileId: ID, frames: 13 }, { fileId: ID, frames: '3' }]) {
    await rejectsWith(ask(host, args), 'bad_request');
  }
  assert.equal(asked.length, 2, 'refused requests never reach the analyzer');
  const many = services({ analyze: async () => ({ ...KEYFRAMES, frames: [100, 200, 300].map((atMs) => ({ ...KEYFRAMES.frames[0], atMs })) }) });
  assert.deepEqual((await ask(many, { fileId: ID, frames: 2 }) as Keyframes).frames.map((frame) => frame.atMs), [100, 200], 'never more frames than asked');
  await rejectsWith(ask(services(), { fileId: ID }), 'unavailable', /not available in this build/);
  await rejectsWith(ask(services({ analyze: async () => { throw new WorkforceError('timeout', 'Reading the video took longer than 30 s.'); } }), { fileId: ID }), 'timeout', /30 s/);
});

test('HostServices media.audio and media.image: checked arguments, results in bytes of their own, unavailable without an analyzer', async () => {
  const audios: AudioRequest[] = [];
  const images: ImageRequest[] = [];
  const pool = new Uint8Array(32);
  const host = services({
    analyze: async () => KEYFRAMES,
    audio: async (request) => { audios.push(request); return { sampleRate: 16_000, pcm: pool.subarray(4, 8), durationMs: 90_000, startMs: request.startMs, partial: true }; },
    image: async (request) => { images.push(request); return { data: pool.subarray(0, 6), mime: 'image/png', width: 10, height: 10 }; },
  });
  const heard = await ask(host, { fileId: ID, mime: 'audio/webm;codecs=opus', startMs: 1500.7, maxMs: 99 * 3_600_000 }, 'media.audio') as DecodedAudio;
  assert.deepEqual(audios, [{ fileId: ID, mime: 'audio/webm', startMs: 1500, maxMs: AUDIO_DECODE_LIMITS.maxMs }], 'a span longer than the limit is capped');
  assert.equal(heard.pcm.byteLength, 4);
  assert.equal(heard.pcm.buffer.byteLength, 4, 'the PCM is copied out of a larger buffer');
  assert.deepEqual(await ask(host, { fileId: ID }, 'media.audio').then(() => audios.at(-1)), { fileId: ID, startMs: 0, maxMs: AUDIO_DECODE_LIMITS.maxMs });
  for (const args of [{}, { fileId: 'xyz' }, { fileId: ID, startMs: -1 }, { fileId: ID, maxMs: 0 }, { fileId: ID, maxMs: '9' }, { fileId: ID, startMs: Number.NaN }]) {
    await rejectsWith(ask(host, args, 'media.audio'), 'bad_request');
  }
  assert.equal(audios.length, 2, 'refused requests never reach the analyzer');

  const prepared = await ask(host, { fileId: ID, mime: 'image/webp', maxPx: 512, region: { x: 0.5, y: 0, w: 0.5, h: 0.25 } }, 'media.image') as NormalizedImage;
  assert.deepEqual(images, [{ fileId: ID, mime: 'image/webp', maxPx: 512, region: { x: 0.5, y: 0, w: 0.5, h: 0.25 } }]);
  assert.equal(prepared.data.buffer.byteLength, 6, 'the image is copied out of a larger buffer');
  assert.deepEqual(await ask(host, { fileId: ID }, 'media.image').then(() => images.at(-1)), { fileId: ID, maxPx: IMAGE_LIMITS.maxPx });
  for (const args of [{ fileId: ID, maxPx: 8 }, { fileId: ID, maxPx: 4000 }, { fileId: ID, maxPx: 100.5 }, { fileId: ID, region: { x: 0.8, y: 0, w: 0.5, h: 1 } },
    { fileId: ID, region: { x: 0, y: 0, w: 0, h: 1 } }, { fileId: ID, region: { x: 1, y: 0, w: 0.1, h: 1 } }, { fileId: ID, region: 'top' }]) {
    await rejectsWith(ask(host, args, 'media.image'), 'bad_request');
  }
  assert.equal(images.length, 2);

  const old = services({ analyze: async () => KEYFRAMES });
  await rejectsWith(ask(old, { fileId: ID }, 'media.audio'), 'unavailable', /Decoding recordings is not available/);
  await rejectsWith(ask(old, { fileId: ID }, 'media.image'), 'unavailable', /Preparing images is not available/);
  await rejectsWith(ask(services(), { fileId: ID }, 'media.audio'), 'unavailable');
});

test('Electron host: keyframes, audio and image are host ops of the analyzer and wait for its whole queue, not 15 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posted: Array<{ id: number; op: string; args: unknown }> = [];
  const bridge = new HostBridgeClient({ postMessage: (message) => posted.push(message as { id: number; op: string; args: unknown }) });
  const host = createElectronHost(bridge, APP);
  assert.ok(host.media?.audio && host.media.image, 'the Electron host decodes sound and prepares images');

  const answered = host.media.keyframes({ fileId: ID, mime: 'video/webm', frames: 6 });
  const heard = host.media.audio({ fileId: ID, mime: 'audio/ogg', startMs: 0, maxMs: 60_000 });
  const prepared = host.media.image({ fileId: ID, maxPx: 768, region: { x: 0, y: 0, w: 1, h: 0.5 } });
  assert.deepEqual(posted.map(({ op, args }) => ({ op, args })), [
    { op: 'media.analyze', args: { fileId: ID, mime: 'video/webm', frames: 6 } },
    { op: 'media.audio', args: { fileId: ID, mime: 'audio/ogg', startMs: 0, maxMs: 60_000 } },
    { op: 'media.image', args: { fileId: ID, maxPx: 768, region: { x: 0, y: 0, w: 1, h: 0.5 } } },
  ]);
  bridge.resolve({ id: posted[0].id, type: 'host-result', ok: true, result: KEYFRAMES });
  assert.deepEqual(await answered, KEYFRAMES);
  const pcm = new Uint8Array([1, 0, 2, 0]);
  bridge.resolve({ id: posted[1].id, type: 'host-result', ok: true, result: { sampleRate: 16_000, pcm, durationMs: 1000, startMs: 0, partial: false } });
  assert.equal((await heard).pcm, pcm);
  bridge.resolve({ id: posted[2].id, type: 'host-result', ok: false, error: { code: 'unavailable', message: 'HEIC/HEIF photos cannot be read here.' } });
  await rejectsWith(prepared, 'unavailable', /HEIC/);

  // Each op may take as long as the whole full queue – every task's waiting jobs plus the running one, its own
  // included – and a margin, never less (review fix: a full queue of the other tasks outlasted the old wait).
  assert.equal(QUEUE_MS, 4 * 30_000 + 4 * 120_000 + 9 * 20_000);
  for (const op of ['keyframes', 'audio', 'image'] as const) {
    const waiting = op === 'keyframes' ? host.media.keyframes({ fileId: ID, frames: 2 }) : op === 'audio' ? host.media.audio({ fileId: ID }) : host.media.image({ fileId: ID });
    let settled = false;
    waiting.catch(() => undefined).finally(() => { settled = true; });
    t.mock.timers.tick(QUEUE_MS);
    await Promise.resolve();
    assert.equal(settled, false, `${op}: still waiting after the whole queue's time`);
    t.mock.timers.tick(15_000);
    await rejectsWith(waiting, 'timeout');
  }
});
