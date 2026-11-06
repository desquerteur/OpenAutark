// B-052 track B: the sign-in's loopback listener – GET /callback with the right Host only (a stray request, another
// path, POST or a wrong Host is no answer), the endpoint's own query kept in the authorization address, busy ports
// skipped in order (all busy: a user-safe error), the verify hook ends the sign-in, a server's error text is never
// shown, and the real listener binds 127.0.0.1 and answers the browser once.
// Owns: checks of runtime/apps/oauth/loopback.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { openLoopback, pkcePair } from '../../../src/runtime/apps/oauth/loopback.ts';
import { fakeLoopback, FakeTimers } from './oauth-fixture.ts';

async function open(ports: number[] = [33418], verify?: (params: URLSearchParams) => Error | undefined) {
  const loopback = fakeLoopback();
  const timers = new FakeTimers();
  const listener = await openLoopback({ ports, server: loopback.factory, timers, verify });
  const address = new URL(listener.address('https://auth.example.com/authorize?tenant=t1', { client_id: 'cid', scope: undefined }));
  return { loopback, timers, listener, address, state: address.searchParams.get('state')! };
}

test('the authorization address keeps the endpoint query and carries redirect, state and the S256 challenge', async () => {
  const { listener, address, loopback, state } = await open();
  const params = address.searchParams;
  assert.equal(params.get('tenant'), 't1');
  assert.equal(params.get('client_id'), 'cid');
  assert.equal(params.has('scope'), false, 'undefined parameters are left out');
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:33418/callback');
  assert.equal(listener.redirectUri, 'http://127.0.0.1:33418/callback');
  assert.equal(params.get('code_challenge_method'), 'S256');
  loopback.hit(`/callback?state=${state}&code=c1`);
  const answer = await listener.answer;
  assert.deepEqual({ code: answer.code, redirectUri: answer.redirectUri }, { code: 'c1', redirectUri: 'http://127.0.0.1:33418/callback' });
  assert.equal(createHash('sha256').update(answer.verifier).digest('base64url'), params.get('code_challenge'));
  const pair = pkcePair(() => Buffer.alloc(32, 9));
  assert.equal(pair.verifier.length, 43);
});

test('a stray request, another path, POST and a wrong Host header are no answer; the listener keeps waiting', async () => {
  const { loopback, listener, state } = await open();
  assert.equal(loopback.hit('/favicon.ico').status, 404);
  assert.equal(loopback.hit('/callback').status, 404);
  assert.equal(loopback.hit(`/?state=${state}&code=x`).status, 404, 'the redirect path is /callback');
  assert.equal(loopback.hit(`/callback?state=${state}&code=x`, '127.0.0.1:33418', 'POST').status, 400);
  assert.equal(loopback.hit(`/callback?state=${state}&code=x`, 'evil.example:33418').status, 400, 'DNS rebinding: wrong Host');
  assert.equal(loopback.isOpen(), true);
  assert.equal(loopback.hit(`/callback?state=${state}&code=real`).status, 200);
  assert.equal((await listener.answer).code, 'real');
  assert.equal(loopback.hit(`/callback?state=${state}&code=again`).status, 410, 'one answer only');
});

test('busy ports are skipped in order; when all are busy the error is user-safe', async () => {
  const loopback = fakeLoopback();
  loopback.busy.add(33418).add(33419);
  const listener = await openLoopback({ ports: [33418, 33419, 33420], server: loopback.factory, timers: new FakeTimers() });
  assert.deepEqual(loopback.tried, [33418, 33419, 33420]);
  assert.equal(listener.port, 33420);
  listener.close();
  await assert.rejects(listener.answer, (error: Error & { code?: string }) => error.code === 'cancelled');

  loopback.busy.add(33420);
  await assert.rejects(openLoopback({ ports: [33418, 33419, 33420], server: loopback.factory, timers: new FakeTimers() }),
    (error: Error & { code?: string }) => error.code === 'unavailable' && error.message === 'Autark could not open the sign-in listener on this PC.');
});

test('the verify hook ends the sign-in; a server error text that is not a plain code is not shown', async () => {
  const refused = await open([33418], (params) => (params.get('iss') === 'good' ? undefined : new WorkforceError('forbidden', 'Wrong server.')));
  const page = refused.loopback.hit(`/callback?state=${refused.state}&code=c&iss=bad`);
  assert.equal(page.status, 400);
  await assert.rejects(refused.listener.answer, (error: Error) => error.message === 'Wrong server.');
  assert.equal(refused.timers.pending.length, 0);

  const odd = await open();
  odd.loopback.hit(`/callback?state=${odd.state}&error=${encodeURIComponent('<b>hacked</b>')}`);
  await assert.rejects(odd.listener.answer, (error: Error) => error.message === 'The app did not finish the sign-in.');
});

test('the real listener binds 127.0.0.1 and answers the browser once', async () => {
  const listener = await openLoopback({ ports: [0] });
  try {
    const address = new URL(listener.address('https://auth.example.com/authorize', {}));
    const redirect = new URL(address.searchParams.get('redirect_uri')!);
    assert.equal(redirect.hostname, '127.0.0.1');
    assert.equal(redirect.pathname, '/callback');
    assert.ok(listener.port > 0);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: listener.port, path: `/callback?state=${address.searchParams.get('state')}&code=live`, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
    assert.equal((await listener.answer).code, 'live');
  } finally { listener.close(); }
});
