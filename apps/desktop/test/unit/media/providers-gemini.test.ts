// B-058 T6: the Gemini API adapter against a fake server answering like the documented Interactions API
// (ai.google.dev/gemini-api/docs, 29.10.2026): images, speech (WAV and raw PCM wrapped), Lyria music with lyrics,
// Omni video delivered as a Files API URI (polled until ACTIVE, then downloaded), errors, no key, the deadline.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiAdapter } from '../../../src/runtime/media/providers/gemini.ts';
import { generationPhase, mayFallBack } from '../../../src/runtime/media/generate-http.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ctx, fakeServer, KEY, MP3, MP4, PCM, PNG, send, target, WAV, type Handler } from './providers-fixture.ts';

const servers: Array<{ close(): Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

async function gemini(handle: Handler) {
  const server = await fakeServer(handle);
  servers.push(server);
  const on = (model: string, key = KEY) => target('google', `${server.origin}/v1beta/openai`, model, key);
  return { ...server, on };
}

const output = (...content: unknown[]) => ({ id: 'v1_x', status: 'completed', object: 'interaction', steps: [{ type: 'user_input', content: [{ type: 'text', text: 'x' }] }, { type: 'model_output', content }] });

test('kinds: Nano Banana images, TTS, Lyria and Omni by name; chat, Imagen and Lyria RealTime make nothing', () => {
  const kinds = (model: string) => geminiAdapter.kinds(model);
  for (const model of ['gemini-nano-banana-2.1', 'models/gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'nano-banana-pro-preview', 'gemini-2.5-flash-image']) assert.deepEqual(kinds(model), ['image'], model);
  for (const model of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-pro-preview-tts']) assert.deepEqual(kinds(model), ['speech'], model);
  for (const model of ['lyria-3.5', 'lyria-3-clip-preview', 'lyria-3-pro-preview']) assert.deepEqual(kinds(model), ['music'], model);
  assert.deepEqual(kinds('gemini-omni-1.1-flash'), ['video']);
  for (const model of ['gemini-3.8-flash', 'imagen-4.0-generate-001', 'lyria-realtime-exp', 'gemini-embedding-001']) assert.deepEqual(kinds(model), [], model);
});

test('image: the native endpoint with the key header, store off, aspect and size from the request; the last image block', async () => {
  const s = await gemini((request, res) => send(res, 200, output({ type: 'text', text: 'Here it is.' }, { type: 'image', mime_type: 'image/png', data: PNG.toString('base64') })));
  const made = await geminiAdapter.generate('image', { prompt: 'a fox', size: '2752x1536' }, s.on('models/gemini-nano-banana-2.1'), ctx());
  assert.deepEqual([made.mime, made.extension], ['image/png', 'png']);
  assert.ok(Buffer.from(made.bytes).equals(PNG));
  const [call] = s.seen;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1beta/interactions');
  assert.equal(call.headers['x-goog-api-key'], KEY);
  assert.equal(call.headers.authorization, undefined);
  assert.deepEqual(call.json, { model: 'gemini-nano-banana-2.1', input: 'a fox', response_format: { type: 'image', aspect_ratio: '16:9', image_size: '2K' }, store: false });
});

test('image: a start image goes inline; 1K-only models get no image_size; a refusal says what the model answered', async () => {
  const s = await gemini((request, res) => send(res, 200, output({ type: 'text', text: 'I cannot draw that person.' })));
  await assert.rejects(geminiAdapter.generate('image', { prompt: 'edit', size: '4096x4096', image: { bytes: PNG, mime: 'image/png' } }, s.on('gemini-3.1-flash-lite-image'), ctx()),
    (error: unknown) => error instanceof WorkforceError && /returned no image\. The model answered: "I cannot draw that person\."/.test(error.message) && generationPhase(error) === 'answered');
  assert.deepEqual(s.seen[0].json.input, [{ type: 'text', text: 'edit' }, { type: 'image', data: PNG.toString('base64'), mime_type: 'image/png' }]);
  assert.deepEqual(s.seen[0].json.response_format, { type: 'image', aspect_ratio: '1:1' });
});

test('speech: raw 24 kHz PCM from an older model is wrapped as WAV; a prebuilt voice by name; no style annotation on previews', async () => {
  const s = await gemini((request, res) => send(res, 200, output({ type: 'audio', mime_type: 'audio/l16', data: PCM.toString('base64') })));
  const made = await geminiAdapter.generate('speech', { prompt: 'Read warmly', text: 'Hallo Welt', voice: 'puck' }, s.on('gemini-3.1-flash-tts-preview'), ctx());
  assert.equal(made.mime, 'audio/wav');
  assert.equal(Buffer.from(made.bytes).subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(Buffer.from(made.bytes).readUInt32LE(24), 24_000);
  assert.equal(made.durationMs, 20);
  assert.deepEqual(s.seen[0].json, {
    model: 'gemini-3.1-flash-tts-preview', input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hallo Welt' }] }],
    response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: 'Puck' }] }, store: false,
  });
});

test('speech: 3.8 TTS WAV stays as it is; the prompt steers the delivery as speech_metadata; unknown voices fall back to Kore', async () => {
  const s = await gemini((request, res) => send(res, 200, output({ type: 'audio', mime_type: 'audio/wav', data: WAV.toString('base64') })));
  const made = await geminiAdapter.generate('speech', { prompt: 'cheerful', text: 'Guten Morgen', voice: 'alloy' }, s.on('gemini-3.8-flash-tts'), ctx());
  assert.ok(Buffer.from(made.bytes).equals(WAV));
  assert.equal(made.mime, 'audio/wav');
  assert.deepEqual(s.seen[0].json.input[0].content, [{ type: 'text', text: 'Guten Morgen', annotations: [{ type: 'speech_metadata', style: 'cheerful' }] }]);
  assert.deepEqual(s.seen[0].json.generation_config, { speech_config: [{ voice: 'Kore' }] });
});

test('music: Lyria gets lyrics and length in the prompt; MP3 back with the lyrics text as meta', async () => {
  const s = await gemini((request, res) => send(res, 200, output({ type: 'text', text: '[Verse] Hallo' }, { type: 'audio', mime_type: 'audio/mp3', data: MP3.toString('base64') })));
  const made = await geminiAdapter.generate('music', { prompt: 'German pop song', lyrics: '[Verse]\nHallo', durationS: 60 }, s.on('lyria-3.5'), ctx());
  assert.deepEqual([made.mime, made.extension, made.meta?.lyrics], ['audio/mpeg', 'mp3', '[Verse] Hallo']);
  assert.equal(s.seen[0].json.input, 'German pop song\n\nLyrics:\n[Verse]\nHallo\n\nLength: about 60 seconds.');
  assert.equal(s.seen[0].json.response_format, undefined);
});

test('video: Omni asked as a URI; the file is polled until ACTIVE and downloaded with the key on the API origin', async () => {
  let polls = 0;
  const s = await gemini((request, res, origin) => {
    if (request.path === '/v1beta/interactions') return send(res, 200, output({ type: 'video', mime_type: 'video/mp4', uri: `${origin}/v1beta/files/abc-123:download?alt=media` }));
    if (request.path === '/v1beta/files/abc-123') return send(res, 200, { name: 'files/abc-123', state: ++polls < 2 ? 'PROCESSING' : 'ACTIVE' });
    if (request.path === '/v1beta/files/abc-123:download?alt=media') return send(res, 200, MP4, 'video/mp4');
    send(res, 404, {});
  });
  const made = await geminiAdapter.generate('video', { prompt: 'a marble run', aspect: '9:16', resolution: '480p', durationS: 8 }, s.on('gemini-omni-1.1-flash'), ctx());
  assert.deepEqual([made.mime, made.extension], ['video/mp4', 'mp4']);
  assert.ok(Buffer.from(made.bytes).equals(MP4));
  assert.deepEqual(s.seen[0].json.response_format, { type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '360p' });
  assert.equal(s.seen[0].json.input, 'a marble run\n\nLength: about 8 seconds.');
  assert.deepEqual(s.seen.map((call) => call.path), ['/v1beta/interactions', '/v1beta/files/abc-123', '/v1beta/files/abc-123', '/v1beta/files/abc-123:download?alt=media']);
  for (const call of s.seen) assert.equal(call.headers['x-goog-api-key'], KEY);
});

test('video: a FAILED file and an inline video', async () => {
  const failing = await gemini((request, res, origin) => (request.path === '/v1beta/interactions'
    ? send(res, 200, output({ type: 'video', uri: `${origin}/v1beta/files/f1:download?alt=media` }))
    : send(res, 200, { name: 'files/f1', state: 'FAILED' })));
  await assert.rejects(geminiAdapter.generate('video', { prompt: 'x' }, failing.on('gemini-omni-1.1-flash'), ctx()),
    (error: unknown) => error instanceof WorkforceError && /failed while the Gemini API stored the file/.test(error.message) && generationPhase(error) === 'answered');
  const inline = await gemini((request, res) => send(res, 200, output({ type: 'video', mime_type: 'video/mp4', data: MP4.toString('base64') })));
  assert.equal((await geminiAdapter.generate('video', { prompt: 'x' }, inline.on('gemini-omni-1.1-flash'), ctx())).mime, 'video/mp4');
  assert.equal(inline.seen.length, 1);
});

test('video: an expired download is made and charged (phase answered); a foreign URI host is never asked; the deadline ends the file wait', async () => {
  const expired = await gemini((request, res) => {
    if (request.path === '/v1beta/interactions') return send(res, 200, output({ type: 'video', uri: 'https://elsewhere.example/v1beta/files/e1:download?alt=media' }));
    if (request.path === '/v1beta/files/e1') return send(res, 200, { name: 'files/e1', state: 'ACTIVE' });
    send(res, 404, {});
  });
  await assert.rejects(geminiAdapter.generate('video', { prompt: 'x' }, expired.on('gemini-omni-1.1-flash'), ctx()),
    (error: unknown) => error instanceof WorkforceError && /link may have expired/.test(error.message) && generationPhase(error) === 'answered' && !mayFallBack(error));
  assert.deepEqual(expired.seen.map((call) => call.path), ['/v1beta/interactions', '/v1beta/files/e1', '/v1beta/files/e1:download?alt=media', '/v1beta/files/e1:download?alt=media'],
    'the id is read from the URI, the request goes to the account origin (a failed download is asked once more)');
  const slow = await gemini((request, res, origin) => (request.path === '/v1beta/interactions'
    ? send(res, 200, output({ type: 'video', uri: `${origin}/v1beta/files/p1:download?alt=media` }))
    : send(res, 200, { name: 'files/p1', state: 'PROCESSING' })));
  await assert.rejects(geminiAdapter.generate('video', { prompt: 'x' }, slow.on('gemini-omni-1.1-flash'), ctx(1_200)),
    (error: unknown) => error instanceof WorkforceError && error.code === 'timeout' && generationPhase(error) === 'answered');
  assert.ok(slow.seen.filter((call) => call.path === '/v1beta/files/p1').length >= 2, 'the one file was polled with backoff');
});

test('review: passing failures of the file state (503, 500) and of the download (502) are ridden out', async () => {
  const states = [503, 500];
  let downloads = 0;
  const s = await gemini((request, res, origin) => {
    if (request.path === '/v1beta/interactions') return send(res, 200, output({ type: 'video', uri: `${origin}/v1beta/files/t1` }));
    if (request.path === '/v1beta/files/t1') return states.length ? send(res, states.shift()!, {}) : send(res, 200, { name: 'files/t1', state: 'ACTIVE' });
    if (downloads++ === 0) return send(res, 502, {});
    send(res, 200, MP4, 'video/mp4');
  });
  const made = await geminiAdapter.generate('video', { prompt: 'x' }, s.on('gemini-omni-1.1-flash'), ctx());
  assert.ok(Buffer.from(made.bytes).equals(MP4));
  assert.deepEqual(s.seen.map((call) => call.path), ['/v1beta/interactions', '/v1beta/files/t1', '/v1beta/files/t1', '/v1beta/files/t1', '/v1beta/files/t1:download?alt=media', '/v1beta/files/t1:download?alt=media']);
});

test('T6 review: a video interaction answer is capped at 64 MB (the video comes as a URI) – a larger one is refused unread, made and charged', async () => {
  const s = await gemini((_request, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(70 * 1024 * 1024) });
    res.write('{"steps":[');
  });
  await assert.rejects(geminiAdapter.generate('video', { prompt: 'x' }, s.on('gemini-omni-1.1-flash'), ctx()),
    (error: unknown) => error instanceof WorkforceError && /too large/.test(error.message) && generationPhase(error) === 'answered');
});

