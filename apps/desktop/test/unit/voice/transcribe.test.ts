// Transcription request building and error handling with a fake fetch (no network); model and
// account come from the speech-to-text function model (catalog specialist or Settings choice).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioExtension, FRESH_TAKE_MS, HEARD_TAKE_HOLD_MS, languageCode, MAX_AUDIO_BYTES, Transcriber, type FetchFn } from '../../../src/runtime/voice/transcribe.ts';
import { vocabularyPrompt, vocabularyWords } from '../../../src/shared/voice/vocabulary.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const FILE_ID = 'c'.repeat(64);

function account(patch: Partial<Account> = {}): Account {
  return { id: 'acc_1', provider: 'compatible', label: 'Groq', auth: 'api_key', baseUrl: 'https://api.groq.example/openai/v1/', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1, ...patch } as Account;
}

/** Catalog entry of a speech-to-text specialist served by the account. */
function sttModel(acc: Account, model: string): ModelInfo {
  return { id: `${acc.provider}:${model}`, provider: acc.provider, model, name: model, engine: 'compatible', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [acc.id], functions: ['stt'] };
}

/** Fake services shaped like functions.ts reads them: catalog, candidates (enabled accounts), settings. */
function fakeServices(input: { acc?: Account; model: string; functions: Record<string, string>; voice: Record<string, unknown>; key?: string; files: unknown }): RuntimeServices {
  const { acc } = input;
  return {
    settings: { get: () => ({ voice: input.voice, routing: { functions: input.functions } }) },
    catalog: { list: () => (acc ? [sttModel(acc, input.model)] : []) },
    accounts: { get: (id: string) => (acc && id === acc.id ? acc : undefined), candidates: () => (acc?.enabled ? [acc] : []), apiKey: async () => input.key ?? 'sk-test-key-123' },
    files: input.files,
  } as unknown as RuntimeServices;
}

function setup(options: { account?: Account | undefined; model?: string; functions?: Record<string, string>; voice?: Record<string, unknown>; file?: { mime: string; name: string; size: number }; key?: string; respond?: (url: string, init: RequestInit) => Response | Promise<Response> } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const acc = 'account' in options ? options.account : account();
  const file = options.file ?? { mime: 'audio/webm;codecs=opus', name: 'recording.webm', size: 5 };
  const services = fakeServices({
    acc, model: options.model ?? 'whisper-large-v3', functions: options.functions ?? {}, key: options.key,
    voice: { vocabulary: [{ term: 'Workforce' }, 'Teydra', { term: 'Workforce' }], ...options.voice },
    files: { get: (id: string) => (id === FILE_ID ? { id, createdAt: 1, ...file } : undefined), read: async () => new Uint8Array([1, 2, 3, 4, 5]) },
  });
  const fetch: FetchFn = async (url, init) => {
    requests.push({ url, init });
    return options.respond ? options.respond(url, init) : new Response(JSON.stringify({ text: ' Hello Workforce ' }), { status: 200 });
  };
  return { transcriber: new Transcriber({ services: () => services, fetch }), requests, services };
}

test('builds the multipart request like the legacy dictation: model, json, language, vocabulary, no redirects', async () => {
  const { transcriber, requests } = setup({ functions: { stt: 'compatible:whisper-large-v3' } });
  const result = await transcriber.transcribe({ fileId: FILE_ID, language: 'de-DE' });
  assert.deepEqual(result, { text: 'Hello Workforce' });
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, 'https://api.groq.example/openai/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { Authorization: 'Bearer sk-test-key-123' });
  assert.ok(init.signal instanceof AbortSignal);
  const form = init.body as FormData;
  assert.equal(form.get('model'), 'whisper-large-v3');
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.get('language'), 'de');
  assert.equal(form.get('prompt'), 'Workforce, Teydra');
  const file = form.get('file') as File;
  assert.equal(file.name, 'dictation.webm');
  assert.equal(file.type, 'audio/webm');
  assert.equal(file.size, 5);

  // Without a choice: the first connected speech-to-text model of a local server.
  const defaults = setup({ voice: { vocabulary: [] }, model: 'whisper-1', account: account({ provider: 'ollama', baseUrl: 'http://127.0.0.1:8080/v1' }) });
  await defaults.transcriber.transcribe({ fileId: FILE_ID });
  assert.equal(defaults.requests[0].url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
  const form2 = defaults.requests[0].init.body as FormData;
  assert.equal(form2.get('model'), 'whisper-1');
  assert.equal(form2.get('language'), null);
  assert.equal(form2.get('prompt'), null);
});

