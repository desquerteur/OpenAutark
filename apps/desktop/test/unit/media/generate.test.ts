// Media generation (MM3, B-058 dispatcher media/generate.ts + the OpenAI-compatible adapter providers/openai.ts
// + media.image / media.speak): image and speech requests with a fake fetch (b64 PNG, mp3; GPT image models get
// no response_format, others are asked for b64_json), the limits (base64 only, PNG/JPEG/WebP, ≤ 4096 characters
// of speech, redirects refused), user-safe failures without the key, the target pick with a clear error naming
// the setting or the key; OpenAI's speech models end on 06.01.2027; and the tools against a local 127.0.0.1
// server: the file is stored, described with tag 'generated' and linked to the run's chat, a ```ui media block
// comes back, media.speak uses the agent's voice, and a pay-per-use account turns the call into an estimated USD
// spend (marked usdEstimate) for the permission/budget gate that is booked on the agent afterwards.
// Stops, timeouts, unjudged accounts and storage rules: generate-safety.test.ts; fallbacks: generate-routes.test.ts.
// Owns: these assertions only. Never: a real provider or the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsd, generateMedia, imageMime, mediaTarget, type FetchFn, type GenerateServices } from '../../../src/runtime/media/generate.ts';
import { GENERATED_MAX_BYTES, mayFallBack } from '../../../src/runtime/media/generate-http.ts';
import { speechRetired } from '../../../src/runtime/media/providers/openai.ts';
import { MediaRepo } from '../../../src/runtime/media/repo.ts';
import { cleanVoice } from '../../../src/runtime/org/validate.ts';
import { AgentRepo } from '../../../src/runtime/store/agents.ts';
import { png } from './fixtures.ts';
import { account, call, imageAnswer, KEY, listen, MP3, recorder, services, textOf, tool, toolSetup } from './generate-fixture.ts';

test('image: b64_json PNG from /images/generations with the key, size and quality; nothing else accepted', async () => {
  const s = services([account('acc_oa', 'api_key', 'https://api.example.test/v1')]);
  const target = mediaTarget(s, 'image');
  assert.equal(target.paid, true);
  const { calls, fetch } = recorder(() => imageAnswer(png(64, 32), { revised_prompt: 'A red fox, snow' }));
  const made = await generateMedia(s, target, { prompt: ' A red fox in snow ', size: '1024x1024', quality: 'low' }, { fetch });
  assert.equal(made.mime, 'image/png');
  assert.equal(made.extension, 'png');
  assert.equal(made.meta?.revisedPrompt, 'A red fox, snow');
  assert.equal(calls[0].url, 'https://api.example.test/v1/images/generations');
  assert.deepEqual(calls[0].body, { model: 'gpt-image-1', prompt: 'A red fox in snow', n: 1, size: '1024x1024', quality: 'low' }, 'GPT image models refuse response_format (they always answer base64)');
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].redirect, 'error', 'redirects are refused');

  const refuse = async (response: Response, pattern: RegExp, fallback = false) => {
    const error = await generateMedia(s, target, { prompt: 'x' }, { fetch: async () => response }).then(() => undefined, (cause: Error) => cause);
    assert.ok(error, `${pattern} should fail`);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(KEY), 'never the key');
    assert.equal(mayFallBack(error), fallback, `${pattern}: another route ${fallback ? 'may' : 'may not'} serve`);
  };
  await refuse(new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/x.png' }] })), /no image \(only base64 answers/);
  await refuse(imageAnswer(Buffer.from('<html>not an image</html>')), /not a PNG, JPEG or WebP/);
  await refuse(new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }), /rejected the image generation account/, true);
  await refuse(new Response('gone', { status: 404 }), /model or endpoint was not found \(HTTP 404\)/, true);
  await refuse(new Response('slow down', { status: 429 }), /limit of the provider was reached/, true);
  await refuse(new Response('nope', { status: 400 }), /did not accept the request \(HTTP 400\)/);
  await refuse(new Response('x'.repeat(100), { headers: { 'content-length': String(GENERATED_MAX_BYTES.image * 2) } }), /answer is too large/);
  await assert.rejects(generateMedia(s, target, { prompt: '   ' }, { fetch }), /Describe the image/);
  assert.equal(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
});

test('image: dall-e and other compatible models are asked for b64_json (they answer with a URL otherwise)', async () => {
  for (const name of ['dall-e-3', 'flux-schnell']) {
    const s = services([account('acc_local', 'local', 'http://127.0.0.1:9100/v1')], {}, name);
    const { calls, fetch } = recorder(() => imageAnswer(png(8, 8)));
    await generateMedia(s, mediaTarget(s, 'image'), { prompt: 'A wave' }, { fetch });
    assert.equal(calls[0].body.response_format, 'b64_json', name);
  }
  const s = services([account('acc_local', 'local', 'http://127.0.0.1:9100/v1')], {}, 'openai/gpt-image-1.5');
  const { calls, fetch } = recorder(() => imageAnswer(png(8, 8)));
  await generateMedia(s, mediaTarget(s, 'image'), { prompt: 'A wave' }, { fetch });
  assert.equal(Object.hasOwn(calls[0].body, 'response_format'), false, 'a prefixed GPT image model id too');
});

