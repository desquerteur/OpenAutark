// B-058 T2: decoding a stored recording's or video's sound in the media analyzer (host op media.audio)
// with the real page in a fake browser – the whole file mixed down to 16 kHz mono PCM16 in ≤ 1 MiB
// chunks at their byte offsets, a span from startMs, a MediaRecorder file without a length, a long
// stream format read only up to the span (Range), MP4 read whole only up to 30 min, files without
// readable sound, the pcm/done routes' checks, and the one queue shared with keyframe jobs (own
// waiting limit, own time, own failure texts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_DECODE_LIMITS } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { audioRequest, audioResult, PCM_CHUNK_BYTES, pcmChunkOk, streamable } from '../../../src/main/media-audio.ts';
import { analyzerSetup, settle } from './media-analyzer-fakes.ts';
import { FakeAudioContext, monoAt, soundFile } from './media-task-fakes.ts';
import type { Sound } from './media-task-fakes.ts';

const sound = (patch: Partial<Sound>): Sound => ({ kind: 'sound', durationMs: 5000, size: 40_000, ...patch });
const rejectsWith = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code && (!message || message.test(error.message)));
const int16 = (pcm: Uint8Array, i: number) => new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(i * 2, true) / 32768;
const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
const raw = (bytes: Uint8Array<ArrayBuffer>): RequestInit => ({ method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });

test('rules: the request, which formats may be read in part, chunk checks and the end report', () => {
  const id = 'ab'.repeat(32);
  assert.deepEqual(audioRequest({ fileId: id }), { fileId: id, startMs: 0, maxMs: AUDIO_DECODE_LIMITS.maxMs });
  assert.deepEqual(audioRequest({ fileId: id, mime: 'Video/MP4; codecs=avc1', startMs: 2.9, maxMs: 1000.4 }), { fileId: id, mime: 'video/mp4', startMs: 2, maxMs: 1000 });
  assert.equal(audioRequest({ fileId: id, mime: 'image/png' }).mime, undefined, 'only audio and video types are passed on');
  for (const mime of ['audio/mpeg', 'audio/ogg; codecs=opus', 'audio/webm', 'video/webm', 'video/x-matroska', 'audio/flac', 'audio/aac', 'audio/wav']) assert.equal(streamable(mime), true, mime);
  for (const mime of ['audio/mp4', 'video/mp4', 'video/quicktime', 'audio/x-m4a', 'application/octet-stream']) assert.equal(streamable(mime), false, mime);

  const span = audioRequest({ fileId: id, maxMs: 1000 }); // 32 000 bytes at most
  assert.equal(pcmChunkOk(0, 2, span), true);
  assert.equal(pcmChunkOk(0, 3, span), false, 'whole samples');
  assert.equal(pcmChunkOk(0, 0, span), false);
  assert.equal(pcmChunkOk(31_998, 2, span), true);
  assert.equal(pcmChunkOk(31_998, 4, span), false, 'not past the span');
  assert.equal(pcmChunkOk(0, PCM_CHUNK_BYTES + 2, audioRequest({ fileId: id })), false, 'at most 1 MiB per chunk');

  const chunks = [new Uint8Array([1, 0]), new Uint8Array([2, 0, 3, 0])];
  const done = audioResult({ durationMs: 10, partial: false }, { ...span, startMs: 500 }, chunks, 6);
  assert.deepEqual(done && [...done.pcm], [1, 0, 2, 0, 3, 0]);
  assert.equal(done?.durationMs, 501, 'at least the decoded span\'s end');
  assert.equal(done?.partial, false);
  assert.equal(audioResult({ durationMs: 60_000 }, span, chunks, 6)?.partial, true, 'the span ends before the sound');
  for (const report of [null, 'done', { durationMs: -1 }, { durationMs: 1.5 }, { durationMs: 10, partial: 'yes' }]) assert.equal(audioResult(report, span, [], 0), null);
});

