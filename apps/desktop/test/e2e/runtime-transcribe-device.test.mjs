// End-to-end (SM9): a paired phone dictates to editable text over the real headless runtime
// (built app/runtime-cli.mjs, deterministic fake engine, real WebSocket RPC) with a device token
// from the real pairing exchange and a localhost fake OpenAI-compatible speech-to-text server,
// registered by the owner as a local 'vllm' account (like runtime-audio.test.mjs).
// Covers: the phone's session allows voice.transcribe, files.upload and models.list, and what it
// reads (models.list, settings.get) carries what the page needs to offer dictation (an available
// 'stt' model, the recognizer not on "Windows speech"); a take uploaded the way the page does
// (lib/endpoint-dictation.ts: "Dictation <time>.webm", the recorder's mime with codecs) is
// transcribed by the phone's voice.transcribe through exactly one multipart
// POST /v1/audio/transcriptions (whisper-1, json, "de" from "de-DE", the take as webm, no
// key) and the phone gets the text (unsure segments went – Umbau Einfachheit); the edited text goes out as speech
// (meta.via 'voice'); an invalid language hint is refused before anything reaches the server; a take without words comes back
// as empty text, not an error (SM9: the page adds nothing and attaches nothing).
// Owns: this flow. Never: prints the pairing secret or the device token; no real account or key.
// Run: npm run build && node --test test/e2e/runtime-transcribe-device.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect, startRuntime } from './lib/runtime-client.mjs';

const SPOKEN = 'Send the offer to Teydra by Friday.';

/** Bytes that start like a MediaRecorder webm take (EBML magic), so the runtime sniffs video/webm. */
function webmTake() {
  const take = Buffer.alloc(4096, 0x55);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]).copy(take, 0);
  return take;
}

/** The value of one multipart text field (undefined when absent). */
const field = (body, name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body)?.[1];

/**
 * Fake server: GET /v1/models lists whisper-1; POST /v1/audio/transcriptions answers verbose_json
 * with one doubtful segment, or blank text while `state.silent` (a take without words).
 */
async function fakeSpeechServer() {
  const requests = [];
  const state = { silent: false };
  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/v1/models') return reply(200, { object: 'list', data: [{ id: 'whisper-1', object: 'model' }] });
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        const file = /name="file"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n/i.exec(body);
        requests.push({
          authorization: req.headers.authorization,
          model: field(body, 'model'), format: field(body, 'response_format'), language: field(body, 'language'),
          filename: file?.[1], fileType: file?.[2], bytes: body.length,
        });
        if (state.silent) { reply(200, { text: ' ', segments: [] }); return; }
        reply(200, {
          text: SPOKEN,
          segments: [
            { id: 0, text: ' Send the offer to Teydra', avg_logprob: -1.3, no_speech_prob: 0.02 },
            { id: 1, text: ' by Friday.', avg_logprob: -0.1, no_speech_prob: 0.01 },
          ],
        });
      });
      return undefined;
    }
    return reply(404, { error: { message: 'not here' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, requests, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Pairs a phone over the real HTTP pairing route; returns its token. */
async function pair(runtime, name, access) {
  const link = await runtime.client.call('pwa.link', access ? { name, access } : { name });
  const secret = decodeURIComponent(new URL(link.url).hash.match(/pair=([^&]+)/)?.[1] ?? '');
  const exchange = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret, name } }),
  }).then((response) => response.json());
  assert.ok(exchange.result?.token, `${name}: the secret is exchanged for a device token`);
  return exchange.result.token;
}

test('a phone dictates: its take goes through the runtime to the transcription server and comes back as editable text', { timeout: 240_000 }, async (t) => {
  const speech = await fakeSpeechServer();
  t.after(() => speech.close());
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const owner = runtime.client;

  await owner.call('accounts.add', { provider: 'vllm', label: 'Local whisper', baseUrl: `http://127.0.0.1:${speech.port}/v1` });
  await owner.call('models.list', { refresh: true });
  const manager = (await owner.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds a manager');
  const chat = await owner.call('chats.create', { title: 'Offer', agentIds: [manager.id] });
  await owner.call('pwa.enable', { enabled: true, bind: 'lan' }); // B-075: no link while only this PC's loopback answers

  const phone = await connect(runtime.port, await pair(runtime, 'Dictation phone'), 'pwa');
  t.after(() => phone.close());

  await t.test('the phone may dictate and learns that it can (session, models, settings)', async () => {
    const info = await phone.call('session.info');
    assert.equal(info.kind, 'device');
    for (const method of ['voice.transcribe', 'files.upload', 'models.list']) assert.ok(info.allowedMethods.includes(method), `${method} is allowed`);
    const whisper = (await phone.call('models.list')).find((model) => model.provider === 'vllm' && model.model === 'whisper-1');
    assert.ok(whisper?.available && whisper.functions?.includes('stt'), 'an available speech-to-text model (the page offers dictation to text)');
    const settings = await phone.call('settings.get');
    assert.notEqual(settings.voice.recognizer, 'windows', 'the recognizer lets a phone use the transcription service');
    assert.equal(speech.requests.length, 0, 'nothing was transcribed yet');
  });

  let heard;
  await t.test('the uploaded take is transcribed through the runtime: one request, no key, the text comes back', async () => {
    const take = await phone.call('files.upload', { name: 'Dictation 2026-10-20 09-30.webm', mime: 'audio/webm;codecs=opus', dataBase64: webmTake().toString('base64') });
    assert.equal(take.mime, 'video/webm', 'sniffed from the bytes (a mime with codecs is only a hint)');
    assert.equal(take.name, 'Dictation 2026-10-20 09-30.webm', 'the name is kept as the page made it');
    heard = await phone.call('voice.transcribe', { fileId: take.id, language: 'de-DE' });
    assert.deepEqual(heard, { text: SPOKEN }, 'the text, nothing made up');
    assert.equal(speech.requests.length, 1);
    const [request] = speech.requests;
    assert.deepEqual(
      { model: request.model, format: request.format, language: request.language, filename: request.filename, fileType: request.fileType, authorization: request.authorization },
      { model: 'whisper-1', format: 'json', language: 'de', filename: 'dictation.webm', fileType: 'video/webm', authorization: undefined },
    );
    assert.ok(request.bytes > 4096, 'the whole take was sent');
    await assert.rejects(phone.call('voice.transcribe', { fileId: take.id, language: 'de DE' }), (error) => error.code === 'bad_request');
    assert.equal(speech.requests.length, 1, 'an invalid language hint is refused before anything is sent');
  });

  await t.test('the person edits the text and sends it as speech', async () => {
    await phone.call('events.subscribe', { topics: [`chat:${chat.id}`] });
    const edited = heard.text.replace('Teydra', 'Anna');
    const sent = await phone.call('messages.send', { conversationId: chat.id, body: edited, speech: { source: 'endpoint' } });
    assert.equal(sent.body, 'Send the offer to Anna by Friday.');
    assert.equal(sent.meta.via, 'voice');
    assert.deepEqual(sent.meta.speech, { source: 'endpoint' });
    await owner.call('messages.stop', { conversationId: chat.id }).catch(() => undefined); // the fake engine would keep answering
  });

  await t.test('a take without words comes back as empty text, not as a failure to attach', async () => {
    speech.state.silent = true;
    const take = await phone.call('files.upload', { name: 'Dictation 2026-10-20 09-31.webm', mime: 'audio/webm', dataBase64: webmTake().toString('base64') });
    assert.deepEqual(await phone.call('voice.transcribe', { fileId: take.id }), { text: '' });
    assert.equal(speech.requests.length, 2);
  });
});