test('speech: mp3 from /audio/speech; voice default; over 4096 characters is refused before any request', async () => {
  const s = services([account('acc_local', 'local', 'http://127.0.0.1:9100/v1')]);
  const target = mediaTarget(s, 'tts');
  assert.equal(target.kind, 'speech');
  assert.equal(target.paid, false);
  const { calls, fetch } = recorder(() => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }));
  const made = await generateMedia(s, target, { prompt: '', text: 'Welcome to the team.', voice: 'nova' }, { fetch });
  assert.equal(made.mime, 'audio/mpeg');
  assert.equal(made.bytes.byteLength, MP3.byteLength);
  assert.equal(calls[0].url, 'http://127.0.0.1:9100/v1/audio/speech');
  assert.deepEqual(calls[0].body, { model: 'tts-1', input: 'Welcome to the team.', response_format: 'mp3', voice: 'nova' });
  assert.equal(calls[0].headers.Authorization, undefined, 'a keyless local server gets no Authorization header');
  await generateMedia(s, target, { prompt: '', text: 'Hi', format: 'wav' }, { fetch: async (url, init) => { await fetch(url, init); return new Response(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8), Buffer.from('WAVE'), Buffer.alloc(32)]), { headers: { 'content-type': 'audio/wav' } }); } });
  assert.equal(calls[1].body.voice, 'alloy');
  assert.equal(calls[1].body.response_format, 'wav');
  await assert.rejects(generateMedia(s, target, { prompt: '', text: 'a'.repeat(4097) }, { fetch }), /limited to 4096 characters/);
  assert.equal(calls.length, 2);
  await assert.rejects(generateMedia(s, target, { prompt: '', text: 'Hi' }, { fetch: async () => new Response('{"error":"x"}', { headers: { 'content-type': 'application/json' } }) }), /returned no audio/);
  // a request that never answers: rejects once its signal aborts (also when it already has)
  const hanging: FetchFn = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal!.aborted) reject(new Error('aborted'));
    init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const early = new AbortController();
  const stoppedEarly = generateMedia(s, target, { prompt: '', text: 'Hi' }, { signal: early.signal, fetch: hanging });
  early.abort(); // before the request went out
  await assert.rejects(stoppedEarly, /Stopped/);
  const late = new AbortController();
  const stoppedLate = generateMedia(s, target, { prompt: '', text: 'Hi' }, { signal: late.signal, fetch: (url, init) => { setImmediate(() => late.abort()); return hanging(url, init); } });
  await assert.rejects(stoppedLate, /Stopped/);
  await assert.rejects(generateMedia(s, target, { prompt: '', text: 'Hi' }, { timeoutMs: 20, fetch: hanging }), /timed out after 1 s/);
});