test('a stereo WebM: its whole sound as 16 kHz mono PCM16 in 1 MiB chunks; a span from startMs', async () => {
  const s = analyzerSetup();
  try {
    const clip = sound({ durationMs: 70_000, size: 600_000, channels: 2, freq: 300, amp: 0.6 });
    const id = s.put(soundFile(clip));
    const whole = await s.analyzer.audio({ fileId: id, mime: 'audio/webm;codecs=opus' });
    assert.deepEqual([whole.sampleRate, whole.durationMs, whole.startMs, whole.partial], [16_000, 70_000, 0, false]);
    assert.equal(whole.pcm.byteLength, 70_000 * 32);
    for (const i of [0, 7, 1234, 524_288, 1_119_999]) assert.ok(Math.abs(int16(whole.pcm, i) - monoAt(clip, i)) < 2 / 32767, `sample ${i} is the mean of both channels`);
    const page = s.windows[0].pages[0];
    const posts = page.requests.filter((request) => request.url.includes('/pcm?')).map((request) => new URL(request.url).searchParams.get('at'));
    assert.deepEqual(posts, ['0', String(PCM_CHUNK_BYTES), String(2 * PCM_CHUNK_BYTES)], 'chunks at their byte offsets');
    assert.equal(page.audios[0].released, true, 'the <audio> element let go of the file');
    assert.ok(page.requests.every((request) => request.url.startsWith('wf-file://media-analyzer/job/1/')), 'only the job\'s own routes');

    const part = await s.analyzer.audio({ fileId: id, startMs: 1000, maxMs: 2000 });
    assert.deepEqual([part.startMs, part.durationMs, part.partial, part.pcm.byteLength], [1000, 70_000, true, 2000 * 32]);
    assert.ok(Math.abs(int16(part.pcm, 0) - monoAt(clip, 16_000)) < 2 / 32767, 'the span starts at 1 s');
    const beyond = await s.analyzer.audio({ fileId: id, startMs: 80_000, maxMs: 1000 });
    assert.deepEqual([beyond.pcm.byteLength, beyond.partial, beyond.durationMs], [0, false, 70_000], 'a start past the end: no sound, not partial');
    assert.equal(s.windows.length, 1, 'one window served all three');
  } finally { s.temp.cleanup(); }
});

test('a MediaRecorder file without a length; a long MP3 read only up to the span; MP4 whole only up to 30 min', async () => {
  const s = analyzerSetup();
  try {
    const recording = await s.analyzer.audio({ fileId: s.put(soundFile(sound({ durationMs: 3200, recording: true }))), mime: 'audio/webm' });
    assert.deepEqual([recording.durationMs, recording.pcm.byteLength, recording.partial], [3200, 3200 * 32, false]);

    // 10 minutes in 1 MB of MP3: 2 s are asked for, so only the start of the file is read.
    FakeAudioContext.decoded.length = 0;
    const long = sound({ durationMs: 600_000, size: 1_000_000 });
    const start = await s.analyzer.audio({ fileId: s.put(soundFile(long)), mime: 'audio/mpeg', maxMs: 2000 });
    assert.deepEqual([start.durationMs, start.partial, start.pcm.byteLength], [600_000, true, 2000 * 32], 'the file\'s length from its metadata');
    const read = s.windows.at(-1)!.pages.at(-1)!.requests.find((request) => request.url.endsWith('/video') && request.headers.get('range'));
    const end = Number(/^bytes=0-(\d+)$/.exec(read?.headers.get('range') ?? '')?.[1]);
    assert.ok(end > 50_000 && end < 200_000, `a prefix was read (bytes 0-${end})`);
    assert.equal(FakeAudioContext.decoded.at(-1), end + 1, 'only that prefix was decoded');

    const mp4 = sound({ durationMs: 40 * 60_000, size: 2_000_000 });
    await rejectsWith(s.analyzer.audio({ fileId: s.put(soundFile(mp4)), mime: 'audio/mp4', maxMs: 1000 }), 'bad_request', /over 30 minutes in a format that is only read whole/);
    const short = await s.analyzer.audio({ fileId: s.put(soundFile(sound({ durationMs: 120_000, size: 200_000 }))), mime: 'video/mp4', maxMs: 1000 });
    assert.deepEqual([short.durationMs, short.partial, short.pcm.byteLength], [120_000, true, 32_000], 'a 2-minute MP4 is read whole');
  } finally { s.temp.cleanup(); }
});

