// B-055: the bounded feedback transport – no redirects, no browser credentials, a timeout, capped bodies, plain
// errors – and the loopback origin a local fake may use. (The B-036 GitHub receiver transport it replaced is gone.)
// Owns: these assertions. Never: contacts a hosted service or reads real credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRESTORE_ORIGIN, TOKEN_URL, loopbackOrigin, request } from '../../../src/runtime/feedback/transport.ts';

test('only Google and loopback fakes: the fixed origins and loopbackOrigin', () => {
  assert.equal(FIRESTORE_ORIGIN, 'https://firestore.googleapis.com');
  assert.equal(TOKEN_URL, 'https://oauth2.googleapis.com/token');
  assert.equal(loopbackOrigin('http://127.0.0.1:4321/'), 'http://127.0.0.1:4321');
  assert.equal(loopbackOrigin('http://LOCALHOST:80'), 'http://localhost:80');
  assert.equal(loopbackOrigin('https://[::1]:8443'), 'https://[::1]:8443');
  for (const value of ['https://evil.example', 'http://127.0.0.1:4321/path', 'http://user@127.0.0.1', 'http://127.0.0.1:99999', 'http://127.0.0.2', 'file:///x', 7, undefined]) {
    assert.equal(loopbackOrigin(value), undefined, String(value));
  }
});

test('a request never follows redirects or sends browser credentials, and has a timeout', async () => {
  let seen: RequestInit | undefined;
  const run = (async (_url, init) => { seen = init; return new Response('{}'); }) as typeof fetch;
  const reply = await request(run, `${FIRESTORE_ORIGIN}/v1/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 1024);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString(), '{}');
  assert.equal(seen?.redirect, 'error');
  assert.equal(seen?.credentials, 'omit');
  assert.ok(seen?.signal instanceof AbortSignal);
});

test('bodies are capped; cap 0 discards the body unread; network errors stay plain', async () => {
  const big = (async () => new Response('x'.repeat(5000), { status: 500 })) as typeof fetch;
  await assert.rejects(request(big, `${FIRESTORE_ORIGIN}/x`, { method: 'GET' }, 4096), /oversized/);
  assert.equal((await request(big, `${FIRESTORE_ORIGIN}/x`, { method: 'GET' }, 8192)).body.length, 5000);
  const discarded = await request(big, `${FIRESTORE_ORIGIN}/x`, { method: 'GET' }, 0);
  assert.deepEqual([discarded.status, discarded.body.length], [500, 0]);
  const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(request(offline, `${FIRESTORE_ORIGIN}/x`, { method: 'GET' }, 10), /fetch failed/);
});
