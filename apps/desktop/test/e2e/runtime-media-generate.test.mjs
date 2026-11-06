// End-to-end (MM3): agents create images and speech over the real headless runtime (built
// app/runtime-cli.mjs, deterministic fake engine, real WebSocket RPC) with a localhost fake
// OpenAI-compatible media server, registered as a local 'vllm' account (free: no spend gate, no
// key). Its /models listing ("gpt-image-1", "tts-1") makes them the image and speech function
// models.
// Covers: media.image → one POST /v1/images/generations (base64 answer; no response_format for a
// GPT image model), the PNG stored in the media
// library linked to the chat with tag "generated" and a ```ui media block in the result;
// media.speak → one POST /v1/audio/speech in the agent's voice (agents.update voice), the mp3
// stored the same way; both files are listed by media.list for that chat.
// Run: npm run build && node --test test/e2e/runtime-media-generate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRuntime } from './lib/runtime-client.mjs';

/** A 2×1 PNG (signature + IHDR is enough for the sniffers). */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0])]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 7)]);

async function fakeMediaServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'gpt-image-1', object: 'model' }, { id: 'tts-1', object: 'model' }] });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (req.method === 'POST' && req.url === '/v1/images/generations') return json(200, { data: [{ b64_json: PNG.toString('base64') }] });
      if (req.method === 'POST' && req.url === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(MP3); }
      return json(404, { error: { message: 'not here' } });
    });
    return undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

test('agents create an image and speech; both land in the chat\'s media library', { timeout: 240_000 }, async (t) => {
  const media = await fakeMediaServer();
  t.after(() => media.close());
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;

  await client.call('accounts.add', { provider: 'vllm', label: 'Local media', baseUrl: `http://127.0.0.1:${media.port}/v1` });
  const models = await client.call('models.list', { refresh: true });
  const fns = (name) => models.find((model) => model.provider === 'vllm' && model.model === name)?.functions;
  assert.deepEqual(fns('gpt-image-1'), ['image'], JSON.stringify(models.map((model) => model.id)));
  assert.deepEqual(fns('tts-1'), ['tts']);

  const manager = (await client.call('agents.list')).find((agent) => agent.template === 'manager');
  assert.ok(manager, 'the first run seeds a manager');
  const updated = await client.call('agents.update', { id: manager.id, patch: { voice: 'nova' } });
  assert.equal(updated.voice, 'nova');
  const chat = await client.call('chats.create', { title: 'Launch assets', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });

  await client.call('messages.send', { conversationId: chat.id, body: 'Make the cover [[tool:media.image {"prompt":"A calm blue wave logo","quality":"low"}]]' });
  const drawn = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /media\.image → /), 120_000);
  const image = /"fileId":"([a-f0-9]{64})"/.exec(drawn.body)?.[1];
  assert.ok(image, drawn.body);
  assert.match(drawn.body, /```ui/);

  await client.call('messages.send', { conversationId: chat.id, body: 'Now the voice-over [[tool:media.speak {"text":"Welcome to the launch."}]]' });
  const spoken = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /media\.speak → /), 120_000);
  const audio = /"fileId":"([a-f0-9]{64})"/.exec(spoken.body)?.[1];
  assert.ok(audio, spoken.body);

  const posts = media.requests.filter((request) => request.method === 'POST');
  assert.deepEqual(posts.map((request) => request.url), ['/v1/images/generations', '/v1/audio/speech']);
  assert.equal(posts[0].body.response_format, undefined, 'GPT image models answer base64 and refuse the field');
  assert.equal(posts[0].body.model, 'gpt-image-1');
  assert.equal(posts[1].body.voice, 'nova', 'the agent\'s voice');
  assert.equal(posts[1].body.input, 'Welcome to the launch.');
  assert.ok(posts.every((request) => request.authorization === undefined), 'a keyless local server gets no key');

  const listed = await client.call('media.list', { conversationId: chat.id });
  const byId = new Map(listed.map((info) => [info.fileId, info]));
  assert.equal(byId.get(image)?.kind, 'image');
  assert.equal(byId.get(image)?.mime, 'image/png');
  assert.deepEqual(byId.get(image)?.tags, ['generated', 'image']);
  assert.equal(byId.get(audio)?.kind, 'audio');
  assert.deepEqual(byId.get(audio)?.tags, ['generated', 'speech']);
  assert.match(byId.get(audio)?.description ?? '', /voice nova/);
});