test('review fix: no job decodes more than 30 minutes from the start – a late span of a long MP4 or MP3 is refused before reading', async () => {
  const s = analyzerSetup();
  try {
    FakeAudioContext.decoded.length = 0;
    // 45 minutes of MP4 asked from minute 25: before, the span reaching the end let the whole file be decoded.
    const mp4 = s.put(soundFile(sound({ durationMs: 45 * 60_000, size: 300_000 })));
    await rejectsWith(s.analyzer.audio({ fileId: mp4, mime: 'video/mp4', startMs: 25 * 60_000 }), 'bad_request', /over 30 minutes in a format that is only read whole/);
    // Two hours of MP3: from minute 100 the whole file was decoded (hours of floats); a span ending after 30:00 is refused.
    const mp3 = s.put(soundFile(sound({ durationMs: 120 * 60_000, size: 400_000 })));
    for (const startMs of [100 * 60_000, 30 * 60_000 - 1000]) {
      await rejectsWith(s.analyzer.audio({ fileId: mp3, mime: 'audio/mpeg', startMs, maxMs: 2000 }), 'bad_request', /Only the first 30 minutes of a recording can be decoded here/);
    }
    assert.deepEqual(FakeAudioContext.decoded, [], 'nothing was decoded');
  } finally { s.temp.cleanup(); }
});

test('no readable sound: a video without a sound track, an unreadable file, a missing blob, a bad request', async () => {
  const s = analyzerSetup();
  try {
    await rejectsWith(s.analyzer.audio({ fileId: s.put(soundFile(sound({ noAudio: true }))), mime: 'video/mp4' }), 'bad_request', /no sound that can be read here/);
    assert.equal(s.windows[0].destroyed, true, 'a failed job closes the window');
    await rejectsWith(s.analyzer.audio({ fileId: s.put(soundFile(sound({ unreadable: true }))) }), 'bad_request', /recording cannot be read here: the format or codec/);
    await rejectsWith(s.analyzer.audio({ fileId: s.put(new Uint8Array([1, 2, 3])) }), 'bad_request', /recording cannot be read here/);
    await rejectsWith(s.analyzer.audio({ fileId: 'ab'.repeat(32) }), 'not_found', /recording is not in the file store/);
    await rejectsWith(s.analyzer.audio({ fileId: 'ab'.repeat(32), maxMs: -5 }), 'bad_request');
  } finally { s.temp.cleanup(); }
});

/** A hung sound job (the page never runs) whose routes the test calls itself. */
async function hungAudio(s: ReturnType<typeof analyzerSetup>, input: { maxMs?: number } = {}) {
  s.setMode('hang');
  const loads = s.windows.reduce((sum, window) => sum + window.loads.length, 0);
  const job = s.analyzer.audio({ fileId: s.put(soundFile(sound({ size: 100 + loads }))), mime: 'audio/ogg', ...input });
  job.catch(() => undefined);
  await settle(() => s.windows.reduce((sum, window) => sum + window.loads.length, 0) === loads + 1);
  const n = /job\/(\d+)\//.exec(s.windows.at(-1)!.loads.at(-1)!)![1];
  const at = (route: string, init?: RequestInit) => s.analyzer.serve(new Request(`wf-file://media-analyzer/job/${n}/${route}`, init));
  return { job, at };
}

