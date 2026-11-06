// B-058 T6: the fal.ai adapter against a fake queue answering like the documented API (fal.ai/docs/api-reference/
// inference-api, 29.10.2026): submit → status polled (202 IN_QUEUE / IN_PROGRESS, 200 COMPLETED) → result →
// the CDN file downloaded at once without the key; expired links, foreign job URLs, failed jobs, the deadline
// (the job is cancelled) and each curated model's input.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { falAdapter } from '../../../src/runtime/media/providers/fal.ts';
import { generationPhase, mayFallBack } from '../../../src/runtime/media/generate-http.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ctx, fakeServer, KEY, MP3, MP4, PNG, send, target, type Seen } from './providers-fixture.ts';
import type { ServerResponse } from 'node:http';

const servers: Array<{ close(): Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

interface Queue { states?: string[]; output?: (origin: string) => unknown; resultStatus?: number; file?: Buffer; fileType?: string; fileStatus?: number; statusExtra?: Record<string, unknown>; foreign?: boolean; submitStatus?: number }

/** A fake fal queue: job URLs on its own origin (or a foreign one), states in order, then the output and the file. */
async function queue(options: Queue) {
  const states = [...(options.states ?? ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'])];
  const server = await fakeServer((request: Seen, res: ServerResponse, origin: string) => {
    const app = `${origin}/owner/app/requests/req-1`;
    if (request.path.endsWith('/status')) {
      const status = states.length > 1 ? states.shift()! : states[0];
      return send(res, status === 'COMPLETED' ? 200 : 202, { status, request_id: 'req-1', ...(status === 'COMPLETED' ? options.statusExtra ?? {} : {}) });
    }
    if (request.path === '/owner/app/requests/req-1/cancel') return send(res, 202, { status: 'CANCELLATION_REQUESTED' });
    if (request.path === '/owner/app/requests/req-1') return send(res, options.resultStatus ?? 200, options.output?.(origin) ?? {});
    if (request.path.startsWith('/files/')) return options.fileStatus ? send(res, options.fileStatus, { detail: 'gone' }) : send(res, 200, options.file ?? MP4, options.fileType ?? 'application/octet-stream');
    if (request.method === 'POST') {
      if (options.submitStatus) return send(res, options.submitStatus, { detail: 'SECRET BODY' });
      const base = options.foreign ? 'https://elsewhere.example/owner/app/requests/req-1' : app;
      return send(res, 200, { status: 'IN_QUEUE', request_id: 'req-1', status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel`, queue_position: 0 });
    }
    send(res, 404, {});
  });
  servers.push(server);
  return { ...server, on: (model: string, key = KEY) => target('fal', server.origin, model, key) };
}

test('kinds: one curated model per kind (video, music, sound effects, image); speech is not offered', () => {
  assert.deepEqual(falAdapter.kinds('minimax/h3-max-turbo/text-to-video'), ['video']);
  assert.deepEqual(falAdapter.kinds('fal-ai/minimax-music/v2.6'), ['music']);
  assert.deepEqual(falAdapter.kinds('fal-ai/elevenlabs/sound-effects/v2'), ['sound']);
  assert.deepEqual(falAdapter.kinds('fal-ai/z-image/turbo'), ['image']);
  assert.deepEqual(falAdapter.kinds('fal-ai/elevenlabs/tts/eleven-v3'), []);
});

test('video: submit with Key auth, start limit and file expiry; polled until COMPLETED; the CDN file downloaded without the key', async () => {
  const q = await queue({ output: (origin) => ({ video: { url: `${origin}/files/out.mp4`, content_type: 'video/mp4' } }) });
  const made = await falAdapter.generate('video', { prompt: 'a cat', aspect: '9:16', durationS: 6, resolution: '1080p' }, q.on('minimax/h3-max-turbo/text-to-video'), ctx());
  assert.deepEqual([made.mime, made.extension, made.meta?.jobId], ['video/mp4', 'mp4', 'req-1']);
  assert.ok(Buffer.from(made.bytes).equals(MP4));
  const [submit, ...rest] = q.seen;
  assert.deepEqual([submit.method, submit.path], ['POST', '/minimax/h3-max-turbo/text-to-video']);
  assert.equal(submit.headers.authorization, `Key ${KEY}`);
  assert.ok(Number(submit.headers['x-fal-request-start-timeout']) >= 1);
  assert.deepEqual(JSON.parse(String(submit.headers['x-fal-object-lifecycle-preference'])), { expiration_duration_seconds: 3600 });
  assert.deepEqual(submit.json, { prompt: 'a cat', duration: 6, resolution: '1080P', prompt_expansion_mode: 'balanced', aspect_ratio: '9:16' });
  assert.deepEqual(rest.map((call) => call.path), ['/owner/app/requests/req-1/status', '/owner/app/requests/req-1/status', '/owner/app/requests/req-1/status', '/owner/app/requests/req-1', '/files/out.mp4']);
  for (const call of rest.slice(0, 4)) assert.equal(call.headers.authorization, `Key ${KEY}`);
  assert.equal(rest[4].headers.authorization, undefined, 'the result file link never gets the key');
});

test('video: a start image switches to image-to-video as a data URI (the canvas follows it: no aspect)', async () => {
  const q = await queue({ states: ['COMPLETED'], output: (origin) => ({ video: { url: `${origin}/files/i2v.mp4` } }) });
  await falAdapter.generate('video', { prompt: 'make it move', aspect: '16:9', image: { bytes: PNG, mime: 'image/png' } }, q.on('minimax/h3-max-turbo/text-to-video'), ctx());
  assert.equal(q.seen[0].path, '/minimax/h3-max-turbo/image-to-video');
  assert.deepEqual(q.seen[0].json, { prompt: 'make it move', duration: 5, resolution: '768P', prompt_expansion_mode: 'balanced', image_url: `data:image/png;base64,${PNG.toString('base64')}` });
});

test('an expired result link: made and charged (phase answered), the message says the link may have expired', async () => {
  const q = await queue({ states: ['COMPLETED'], fileStatus: 404, output: (origin) => ({ audio: { url: `${origin}/files/song.mp3` } }) });
  await assert.rejects(falAdapter.generate('music', { prompt: 'a happy song' }, q.on('fal-ai/minimax-music/v2.6'), ctx()),
    (error: unknown) => error instanceof WorkforceError && /link may have expired/.test(error.message) && generationPhase(error) === 'answered' && !mayFallBack(error));
});

test('job URLs on another origin are refused (they would carry the key); submit errors map safely', async () => {
  const foreign = await queue({ foreign: true });
  await assert.rejects(falAdapter.generate('image', { prompt: 'x' }, foreign.on('fal-ai/z-image/turbo'), ctx()), (error: unknown) => error instanceof WorkforceError && /unusable job/.test(error.message));
  assert.equal(foreign.seen.length, 1);
  for (const [status, check] of [[401, (e: WorkforceError) => mayFallBack(e) && /Reconnect/.test(e.message)], [429, (e: WorkforceError) => e.code === 'rate_limited'], [422, (e: WorkforceError) => e.code === 'bad_request']] as const) {
    const q = await queue({ submitStatus: status });
    await assert.rejects(falAdapter.generate('image', { prompt: 'x' }, q.on('fal-ai/z-image/turbo'), ctx()), (error: unknown) => error instanceof WorkforceError && check(error) && !/SECRET/.test(error.message));
  }
});

test('the deadline ends the wait at phase sent and cancels the job', async () => {
  const q = await queue({ states: ['IN_QUEUE'] });
  const started = Date.now();
  await assert.rejects(falAdapter.generate('video', { prompt: 'x' }, q.on('minimax/h3-max-turbo/text-to-video'), ctx(1_200)),
    (error: unknown) => error instanceof WorkforceError && error.code === 'timeout' && generationPhase(error) === 'sent');
  assert.ok(Date.now() - started < 4_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancel = q.seen.find((call) => call.path.endsWith('/cancel'));
  assert.equal(cancel?.method, 'PUT');
  assert.equal(cancel?.headers.authorization, `Key ${KEY}`);
});

test('the run stop ends the wait as cancelled', async () => {
  const q = await queue({ states: ['IN_PROGRESS'] });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  await assert.rejects(falAdapter.generate('sound', { prompt: 'x' }, q.on('fal-ai/elevenlabs/sound-effects/v2'), ctx(10_000, stop.signal)),
    (error: unknown) => error instanceof WorkforceError && error.code === 'cancelled');
});

test('a failed job: the result error (500) with the error type – nothing made; a refused input (422) stays a bad request', async () => {
  const failed = await queue({ states: ['COMPLETED'], statusExtra: { error: 'runner crashed', error_type: 'runner_disconnected' }, resultStatus: 500 });
  await assert.rejects(falAdapter.generate('sound', { prompt: 'x' }, failed.on('fal-ai/elevenlabs/sound-effects/v2'), ctx()),
    (error: unknown) => error instanceof WorkforceError && error.message === 'Sound effect generation failed on fal.ai (runner_disconnected).' && generationPhase(error) === undefined);
  const refused = await queue({ states: ['COMPLETED'], statusExtra: { error: 'bad input' }, resultStatus: 422 });
  await assert.rejects(falAdapter.generate('sound', { prompt: 'x' }, refused.on('fal-ai/elevenlabs/sound-effects/v2'), ctx()), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('inputs: music with lyrics or instrumental, sound effects clamped to 22 s, image size from WIDTHxHEIGHT', async () => {
  const q = await queue({ states: ['COMPLETED'], output: (origin) => ({ audio: { url: `${origin}/files/a.mp3` }, images: [{ url: `${origin}/files/i.png`, content_type: 'image/png' }] }), file: MP3, fileType: 'audio/mpeg' });
  const song = await falAdapter.generate('music', { prompt: 'Schlager', lyrics: '[Chorus]\nLa la la' }, q.on('fal-ai/minimax-music/v2.6'), ctx());
  assert.deepEqual([song.mime, song.extension], ['audio/mpeg', 'mp3']);
  assert.deepEqual(q.seen[0].json, { prompt: 'Schlager, a song', lyrics: '[Chorus]\nLa la la', is_instrumental: false, lyrics_optimizer: false });
  await falAdapter.generate('music', { prompt: 'calm piano for studying', lyrics: 'x', instrumental: true }, q.on('fal-ai/minimax-music/v2.6'), ctx());
  assert.deepEqual(q.seen.filter((call) => call.method === 'POST')[1].json, { prompt: 'calm piano for studying', is_instrumental: true, lyrics_optimizer: false });
  await falAdapter.generate('music', { prompt: 'an upbeat summer song' }, q.on('fal-ai/minimax-music/v2.6'), ctx());
  assert.equal(q.seen.filter((call) => call.method === 'POST')[2].json.lyrics_optimizer, true, 'no lyrics: fal writes them');
  await falAdapter.generate('sound', { prompt: 'door creak', durationS: 30, loop: true }, q.on('fal-ai/elevenlabs/sound-effects/v2'), ctx());
  assert.deepEqual(q.seen.filter((call) => call.method === 'POST')[3].json, { text: 'door creak', output_format: 'mp3_44100_128', duration_seconds: 22, loop: true });
  const image = await queue({ states: ['COMPLETED'], output: (origin) => ({ images: [{ url: `${origin}/files/i.png`, content_type: 'image/png' }] }), file: PNG });
  const made = await falAdapter.generate('image', { prompt: 'a lighthouse', size: '1536x1024' }, image.on('fal-ai/z-image/turbo'), ctx());
  assert.deepEqual([made.mime, made.extension], ['image/png', 'png']);
  assert.deepEqual(image.seen[0].json, { prompt: 'a lighthouse', image_size: { width: 1536, height: 1024 }, num_images: 1, output_format: 'png', enable_safety_checker: true });
});

/** B-058 review: a fake queue whose status and result answer `fails` times with an HTTP error first. */
async function flaky(fails: { status: number[]; result: number[] }) {
  const server = await fakeServer((request: Seen, res: ServerResponse, origin: string) => {
    const app = `${origin}/owner/app/requests/req-9`;
    if (request.method === 'POST') return send(res, 200, { status: 'IN_QUEUE', request_id: 'req-9', status_url: `${app}/status`, response_url: app, cancel_url: `${app}/cancel` });
    if (request.path.endsWith('/cancel')) return send(res, 202, {});
    if (request.path.endsWith('/status')) return fails.status.length ? send(res, fails.status.shift()!, { detail: 'busy' }) : send(res, 200, { status: 'COMPLETED', request_id: 'req-9' });
    if (request.path === '/owner/app/requests/req-9') return fails.result.length ? send(res, fails.result.shift()!, { detail: 'busy' }) : send(res, 200, { video: { url: `${origin}/files/v.mp4` } });
    send(res, 200, MP4, 'video/mp4');
  });
  servers.push(server);
  return { ...server, on: (model: string) => target('fal', server.origin, model) };
}

test('review: a paid job survives passing failures – status 503/429/502 are ridden out, a made result is asked once more', async () => {
  const q = await flaky({ status: [503, 429, 502], result: [502] });
  const made = await falAdapter.generate('video', { prompt: 'a cat' }, q.on('minimax/h3-max-turbo/text-to-video'), ctx());
  assert.ok(Buffer.from(made.bytes).equals(MP4));
  assert.equal(q.seen.filter((call) => call.path.endsWith('/status')).length, 4);
  assert.equal(q.seen.filter((call) => call.path === '/owner/app/requests/req-9').length, 2);
  assert.equal(q.seen.some((call) => call.path.endsWith('/cancel')), false, 'never cancelled');
});

test('review: a status that keeps failing ends the wait after three passing failures and cancels the job', async () => {
  const q = await flaky({ status: [503, 503, 503, 503, 503], result: [] });
  await assert.rejects(falAdapter.generate('video', { prompt: 'a cat' }, q.on('minimax/h3-max-turbo/text-to-video'), ctx()),
    (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && generationPhase(error) === 'sent' && !mayFallBack(error));
  assert.equal(q.seen.filter((call) => call.path.endsWith('/status')).length, 4);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(q.seen.some((call) => call.path.endsWith('/cancel')));
});

test('review: a flagged Z-Image result (black image) is refused, never downloaded; a very short music prompt reaches 10 characters', async () => {
  const flagged = await queue({ states: ['COMPLETED'], output: (origin) => ({ images: [{ url: `${origin}/files/black.png` }], has_nsfw_concepts: [true] }), file: PNG });
  await assert.rejects(falAdapter.generate('image', { prompt: 'x' }, flagged.on('fal-ai/z-image/turbo'), ctx()),
    (error: unknown) => error instanceof WorkforceError && /safety checker/.test(error.message) && generationPhase(error) === 'answered');
  assert.equal(flagged.seen.some((call) => call.path.startsWith('/files/')), false);
  const song = await queue({ states: ['COMPLETED'], output: (origin) => ({ audio: { url: `${origin}/files/a.mp3` } }), file: MP3 });
  await falAdapter.generate('music', { prompt: 'a' }, song.on('fal-ai/minimax-music/v2.6'), ctx());
  assert.equal(song.seen[0].json.prompt, 'a, a short song');
});

test('estimateUsd: list prices of 29.10.2026 (H3 after the promotion)', () => {
  const close = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  close(falAdapter.estimateUsd('video', { prompt: 'x' }, 'minimax/h3-max-turbo/text-to-video'), 0.04 * 5.7);
  close(falAdapter.estimateUsd('video', { prompt: 'x', resolution: '480p', durationS: 10 }, 'minimax/h3-max-turbo/text-to-video'), 0.025 * 10.7);
  close(falAdapter.estimateUsd('music', { prompt: 'x' }, 'fal-ai/minimax-music/v2.6'), 0.15);
  close(falAdapter.estimateUsd('sound', { prompt: 'x', durationS: 5 }, 'fal-ai/elevenlabs/sound-effects/v2'), 0.01);
  close(falAdapter.estimateUsd('image', { prompt: 'x' }, 'fal-ai/z-image/turbo'), 0.01);
});
