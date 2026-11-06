// Shared HTTP engine rules: endpoint validation, SSE framing (CRLF split across chunks, [DONE],
// caps), safe status errors, Retry-After parsing, key redaction and transport failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpEngineError, endpointFor, postJson, readJson, readSse, redact, retryAfter, statusError, turnError } from '../../../src/runtime/engines/http/common.ts';

const enc = new TextEncoder();

function streamOf(chunks: Array<string | Error>): Response {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      const next = chunks[i++];
      if (next instanceof Error) controller.error(next);
      else controller.enqueue(enc.encode(next));
    },
  }));
}

async function collect(response: Response): Promise<Array<{ event?: string; data: unknown }>> {
  const out: Array<{ event?: string; data: unknown }> = [];
  for await (const item of readSse(response)) out.push(item);
  return out;
}

test('endpointFor: HTTPS or loopback HTTP only, no credentials/query/fragment, local providers loopback only', () => {
  assert.equal(endpointFor({ provider: 'openai', baseUrl: undefined }), 'https://api.openai.com/v1');
  assert.equal(endpointFor({ provider: 'compatible', baseUrl: 'http://127.0.0.1:8080/v1/' }), 'http://127.0.0.1:8080/v1');
  assert.equal(endpointFor({ provider: 'ollama', baseUrl: undefined }), 'http://127.0.0.1:11434/v1');
  assert.throws(() => endpointFor({ provider: 'compatible', baseUrl: 'http://192.168.1.5:8080/v1' }), /HTTPS/);
  assert.throws(() => endpointFor({ provider: 'openai', baseUrl: 'https://user:pw@api.example.com/v1' }), /without credentials/);
  assert.throws(() => endpointFor({ provider: 'openai', baseUrl: 'https://api.example.com/v1?key=x' }), /query/);
  assert.throws(() => endpointFor({ provider: 'lmstudio', baseUrl: 'https://lm.example.com/v1' }), /loopback/);
  assert.throws(() => endpointFor({ provider: 'compatible', baseUrl: undefined }), /no server URL/);
});

test('readSse: event names, multi-line data, comments, [DONE]', async () => {
  const events = await collect(streamOf([
    ': keep-alive\n\n',
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'data: {"a":\ndata: 1}\n\n',
    'data: [DONE]\n\n',
  ]));
  assert.deepEqual(events, [
    { event: 'message_start', data: { type: 'message_start' } },
    { event: undefined, data: { a: 1 } },
    { event: undefined, data: '[DONE]' },
  ]);
});

test('readSse: CRLF framing split between chunks (regression: "\\r" at a chunk end broke [DONE])', async () => {
  const events = await collect(streamOf(['data: {"n":1}\r', '\n\r\ndata: {"n":2}\r\n', '\r', '\ndata: [DONE]\r', '\n\r\n']));
  assert.deepEqual(events.map((e) => e.data), [{ n: 1 }, { n: 2 }, '[DONE]']);
  // Bare CR line endings are valid SSE too.
  const cr = await collect(streamOf(['data: {"n":3}\r\rdata: [DONE]\r\r']));
  assert.deepEqual(cr.map((e) => e.data), [{ n: 3 }, '[DONE]']);
});

test('readSse: invalid JSON and oversized events fail with safe messages', async () => {
  await assert.rejects(collect(streamOf(['data: {nope}\n\n'])), (error: unknown) => error instanceof HttpEngineError && error.data.message === 'The provider returned an invalid response.');
  await assert.rejects(collect(streamOf([`data: ${'x'.repeat(1024 * 1024 + 10)}`])), (error: unknown) => error instanceof HttpEngineError && /too large/.test(error.data.message));
  const drainCapped = async () => { for await (const _ of readSse(streamOf(['data: {"a":1}\n\n'.repeat(10)]), 20)) { /* drain */ } };
  await assert.rejects(drainCapped(), (error: unknown) => error instanceof HttpEngineError && /too large/.test(error.data.message));
});

