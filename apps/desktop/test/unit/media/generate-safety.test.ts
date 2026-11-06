// Media generation safety (MM3 fixes, on the B-058 dispatcher): the timeout and the run's stop cover the whole exchange,
// the answer body included (a stalled or streamed answer is cut, never hangs); how far a failed
// call got (generationPhase) and, for a paid account, an 'unknown' effect once the request went
// out (booked once the provider answered);
// a generated file without a chat of the agent stays private (not linked, not described), and
// identical bytes already in another chat or described keep their row.
// Owns: these assertions only. Never: a real provider or the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMedia, generationPhase, mediaTarget, type FetchFn, type GenerateOptions, type GenerateServices, type MediaTarget } from '../../../src/runtime/media/generate.ts';
import { MediaLibrary } from '../../../src/runtime/media/library.ts';
import { MediaRepo } from '../../../src/runtime/media/repo.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { png } from './fixtures.ts';
import { account, call, endlessAnswer, imageAnswer, listen, MP3, services, textOf, tool, toolSetup } from './generate-fixture.ts';

const LOCAL = 'http://127.0.0.1:9100/v1';
const failureOf = <T>(job: Promise<T>) => job.then(() => assert.fail('should fail'), (error: Error) => error);
const generateImage = (s: GenerateServices, target: MediaTarget, input: { prompt: string }, options: GenerateOptions) => generateMedia(s, target, input, options);
const generateSpeech = (s: GenerateServices, target: MediaTarget, input: { text: string }, options: GenerateOptions) => generateMedia(s, target, { prompt: '', ...input }, options);

test('a stalled answer body is cut by the timeout and by Stop (never hangs)', { timeout: 10_000 }, async () => {
  const s = services([account('acc_local', 'local', LOCAL)]);
  const speech = mediaTarget(s, 'tts');
  const endless: FetchFn = async () => endlessAnswer();
  const timedOut = await failureOf(generateSpeech(s, speech, { text: 'Hi' }, { timeoutMs: 30, fetch: endless }));
  assert.match(timedOut.message, /timed out after 1 s/);
  assert.equal(generationPhase(timedOut), 'answered', 'the provider answered: it made the audio');

  const stop = new AbortController();
  const stopped = generateSpeech(s, speech, { text: 'Hi' }, { signal: stop.signal, fetch: async () => { setImmediate(() => stop.abort()); return endlessAnswer(); } });
  const error = await failureOf(stopped);
  assert.match(error.message, /^Stopped\.$/);
  assert.equal(generationPhase(error), 'answered');

  const image = mediaTarget(s, 'image');
  const json = await failureOf(generateImage(s, image, { prompt: 'A wave' }, { timeoutMs: 30, fetch: async () => endlessAnswer('application/json') }));
  assert.match(json.message, /timed out/);
});

test('generationPhase: sent (no answer yet), answered (2xx but unusable), none (refused or never sent)', async () => {
  const s = services([account('acc_local', 'local', LOCAL)]);
  const target = mediaTarget(s, 'image');
  const never: FetchFn = (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(generationPhase(await failureOf(generateImage(s, target, { prompt: 'x' }, { timeoutMs: 20, fetch: never }))), 'sent');
  assert.equal(generationPhase(await failureOf(generateImage(s, target, { prompt: 'x' }, { fetch: async () => imageAnswer(Buffer.from('<html>')) }))), 'answered');
  assert.equal(generationPhase(await failureOf(generateImage(s, target, { prompt: 'x' }, { fetch: async () => new Response('no', { status: 401 }) }))), undefined);
  assert.equal(generationPhase(await failureOf(generateImage(s, target, { prompt: 'x' }, { fetch: async () => { throw new TypeError('connect ECONNREFUSED'); } }))), undefined);
  const early = new AbortController();
  early.abort();
  assert.equal(generationPhase(await failureOf(generateImage(s, target, { prompt: 'x' }, { signal: early.signal, fetch: never }))), undefined, 'stopped before sending');
});

test('Stop while a paid answer streams in: "Stopped", effect unknown, and the estimate is booked', { timeout: 10_000 }, async () => {
  const fake = await listen(() => (res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.write(Buffer.alloc(64, 1)); });
  const t = toolSetup([account('acc_paid', 'api_key', fake.base)]);
  const realFetch = globalThis.fetch;
  let headers!: () => void;
  const answered = new Promise<void>((resolve) => { headers = resolve; });
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { const response = await realFetch(...args); headers(); return response; }) as typeof fetch;
  try {
    const stop = new AbortController();
    const args = { text: 'A long welcome text' };
    tool('media.speak').describe!(args, t.ctx());
    const pending = tool('media.speak').run(args, t.ctx('ag_ada', t.chat.id, stop.signal));
    await answered;
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    const out = await pending;
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^Stopped\. The provider may already have made and charged it/);
    assert.deepEqual(out.effect, { status: 'unknown' });
    assert.deepEqual(t.spends, [{ agentId: 'ag_ada', amount: 0.01, currency: 'USD', kind: 'tokens', ref: 'media:run:run_1' }]);
    assert.equal(new MediaRepo(t.h.db).list({}, { kind: 'owner' }, 10).length, 0, 'nothing stored');
  } finally {
    globalThis.fetch = realFetch;
    fake.server.closeAllConnections();
    fake.server.close();
    t.temp.cleanup();
  }
});