test('errors: 401 → reconnect (a fallback may serve), 429 on a paid-only kind → billing hint, 400 → bad request, failed status; never the body', async () => {
  const statuses = [401, 429, 400];
  const s = await gemini((request, res) => (statuses.length ? send(res, statuses.shift()!, { error: { code: 1, message: 'SECRET BODY', status: 'X' } }) : send(res, 200, { status: 'failed', steps: [] })));
  const run = () => geminiAdapter.generate('image', { prompt: 'x' }, s.on('gemini-nano-banana-2.1'), ctx());
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && mayFallBack(error) && !/SECRET/.test(error.message));
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && error.code === 'rate_limited' && /billing/.test(error.message));
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && !/SECRET/.test(error.message));
  await assert.rejects(run(), (error: unknown) => error instanceof WorkforceError && /safety filters/.test(error.message));
});

test('no saved key: a setup failure, nothing sent; the deadline ends a call that never answers', async () => {
  const s = await gemini(() => { /* never answers */ });
  await assert.rejects(geminiAdapter.generate('image', { prompt: 'x' }, s.on('gemini-nano-banana-2.1', ''), ctx()),
    (error: unknown) => error instanceof WorkforceError && /no saved key/.test(error.message) && mayFallBack(error));
  assert.equal(s.seen.length, 0);
  const started = Date.now();
  await assert.rejects(geminiAdapter.generate('music', { prompt: 'x' }, s.on('lyria-3-clip-preview'), ctx(300)),
    (error: unknown) => error instanceof WorkforceError && error.code === 'timeout' && generationPhase(error) === 'sent');
  assert.ok(Date.now() - started < 3_000);
});

test('estimateUsd: list prices of 29.10.2026', () => {
  const close = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);
  close(geminiAdapter.estimateUsd('image', { prompt: 'x' }, 'gemini-nano-banana-2.1'), 0.0346);
  close(geminiAdapter.estimateUsd('image', { prompt: 'x', size: '4096x4096' }, 'gemini-3-pro-image'), 0.241);
  close(geminiAdapter.estimateUsd('music', { prompt: 'x' }, 'lyria-3-clip-preview'), 0.04);
  close(geminiAdapter.estimateUsd('music', { prompt: 'x' }, 'lyria-3.5'), 0.08);
  close(geminiAdapter.estimateUsd('video', { prompt: 'x', durationS: 10 }, 'gemini-omni-1.1-flash'), 1.0136);
  close(geminiAdapter.estimateUsd('speech', { prompt: 'x', text: 'a'.repeat(1200) }, 'gemini-3.8-flash-tts'), 0.045);
});