test('routes of a sound job: its spec, PCM in order and within the span, a checked end report', async () => {
  const s = analyzerSetup();
  try {
    const first = await hungAudio(s, { maxMs: 1000 });
    assert.deepEqual(await (await first.at('spec')).json(), {
      task: 'audio', rate: 16_000, startMs: 0, maxMs: 1000, chunkBytes: PCM_CHUNK_BYTES, size: 100, stream: true,
      wholeMs: 30 * 60_000, inputBytes: AUDIO_DECODE_LIMITS.inputBytes, marginMs: 30_000, metaMs: 10_000,
    });
    assert.equal((await first.at('samples', json({}))).status, 404, 'no keyframe routes on a sound job');
    assert.equal((await first.at('frame?at=0', raw(new Uint8Array(4)))).status, 404);
    assert.equal((await first.at('image', raw(new Uint8Array(4)))).status, 404);
    assert.equal((await first.at('pcm?at=4', raw(new Uint8Array(4)))).status, 409, 'not the next offset');
    assert.equal((await first.at('pcm?at=x', raw(new Uint8Array(4)))).status, 409);
    assert.equal((await first.at('pcm?at=0', raw(new Uint8Array([1, 0, 2, 0])))).status, 204);
    assert.equal((await first.at('pcm?at=0', raw(new Uint8Array(4)))).status, 409, 'each offset once');
    assert.equal((await first.at('pcm?at=4', raw(new Uint8Array([3, 0])))).status, 204);
    assert.equal((await first.at('done', json({ durationMs: 1000, partial: false }))).status, 204);
    const result = await first.job;
    assert.deepEqual([...result.pcm], [1, 0, 2, 0, 3, 0]);
    assert.equal(result.durationMs, 1000);

    const odd = await hungAudio(s);
    assert.equal((await odd.at('pcm?at=0', raw(new Uint8Array(3)))).status, 400);
    await rejectsWith(odd.job, 'bad_request', /cannot be read here/);
    const over = await hungAudio(s, { maxMs: 1 });
    assert.equal((await over.at('pcm?at=0', raw(new Uint8Array(34)))).status, 400, 'more than the span asked for');
    await rejectsWith(over.job, 'bad_request');
    const huge = await hungAudio(s);
    assert.equal((await huge.at('pcm?at=0', raw(new Uint8Array(PCM_CHUNK_BYTES + 2)))).status, 400, 'over 1 MiB');
    await rejectsWith(huge.job, 'bad_request');

    const forged = await hungAudio(s);
    await forged.at('done', json({ durationMs: 'long' }));
    await rejectsWith(forged.job, 'bad_request', /cannot be read here/);
    const silent = await hungAudio(s);
    await silent.at('done', json({ durationMs: 0, partial: false }));
    await rejectsWith(silent.job, 'bad_request', /no sound that can be read here/);
    for (const [reason, text] of [['too-large', /over 512 MB/], ['no-audio', /no sound track/], ['toString', /format or codec/]] as const) {
      const failed = await hungAudio(s);
      await failed.at('fail', json({ reason }));
      await rejectsWith(failed.job, 'bad_request', text);
    }
  } finally { s.temp.cleanup(); }
});

test('one queue with the keyframe jobs: own waiting limit, own time, own texts after a timeout or a crash', async () => {
  const s = analyzerSetup();
  try {
    s.setMode('hang');
    const id = s.put(soundFile(sound({})));
    const jobs = [1, 2, 3, 4].map(() => s.analyzer.audio({ fileId: id }));
    for (const job of jobs) job.catch(() => undefined);
    await rejectsWith(s.analyzer.audio({ fileId: id }), 'conflict', /Several recordings/);
    const frames = s.analyzer.analyze({ fileId: id });
    frames.catch(() => undefined);
    await settle(() => s.timers.live(AUDIO_DECODE_LIMITS.jobMs) === 1);
    assert.equal(s.timers.fire(AUDIO_DECODE_LIMITS.jobMs), 1);
    await rejectsWith(jobs[0], 'timeout', /Decoding the recording took longer than 120 s/);
    await settle(() => s.windows.length === 2);
    s.windows[1].crash();
    await rejectsWith(jobs[1], 'unavailable', /sound decoder stopped/);
    s.setMode('run');
    for (const job of jobs.slice(2)) assert.equal((await job).durationMs, 5000);
    await rejectsWith(frames, 'unavailable', /video cannot be read here/); // a sound file has no picture to read (MM4 keeps its code)
    assert.equal(s.timers.live(AUDIO_DECODE_LIMITS.jobMs), 0, 'no job timer is left');
  } finally { s.temp.cleanup(); }
});
