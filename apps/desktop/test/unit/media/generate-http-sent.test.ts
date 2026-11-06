// B-058 i1 (paid-failure safety): a POST whose connection fails after the request left is phase 'sent'
// (unknown effect: no fallback route, no retry), one that provably never left (refused connect, name
// lookup, TLS, bad URL) keeps the fallback; every media exchange runs on an agent whose header/body
// timeouts outlast every call deadline (Node's fetch default is 300 s, a video call may take 6 min).
// Owns: these assertions only. Never: a real provider or the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generationPhase, maybeSent, mayFallBack, mediaDispatcher, mediaExchange, MEDIA_SOCKET_MS } from '../../../src/runtime/media/generate-http.ts';
import { DEADLINE_MS, generateMedia, mediaTarget } from '../../../src/runtime/media/generate.ts';
import type { GenerationContext } from '../../../src/runtime/media/providers/types.ts';
import { account, services } from './generate-fixture.ts';

const failureOf = <T>(job: Promise<T>) => job.then(() => assert.fail('should fail'), (error: Error) => error);
const undiciError = (code: string, message = code) => new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

/** A server that reads the whole request, then does `then` with the socket (cut it, or keep silent). */
async function server(then: (res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string; seen: number }> {
  const state = { server: undefined as unknown as Server, url: '', seen: 0 };
  state.server = createServer((req, res) => { req.resume(); req.on('end', () => { state.seen += 1; then(res); }); });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}/v1/images/generations`;
  return state;
}
const close = (s: { server: Server }) => { s.server.closeAllConnections(); s.server.close(); };
const ctx = (ms = 5_000, fetchFn: GenerationContext['fetch'] = (url, init) => fetch(url, init)): GenerationContext => ({ fetch: fetchFn, deadlineMs: Date.now() + ms });

test('maybeSent: only failures that provably came before sending are "not sent"', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_URL']) {
    assert.equal(maybeSent(undiciError(code)), false, code);
  }
  assert.equal(maybeSent(new TypeError('connect ECONNREFUSED 127.0.0.1:9')), false, 'the code in the message');
  assert.equal(maybeSent(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })), false, 'a refused 3xx');
  assert.equal(maybeSent(new TypeError('Headers.append: "x" is an invalid header value.')), false);
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']) assert.equal(maybeSent(undiciError(code)), true, code);
  assert.equal(maybeSent(undiciError('UND_ERR_SOCKET', 'Response does not match the HTTP/1.1 protocol (Invalid header value char)')), true, 'a broken answer header came after sending');
  assert.equal(maybeSent(new Error('boom')), true, 'unknown: may have been sent');
});

test('a POST cut after its body was sent is phase sent (no fallback); a GET stays a plain network failure', async () => {
  const cut = await server((res) => res.socket?.destroy());
  try {
    const post = await failureOf(mediaExchange(ctx(), { url: cut.url, json: { prompt: 'x' }, what: 'Image generation', max: 1024 }));
    assert.equal(generationPhase(post), 'sent');
    assert.equal(mayFallBack(post), false);
    assert.match(post.message, /broke off after the request was sent/);
    const get = await failureOf(mediaExchange(ctx(), { url: cut.url, method: 'GET', what: 'Video generation', max: 1024 }));
    assert.equal(generationPhase(get), undefined, 'a status read charges nothing (job.ts may retry it)');
    assert.equal(cut.seen, 2);
  } finally { close(cut); }
});

test('a refused connect is not sent: the fallback stays allowed', async () => {
  const gone = await server(() => undefined);
  close(gone);
  await new Promise((resolve) => gone.server.once('close', resolve));
  const error = await failureOf(mediaExchange(ctx(), { url: gone.url, json: { prompt: 'x' }, what: 'Image generation', max: 1024 }));
  assert.equal(generationPhase(error), undefined);
  assert.equal(mayFallBack(error), true);
});

test('a real header timeout of Node\'s fetch after the body went out is phase sent', async () => {
  const silent = await server(() => undefined);
  try {
    const Agent = (mediaDispatcher() as { constructor: new (options: object) => object }).constructor;
    const short = new Agent({ headersTimeout: 150, bodyTimeout: 150 });
    const error = await failureOf(mediaExchange(ctx(5_000, (url, init) => fetch(url, { ...init, dispatcher: short } as RequestInit)), { url: silent.url, json: { prompt: 'x' }, what: 'Video generation', max: 1024 }));
    assert.equal(generationPhase(error), 'sent');
    assert.equal(mayFallBack(error), false);
    await (short as { close(): Promise<void> }).close();
  } finally { close(silent); }
});

test('every media exchange gets the long agent: header/body timeouts above every call deadline', async () => {
  const agent = mediaDispatcher();
  assert.equal(typeof (agent as { dispatch?: unknown })?.dispatch, 'function', 'built from Node\'s own fetch dispatcher');
  assert.equal(mediaDispatcher(), agent, 'one agent for the process');
  assert.ok(MEDIA_SOCKET_MS >= Math.max(...Object.values(DEADLINE_MS)) + 2_000, 'longer than the longest deadline plus grace');
  const options = Object.getOwnPropertySymbols(agent).map((key) => (agent as Record<symbol, unknown>)[key]).find((value): value is { headersTimeout: number; bodyTimeout: number } => typeof (value as { headersTimeout?: unknown })?.headersTimeout === 'number');
  assert.deepEqual([options?.headersTimeout, options?.bodyTimeout], [MEDIA_SOCKET_MS, MEDIA_SOCKET_MS], 'undici keeps the options it was given');
  let seen: unknown;
  await mediaExchange(ctx(5_000, async (_url, init) => { seen = (init as { dispatcher?: unknown }).dispatcher; return new Response('{}', { headers: { 'content-type': 'application/json' } }); }), { url: 'http://127.0.0.1:1/x', json: {}, what: 'Video generation', max: 1024 });
  assert.equal(seen, agent);
});

test('generateMedia: a paid-shaped call cut after sending is not handed to a fallback route', async () => {
  const cut = await server((res) => res.socket?.destroy());
  try {
    const s = services([account('acc_local', 'local', cut.url.replace('/images/generations', ''))]);
    const error = await failureOf(generateMedia(s, mediaTarget(s, 'image'), { prompt: 'A wave' }, { fetch: (url, init) => fetch(url, init) }));
    assert.equal(generationPhase(error), 'sent');
    assert.equal(mayFallBack(error), false);
  } finally { close(cut); }
});