test('the key never comes back in the text; errors are clear and user-safe', async () => {
  const echo = setup({ respond: () => new Response(JSON.stringify({ text: 'my key is sk-test-key-123' })) });
  assert.deepEqual(await echo.transcriber.transcribe({ fileId: FILE_ID }), { text: 'my key is [redacted]' });

  const code = async (options: Parameters<typeof setup>[0], input = { fileId: FILE_ID }) => {
    try { await setup(options).transcriber.transcribe(input); return 'ok'; } catch (error) { assert.ok(error instanceof WorkforceError, String(error)); return `${error.code}: ${error.message}`; }
  };
  assert.match(await code({ account: undefined }), /^unavailable: Speech to text is not set up yet: this PC downloads its speech model/);
  assert.match(await code({ functions: { stt: 'off' } }), /^unavailable: Speech to text is turned off/);
  assert.match(await code({ account: undefined, functions: { stt: 'openai:whisper-1' } }), /^unavailable: The chosen speech-to-text model is not available/);
  assert.match(await code({ account: account({ provider: 'anthropic', baseUrl: undefined }) }), /^bad_request: This account offers no transcription endpoint/);
  assert.match(await code({ account: account({ enabled: false }) }), /^unavailable: Speech to text is not set up/);
  assert.match(await code({ account: account({ baseUrl: 'http://evil.example/v1' }) }), /^bad_request: Use an HTTPS server URL/);
  assert.match(await code({}, { fileId: 'd'.repeat(64) }), /^not_found: The recording was not found/);
  assert.match(await code({ file: { mime: 'image/png', name: 'x.png', size: 5 } }), /cannot be transcribed/);
  assert.match(await code({ file: { mime: 'audio/ogg', name: 'x.ogg', size: MAX_AUDIO_BYTES + 1 } }), /smaller than 25 MB/, 'nothing here decodes it');
  // B-058: a WAV over 25 MB goes up decoded (transcribe-long.test.ts) – these five bytes are no WAV.
  assert.match(await code({ file: { mime: 'audio/wav', name: 'x.wav', size: MAX_AUDIO_BYTES + 1 } }), /^bad_request: This recording cannot be read/);
  assert.match(await code({ file: { mime: 'audio/ogg', name: 'x.ogg', size: 0 } }), /^bad_request: The recording is empty/);
  assert.match(await code({ respond: () => new Response('{"error":{"message":"bad key sk-test-key-123"}}', { status: 401 }) }), /^unavailable: The transcription provider rejected the account/);
  assert.match(await code({ respond: () => new Response('', { status: 429 }) }), /^rate_limited:/);
  assert.match(await code({ respond: () => new Response('nope', { status: 400 }) }), /did not accept the audio\. Check the speech-to-text model/);
  assert.match(await code({ respond: () => new Response('not json') }), /invalid answer/);
  assert.match(await code({ respond: () => new Response(JSON.stringify({ text: 'a\u0000b' })) }), /^unavailable: The transcription returned no usable text/);
  assert.match(await code({ respond: () => new Response(JSON.stringify({ text: 'x'.repeat(100_001) })) }), /no usable text/);
  assert.match(await code({ respond: () => { throw new TypeError('fetch failed'); } }), /^unavailable: Could not reach/);
  const message = await code({ respond: () => new Response('{"error":"sk-test-key-123"}', { status: 500 }) });
  assert.equal(message.includes('sk-test-key-123'), false);
});

test('timeouts abort the request', async () => {
  const { requests } = setup();
  const slow = new Transcriber({
    services: () => fakeServices({
      acc: account(), model: 'whisper-1', functions: {}, voice: { vocabulary: [] },
      files: { get: () => ({ id: FILE_ID, mime: 'audio/ogg', name: 'a.ogg', size: 3, createdAt: 1 }), read: async () => new Uint8Array(3) },
    }),
    timeoutMs: 20,
    fetch: (_url, init) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('aborted'))); }),
  });
  await assert.rejects(slow.transcribe({ fileId: FILE_ID }), (error: unknown) => error instanceof WorkforceError && error.code === 'timeout');
  assert.equal(requests.length, 0);
});

test('format, language and vocabulary helpers', () => {
  assert.equal(audioExtension('audio/mp4', 'x'), 'm4a');
  assert.equal(audioExtension('application/octet-stream', 'memo.MP3'), 'mp3');
  assert.equal(audioExtension('text/plain', 'notes.txt'), undefined);
  assert.equal(languageCode('en-US'), 'en');
  assert.equal(languageCode(''), undefined);
  assert.equal(vocabularyPrompt([]), undefined);
  assert.equal(vocabularyPrompt(Array.from({ length: 200 }, (_v, i) => `term${i}`))!.length <= 800, true);
  assert.deepEqual(vocabularyWords(['Kling', { term: ' Teydra ' }, 'Kling', '', 42, { term: 'x'.repeat(81) }]), ['Kling', 'Teydra'], 'newest first, both shapes, no duplicates');
});

test('a failing key lookup sends no Authorization header', async () => {
  const { transcriber, requests, services } = setup();
  (services.accounts as { apiKey: unknown }).apiKey = () => { throw new Error('vault locked'); };
  for (let i = 0; i < 3; i++) assert.deepEqual(await transcriber.transcribe({ fileId: FILE_ID }), { text: 'Hello Workforce' });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].init.headers, {});
});