test('OpenAI\'s own speech models end on 06.01.2027: refused before sending, so another route may serve', async () => {
  const day = Date.UTC(2027, 0, 6);
  assert.equal(speechRetired('openai', 'tts-1', day - 1), false, 'fine while they work');
  for (const name of ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15', 'openai/tts-1']) assert.equal(speechRetired('openai', name, day), true, name);
  assert.equal(speechRetired('vllm', 'tts-1', day), false, 'a compatible server serving the same name is not affected');
  assert.equal(speechRetired('openai', 'gpt-realtime-2.1-mini', day), false);
});

test('mediaTarget: off, a chosen model gone or nothing set up → a clear error naming the setting or the key; CLI accounts have no endpoint', () => {
  const none = { ...services([account('acc_local', 'local', 'http://127.0.0.1:9100/v1')]), catalog: { list: () => [], get: () => undefined } } as unknown as GenerateServices;
  assert.throws(() => mediaTarget(none, 'image'), /Image generation is not set up: sign in to Codex with a ChatGPT plan, or add an OpenAI or Gemini API key \(Settings › Models\)/);
  assert.throws(() => mediaTarget(none, 'tts'), /Speech generation is not set up: download the local voice/);
  assert.throws(() => mediaTarget(none, 'music'), /Music generation is not set up: add a Gemini API key, an ElevenLabs key or a fal\.ai key/);
  assert.throws(() => mediaTarget(none, 'sound'), /Sound effect generation is not set up: add an ElevenLabs key or a fal\.ai key/);
  assert.throws(() => mediaTarget(none, 'video'), /Video generation is not set up: add a Gemini API key or a fal\.ai key/);
  assert.throws(() => mediaTarget(services([account('acc_local', 'local', 'http://127.0.0.1:9100/v1')], { image: 'off' }), 'image'), /Image generation is turned off/);
  assert.throws(() => mediaTarget({ ...none, settings: { get: () => ({ routing: { functions: { tts: 'gone:model' } } }) } } as unknown as GenerateServices, 'tts'), /chosen speech generation model is not available/);
  assert.throws(() => mediaTarget(services([account('acc_cli', 'cli', 'https://x.example', 'codex')], {}, 'gpt-image-1', [
    { id: 'codex:gpt-image-x', provider: 'codex', model: 'gpt-image-x', engine: 'codex', available: true, accounts: ['acc_cli'], functions: ['image'], tier: 'local', efforts: [], caps: {}, strengths: {}, name: 'x' } as never,
  ]), 'image'), /offers no image generation endpoint/);
  assert.throws(() => mediaTarget(services([account('acc_oa', 'api_key', 'https://api.example.test/v1')], {}, 'gpt-image-1', [
    { id: 'openai:some-music', provider: 'openai', model: 'some-music', engine: 'compatible', available: true, accounts: ['acc_oa'], functions: ['music'], tier: 'local', efforts: [], caps: {}, strengths: {}, name: 'x' } as never,
  ]), 'music'), /openai:some-music makes no music through this provider: add a Gemini API key/, 'OpenAI-compatible endpoints make no music');
  assert.equal(estimateUsd({ paid: false }, { kind: 'image' }), undefined, 'free connections cost nothing');
  assert.equal(estimateUsd({ paid: true }, { kind: 'image', quality: 'high' }), 0.25);
  assert.equal(estimateUsd({ paid: true }, { kind: 'speech', chars: 4000 }), 0.12);
  assert.equal(estimateUsd({ paid: true }, { kind: 'speech', chars: 10 }), 0.01, 'at least one cent');
});

// ---------------------------------------------------------------- the tools against 127.0.0.1

test('media.image (free local model): stored, described with tag "generated", linked to the run\'s chat, a ui block back', async () => {
  const fake = await listen(() => ({ type: 'application/json', body: JSON.stringify({ data: [{ b64_json: Buffer.from(png(48, 24)).toString('base64') }] }) }));
  const t = toolSetup([account('acc_local', 'local', fake.base)]);
  try {
    const { action, out } = await call('media.image', { prompt: 'Logo: a calm blue wave', quality: 'medium' }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    const result = out.structured as { fileId: string; mime: string; ui: string; model: string };
    assert.equal(result.mime, 'image/png');
    assert.match(result.ui, /^```ui\n\{"type":"media","fileId":"[a-f0-9]{64}","kind":"image"\}\n```$/);
    assert.equal(fake.seen[0].path, '/v1/images/generations');
    assert.equal(fake.seen[0].auth, undefined);
    const row = new MediaRepo(t.h.db).get(result.fileId)!;
    assert.equal(row.conversationId, t.chat.id, 'linked to the run\'s chat');
    assert.deepEqual(row.tags, ['generated', 'image']);
    assert.match(row.description ?? '', /^Generated image \(vllm:gpt-image-1\): Logo: a calm blue wave/);
    assert.equal(row.describedBy, 'ag_ada');
    assert.equal(row.name, 'logo-a-calm-blue-wave.png');
    assert.equal(t.spends.length, 0, 'nothing booked for a free model');
  } finally { fake.server.close(); t.temp.cleanup(); }
});

test('the tools without a model fail with what to add; agent voices are validated and stored', async () => {
  const t = toolSetup([account('acc_local', 'local', 'http://127.0.0.1:9/v1')]);
  try {
    Object.assign(t.h.services, { catalog: { list: () => [], get: () => undefined } });
    const { action, out } = await call('media.image', { prompt: 'A chart' }, t.ctx());
    assert.equal(out.isError, true);
    assert.match(textOf(out), /Image generation is not set up: sign in to Codex/);
    const speech = (await call('media.speak', { text: 'Hi' }, t.ctx())).out;
    assert.match(textOf(speech), /Speech generation is not set up: the local voice cannot run on this PC; add a Gemini API key or an ElevenLabs key/);
    assert.throws(() => cleanVoice('nova; rm -rf'), /Enter a voice name/);
    assert.equal(cleanVoice(' en-US-Ava '), 'en-US-Ava');
    // migration 007: the voice is stored with the agent
    const repo = new AgentRepo(t.h.db);
    repo.save({ ...t.h.org.require('ag_ada'), voice: 'shimmer' });
    assert.equal(repo.get('ag_ada')?.voice, 'shimmer');
    repo.save({ ...t.h.org.require('ag_ada'), voice: undefined });
    assert.equal(repo.get('ag_ada')?.voice, undefined);
  } finally { t.temp.cleanup(); }
});