test('readSse/readJson: a connection lost mid-body is "unavailable", not a model failure', async () => {
  await assert.rejects(collect(streamOf(['data: {"n":1}\n\n', new TypeError('terminated')])), (error: unknown) => error instanceof HttpEngineError && error.data.code === 'unavailable' && !/terminated/.test(error.data.message));
  await assert.rejects(readJson(streamOf(['{"a":', new TypeError('terminated')])), (error: unknown) => error instanceof HttpEngineError && error.data.code === 'unavailable');
  await assert.rejects(readJson(streamOf(['{"a":'])), (error: unknown) => error instanceof HttpEngineError && error.data.code === 'internal');
});

test('statusError: fixed messages per status; turnError maps limits, aborts and unknown errors', () => {
  assert.deepEqual(statusError(401), { code: 'unavailable', message: 'The provider rejected this connection. Reconnect in Settings.' });
  assert.equal(statusError(403).code, 'forbidden');
  assert.equal(statusError(429).code, 'rate_limited');
  assert.equal(statusError(404).code, 'bad_request');
  assert.equal(statusError(529).code, 'unavailable');
  assert.equal(statusError(500).message, 'The model request failed (HTTP 500).');
  const live = new AbortController();
  assert.deepEqual(turnError(new HttpEngineError(statusError(429)), live.signal).stop, 'limit');
  assert.deepEqual(turnError(new Error('secret body'), live.signal), { stop: 'error', error: { code: 'internal', message: 'The model could not complete this turn.' } });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(turnError(new Error('x'), aborted.signal).stop, 'interrupted');
});

test('retryAfter: seconds, HTTP date and retry-after-ms', () => {
  assert.equal(retryAfter(new Response(null, { headers: { 'retry-after': '7' } })), 7000);
  assert.equal(retryAfter(new Response(null, { headers: { 'retry-after-ms': '1500', 'retry-after': '9' } })), 1500);
  const date = retryAfter(new Response(null, { headers: { 'retry-after': new Date(Date.now() + 60_000).toUTCString() } }));
  assert.ok(date !== undefined && date > 55_000 && date <= 60_000);
  assert.equal(retryAfter(new Response(null)), undefined);
  assert.equal(retryAfter(new Response(null, { headers: { 'retry-after': 'soon' } })), undefined);
});

test('postJson: redirect:error, safe errors for network failure, abort and HTTP status', async () => {
  const seen: RequestInit[] = [];
  const ok = await postJson(async (_url, init) => { seen.push(init); return new Response('{}'); }, 'http://x/v1', { A: '1' }, { b: 2 }, new AbortController().signal);
  assert.equal(ok.status, 200);
  assert.equal(seen[0].redirect, 'error');
  assert.equal((seen[0].headers as Record<string, string>)['Content-Type'], 'application/json');
  await assert.rejects(postJson(async () => { throw new TypeError('fetch failed: ECONNREFUSED sk-secret'); }, 'http://x', {}, {}, new AbortController().signal),
    (error: unknown) => error instanceof HttpEngineError && error.data.code === 'unavailable' && !error.data.message.includes('sk-secret'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(postJson(async () => { throw new DOMException('aborted', 'AbortError'); }, 'http://x', {}, {}, aborted.signal),
    (error: unknown) => error instanceof HttpEngineError && error.data.code === 'cancelled');
  await assert.rejects(postJson(async () => new Response('{"error":"bad key sk-secret"}', { status: 429, headers: { 'retry-after': '3' } }), 'http://x', {}, {}, new AbortController().signal),
    (error: unknown) => error instanceof HttpEngineError && error.data.code === 'rate_limited' && error.data.retryAfterMs === 3000 && !JSON.stringify(error.data).includes('sk-secret'));
});

test('redact: removes keys of 8+ chars only', () => {
  assert.equal(redact('echo sk-12345678 and sk-12345678', 'sk-12345678'), 'echo [redacted] and [redacted]');
  assert.equal(redact('short key abc', 'abc'), 'short key abc');
  assert.equal(redact('nothing', undefined), 'nothing');
});