test('SM9: a dictation without words is empty text, not a failure; agent hearing still refuses it', async () => {
  const answers = [{ text: '' }, { text: ' \n ' }];
  let next = 0;
  const { transcriber, requests } = setup({ respond: () => new Response(JSON.stringify(answers[next++])) });
  for (const answer of answers) assert.deepEqual(await transcriber.transcribe({ fileId: FILE_ID }), { text: '' }, JSON.stringify(answer));
  assert.equal(requests.length, 2, 'every take reached the service; no dictation slot was left taken');

  // An answer without a text string is a broken or misconfigured server, never silence.
  for (const broken of [{}, { text: 42 }, { text: null }, null, ['text']]) {
    const bad = setup({ respond: () => new Response(JSON.stringify(broken)) });
    const invalid = (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /invalid answer/.test(error.message);
    for (let i = 0; i < 3; i++) await assert.rejects(bad.transcriber.transcribe({ fileId: FILE_ID }), invalid, `${JSON.stringify(broken)}: no dictation slot was left taken`);
    Object.assign(bad.services as unknown as Record<string, unknown>, { db: undefined, secrets: { redact: (text: string) => text }, log: { debug() {} } });
    await assert.rejects(bad.transcriber.transcript(FILE_ID), invalid, 'agent hearing refuses it the same way');
  }

  const agent = setup({ respond: () => new Response(JSON.stringify({ text: '   ' })) });
  Object.assign(agent.services as unknown as Record<string, unknown>, { db: undefined, secrets: { redact: (text: string) => text }, log: { debug() {} } });
  await assert.rejects(agent.transcriber.transcript(FILE_ID), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /no usable text/.test(error.message));
});

/** Gives the fake store the blob clean-up's side (files/cleanup.ts Reclaimer) and a clock; records what it queues, due when. */
function withReclaimer(services: RuntimeServices, reclaim: (ids: string[]) => void = () => undefined) {
  const clock = { at: 1 + 30_000, now: () => clock.at }; // the fake take was stored at 1: 30 s ago
  const queued: Array<{ ids: string[]; notBefore?: number }> = [];
  Object.assign(services, { clock });
  Object.assign(services.files as object, {
    reclaim: (ids: Iterable<string>, options: { notBefore?: number } = {}) => { queued.push({ ids: [...ids], notBefore: options.notBefore }); reclaim([...ids]); },
    reconcileOrphans() {}, remove: async () => true,
  });
  return { queued, clock };
}

test('SM9: a heard dictation take goes to the blob clean-up after a hold; a failed take, an older file and agent hearing do not', async () => {
  const answers = [() => new Response(JSON.stringify({ text: ' Hello ' })), () => new Response(JSON.stringify({ text: '' })), () => new Response('', { status: 500 }), () => new Response('{}')];
  let next = 0;
  const { transcriber, services } = setup({ respond: () => answers[next++]() });
  const { queued, clock } = withReclaimer(services);
  assert.deepEqual(await transcriber.transcribe({ fileId: FILE_ID }), { text: 'Hello' });
  assert.deepEqual(await transcriber.transcribe({ fileId: FILE_ID }), { text: '' });
  const due = clock.at + HEARD_TAKE_HOLD_MS;
  assert.deepEqual(queued, [{ ids: [FILE_ID], notBefore: due }, { ids: [FILE_ID], notBefore: due }],
    'words or none: the take only carried its words – due after the hold, since the answer may never arrive');
  await assert.rejects(transcriber.transcribe({ fileId: FILE_ID }), WorkforceError);
  await assert.rejects(transcriber.transcribe({ fileId: FILE_ID }), /invalid answer/);
  assert.equal(queued.length, 2, 'a failed take (also an answer without text) stays, the composer may attach it');

  // A chat device naming an older file (a recording in the media library) has it heard, never queued.
  const library = setup();
  const old = withReclaimer(library.services);
  old.clock.at = 1 + FRESH_TAKE_MS + 1;
  assert.deepEqual(await library.transcriber.transcribe({ fileId: FILE_ID }), { text: 'Hello Workforce' });
  assert.deepEqual(old.queued, [], 'only the caller\'s own fresh take goes to the clean-up');

  const agent = setup();
  Object.assign(agent.services as unknown as Record<string, unknown>, { db: undefined, secrets: { redact: (text: string) => text }, log: { debug() {} } });
  const agentQueued = withReclaimer(agent.services).queued;
  assert.equal(await agent.transcriber.transcript(FILE_ID), 'Hello Workforce');
  assert.deepEqual(agentQueued, [], 'an agent hears a file that a message or the library still holds');

  const broken = setup();
  withReclaimer(broken.services, () => { throw new Error('queue unavailable'); });
  assert.deepEqual(await broken.transcriber.transcribe({ fileId: FILE_ID }), { text: 'Hello Workforce' }, 'a failing clean-up never costs the text');
});

test('other errors are not retried: a rate limit and a refused take keep their clear errors', async () => {
  const limited = setup({ respond: () => new Response('', { status: 429 }) });
  await assert.rejects(limited.transcriber.transcribe({ fileId: FILE_ID }), (error: unknown) => error instanceof WorkforceError && error.code === 'rate_limited');
  assert.equal(limited.requests.length, 1);
  const refused = setup({ respond: () => new Response('nope', { status: 400 }) });
  await assert.rejects(refused.transcriber.transcribe({ fileId: FILE_ID }), /did not accept the audio/);
  assert.equal(refused.requests.length, 1);
});