test('paid failures after the request went out are unknown effects; only an answered one is booked', async () => {
  const fake = await listen((_req, body) => (String(body.prompt).includes('html')
    ? { type: 'application/json', body: JSON.stringify({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] }) }
    : { status: 500, type: 'text/plain', body: 'boom' }));
  const t = toolSetup([account('acc_paid', 'api_key', fake.base)]);
  try {
    const unusable = (await call('media.image', { prompt: 'html please', quality: 'low' }, t.ctx())).out;
    assert.match(textOf(unusable), /not a PNG, JPEG or WebP image\. The provider may already have made and charged it/);
    assert.deepEqual(unusable.effect, { status: 'unknown' }, 'no blind retry or failover');
    assert.deepEqual(t.spends.map((spend) => [spend.amount, spend.ref]), [[0.02, 'media:run:run_1']], 'made and charged: booked');
    const refused = (await call('media.image', { prompt: 'server error', quality: 'low' }, t.ctx())).out;
    assert.equal(refused.isError, true);
    assert.equal(refused.effect, undefined, 'an HTTP error is a plain failure');
    assert.equal(t.spends.length, 1);
  } finally { fake.server.close(); t.temp.cleanup(); }
});

test('without a chat of the agent the generated file stays private: not linked, not described', async () => {
  const fake = await listen(() => ({ type: 'application/json', body: JSON.stringify({ data: [{ b64_json: Buffer.from(png(16, 16)).toString('base64') }] }) }));
  const t = toolSetup([account('acc_local', 'local', fake.base)]);
  try {
    for (const conversationId of [undefined, t.other.id]) { // a chat-less wake; a chat Ada is no member of
      const { out } = await call('media.image', { prompt: `Private agenda ${conversationId ?? 'none'}` }, { ...t.ctx(), conversationId });
      assert.equal(out.isError, undefined, textOf(out));
      const result = out.structured as { fileId: string; note: string };
      assert.match(result.note, /stays private/);
      const row = new MediaRepo(t.h.db).get(result.fileId)!;
      assert.equal(row.conversationId, undefined);
      assert.equal(row.describedBy, undefined, 'an agent-described global row would be visible to every agent');
      const found = await tool('media.search').run({ text: 'generated' }, t.ctx('ag_bo', t.other.id));
      assert.equal((found.structured as { count: number }).count, 0, 'another agent cannot find it');
    }
  } finally { fake.server.close(); t.temp.cleanup(); }
});

test('identical bytes already in another chat, or described, keep their row and description', async () => {
  const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 9)]);
  const fake = await listen((_req, body) => (body.response_format === 'wav' ? { type: 'audio/wav', body: WAV } : { type: 'audio/mpeg', body: MP3 })); // a deterministic voice
  const t = toolSetup([account('acc_local', 'local', fake.base)]);
  try {
    const file = await t.put(MP3, 'greeting.mp3', 'audio/mpeg');
    t.attach(t.other.id, file);
    new MediaLibrary(t.h.services).describe(file.id, { description: 'Bo\'s greeting for the Ops team', tags: ['ops'] }, HUMAN_ID);
    const { out } = await call('media.speak', { text: 'Good morning' }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    assert.equal((out.structured as { fileId: string }).fileId, file.id, 'the same content, the same file');
    const row = new MediaRepo(t.h.db).get(file.id)!;
    assert.equal(row.conversationId, t.other.id, 'still in its chat');
    assert.deepEqual([row.description, row.tags, row.describedBy], ['Bo\'s greeting for the Ops team', ['ops'], HUMAN_ID], 'not overwritten by Ada');

    const first = await call('media.speak', { text: 'Second take', format: 'wav' }, t.ctx());
    const id = (first.out.structured as { fileId: string }).fileId;
    assert.notEqual(id, file.id);
    assert.equal(new MediaRepo(t.h.db).get(id)?.conversationId, t.chat.id);
    new MediaLibrary(t.h.services).describe(id, { description: 'Edited by the person' }, HUMAN_ID);
    await call('media.speak', { text: 'Second take, again', format: 'wav' }, t.ctx());
    assert.equal(new MediaRepo(t.h.db).get(id)?.description, 'Edited by the person', 'a described row of the same chat stays too');
  } finally { fake.server.close(); t.temp.cleanup(); }
});
