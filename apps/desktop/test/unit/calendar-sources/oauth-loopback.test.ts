// B-041 track G: the Google consent's loopback listener – the consent address carries a random state and a PKCE S256
// challenge of a 43-character verifier; only the one answer with the right state counts (a stray /favicon.ico or a
// wrong Host header does not); a wrong state, Google's refusal, the 5-minute timeout or close() end it and close the
// listener; and the real listener binds 127.0.0.1 only.
// Owns: checks of runtime/calendar/sources/oauth-loopback.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { CONSENT_TIMEOUT_MS, pkcePair, startLoopback } from '../../../src/runtime/calendar/sources/oauth-loopback.ts';
import { FakeTimers } from '../chat/harness.ts';
import { fakeLoopback, LOOPBACK_PORT } from './fixture.ts';

async function open() {
  const loopback = fakeLoopback();
  const timers = new FakeTimers();
  const consent = await startLoopback({ clientId: 'cid', scopes: ['a', 'b'], timers, server: loopback.factory });
  const state = new URL(consent.authUrl).searchParams.get('state')!;
  return { loopback, timers, consent, state };
}

test('the consent address: client, loopback redirect, scopes, state and an S256 challenge of the verifier', async () => {
  const { loopback, consent, state } = await open();
  const params = new URL(consent.authUrl).searchParams;
  assert.equal(params.get('redirect_uri'), `http://127.0.0.1:${LOOPBACK_PORT}`);
  assert.equal(params.get('scope'), 'a b');
  assert.ok(state.length >= 20);
  const result = loopback.hit(`/?state=${state}&code=the-code`);
  assert.equal(result.status, 200);
  const answer = await consent.code;
  assert.equal(answer.code, 'the-code');
  assert.equal(answer.redirectUri, `http://127.0.0.1:${LOOPBACK_PORT}`);
  assert.equal(answer.verifier.length, 43);
  assert.equal(createHash('sha256').update(answer.verifier).digest('base64url'), params.get('code_challenge'));
  assert.equal(loopback.isOpen(), false, 'closed after the answer');
  const pair = pkcePair(() => Buffer.alloc(32, 7));
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'));
});

test('a stray request and a wrong Host header are no answer; the listener keeps waiting', async () => {
  const { loopback, consent, state } = await open();
  assert.equal(loopback.hit('/favicon.ico').status, 404);
  assert.equal(loopback.hit('/').status, 404);
  assert.equal(loopback.hit(`/?state=${state}&code=x`, 'evil.example:80').status, 400, 'DNS rebinding: wrong Host');
  assert.equal(loopback.isOpen(), true);
  loopback.hit(`/?state=${state}&code=real`);
  assert.equal((await consent.code).code, 'real');
});

test('a wrong state ends the consent (forbidden) and closes the listener', async () => {
  const { loopback, consent } = await open();
  assert.equal(loopback.hit('/?state=forged&code=stolen').status, 400);
  await assert.rejects(consent.code, (error: Error & { code?: string }) => error.code === 'forbidden');
  assert.equal(loopback.isOpen(), false);
  assert.equal(loopback.hit('/?state=forged&code=again').status, 410, 'nothing is accepted any more');
});

test("Google's refusal, the 5-minute timeout and close() end it too", async () => {
  const denied = await open();
  denied.loopback.hit(`/?state=${denied.state}&error=access_denied`);
  await assert.rejects(denied.consent.code, (error: Error & { code?: string }) => error.code === 'cancelled');
  assert.equal(denied.timers.pending.length, 0, 'the timer is cleared');

  const slow = await open();
  assert.equal(slow.timers.only()!.ms, CONSENT_TIMEOUT_MS);
  slow.timers.fire();
  await assert.rejects(slow.consent.code, (error: Error & { code?: string }) => error.code === 'timeout');
  assert.equal(slow.loopback.isOpen(), false);

  const replaced = await open();
  replaced.consent.close();
  await assert.rejects(replaced.consent.code, (error: Error & { code?: string }) => error.code === 'cancelled');
  replaced.consent.close(); // twice is harmless
});

test('the real listener binds 127.0.0.1 and answers the browser once', async () => {
  const consent = await startLoopback({ clientId: 'cid', scopes: ['a'] });
  try {
    const params = new URL(consent.authUrl).searchParams;
    const redirect = new URL(params.get('redirect_uri')!);
    assert.equal(redirect.hostname, '127.0.0.1');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(redirect.port), path: `/?state=${params.get('state')}&code=live`, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
    assert.equal((await consent.code).code, 'live');
  } finally { consent.close(); }
});
