// B-058 G8: the transcription service against providers' own request formats, through a real local HTTP
// server that parses the multipart body like the provider would: a Groq account's whisper-large-v3-turbo
// (OpenAI-compatible, json), OpenAI's gpt-transcribe ('languages[]' instead of 'language' –
// developers.openai.com speech-to-text); Groq's
// default address; media-only providers have no transcription endpoint. Not live: no key on this PC.
// Owns: these assertions only. Never: the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Transcriber, type FetchFn } from '../../../src/runtime/voice/transcribe.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';

const FILE_ID = 'e'.repeat(64);

interface Seen { path: string; auth?: string; fields: Record<string, string[]>; file?: { name: string; type: string; size: number } }

/** A local server that answers like the provider and records each parsed multipart request. */
async function server(answer: (fields: Record<string, string[]>) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const http = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
    const fields: Record<string, string[]> = {};
    let file: Seen['file'];
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') (fields[key] ??= []).push(value);
      else file = { name: value.name, type: value.type, size: value.size };
    }
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, fields, file });
    const reply = answer(fields);
    res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

function services(account: Account, model: string): RuntimeServices {
  const info: ModelInfo = { id: `${account.provider}:${model}`, provider: account.provider, model, name: model, engine: 'compatible', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [account.id], functions: ['stt'] };
  return {
    settings: { get: () => ({ voice: { vocabulary: [] }, routing: { functions: {} } }) },
    catalog: { list: () => [info] },
    accounts: { get: (id: string) => (id === account.id ? account : undefined), candidates: () => [account], apiKey: async () => 'gsk_test' },
    files: { get: (id: string) => (id === FILE_ID ? { id, mime: 'audio/webm;codecs=opus', name: 'take.webm', size: 4, createdAt: 1 } : undefined), read: async () => new Uint8Array([1, 2, 3, 4]) },
  } as unknown as RuntimeServices;
}

const account = (provider: string, baseUrl?: string): Account => ({ id: `acc_${provider}`, provider, label: provider, auth: 'api_key', ...(baseUrl ? { baseUrl } : {}), state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1 } as Account);

test('a Groq account transcribes with whisper-large-v3-turbo: json, language', async () => {
  const groq = await server(() => ({ status: 200, body: { text: ' Hallo Gerd, wie geht es dir? ', segments: [{ text: ' Hallo Gerd,', avg_logprob: -1.4, no_speech_prob: 0.01 }, { text: ' wie geht es dir?', avg_logprob: -0.1, no_speech_prob: 0.01 }] } }));
  try {
    const transcriber = new Transcriber({ services: () => services(account('groq', `${groq.base}/openai/v1`), 'whisper-large-v3-turbo') });
    const heard = await transcriber.transcribe({ fileId: FILE_ID, language: 'de-AT' });
    assert.deepEqual(heard, { text: 'Hallo Gerd, wie geht es dir?' });
    assert.equal(groq.seen.length, 1);
    const [request] = groq.seen;
    assert.equal(request.path, '/openai/v1/audio/transcriptions');
    assert.equal(request.auth, 'Bearer gsk_test');
    assert.deepEqual(request.fields, { model: ['whisper-large-v3-turbo'], response_format: ['json'], language: ['de'] });
    assert.deepEqual(request.file, { name: 'dictation.webm', type: 'audio/webm', size: 4 });
  } finally { await groq.close(); }
});

test("OpenAI's gpt-transcribe gets languages[] instead of language", async () => {
  const openai = await server(() => ({ status: 200, body: { text: 'Guten Morgen.', languages: ['de'] } }));
  try {
    for (const model of ['gpt-transcribe', 'gpt-transcribe-2026-09-30']) {
      const transcriber = new Transcriber({ services: () => services(account('openai', `${openai.base}/v1`), model) });
      assert.deepEqual(await transcriber.transcribe({ fileId: FILE_ID, language: 'de-DE' }), { text: 'Guten Morgen.' });
    }
    assert.equal(openai.seen.length, 2, 'one request each');
    for (const request of openai.seen) {
      assert.deepEqual(request.fields['languages[]'], ['de']);
      assert.equal(request.fields.language, undefined, "never both (OpenAI: \"don't send both\")");
      assert.deepEqual(request.fields.response_format, ['json']);
    }
    const whisper = new Transcriber({ services: () => services(account('openai', `${openai.base}/v1`), 'whisper-1') });
    await whisper.transcribe({ fileId: FILE_ID, language: 'de' });
    assert.deepEqual([openai.seen[2].fields.language, openai.seen[2].fields['languages[]'], openai.seen[2].fields.response_format], [['de'], undefined, ['json']], 'older models keep their fields');
  } finally { await openai.close(); }
});

test("Groq's default address; media-only providers offer no transcription endpoint", async () => {
  const urls: string[] = [];
  const fetch: FetchFn = async (url) => { urls.push(url); return new Response(JSON.stringify({ text: 'ok' })); };
  await new Transcriber({ services: () => services(account('groq'), 'whisper-large-v3-turbo'), fetch }).transcribe({ fileId: FILE_ID });
  assert.deepEqual(urls, ['https://api.groq.com/openai/v1/audio/transcriptions']);
  for (const provider of ['elevenlabs', 'fal']) {
    await assert.rejects(new Transcriber({ services: () => services(account(provider), 'scribe_v2'), fetch }).transcribe({ fileId: FILE_ID }), /offers no transcription endpoint/, provider);
  }
  assert.equal(urls.length, 1);
});
