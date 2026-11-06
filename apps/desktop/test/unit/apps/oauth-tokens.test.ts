// B-052 track B: the tokens of a grant – the access token in memory, renewed 60 s before it expires; a rotated
// refresh token written into the same vault entry; two requests at once share one refresh; invalid_grant →
// ReconnectNeeded with the grant and its vault entry gone; a server failure keeps the grant; after a restart the
// refresh token comes from the vault (system caller, token host); a grant without a refresh token lasts until its
// access token expires; forget() revokes, then deletes, and waits for a running refresh; invalidate() refreshes.
// Owns: checks of runtime/apps/oauth/tokens.ts (through createAppOAuth) only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectNeeded } from '../../../src/runtime/apps/types.ts';
import { grantKey } from '../../../src/runtime/apps/oauth/tokens.ts';
import { world } from './oauth-fixture.ts';

const refreshes = (w: Awaited<ReturnType<typeof world>>) => w.as.tokenRequests.filter((request) => request.params.get('grant_type') === 'refresh_token');

test('the access token is renewed 60 s before it expires; the rotated refresh token goes into the same vault entry', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  await w.signIn();
  const [secretId] = [...w.vault.entries.keys()];
  w.clock.advance(3_600_000 - 61_000);
  assert.deepEqual(await w.oauth.authHeaders('notion'), { authorization: 'Bearer at-2' }, 'still more than a minute left');
  w.clock.advance(2_000);
  assert.deepEqual(await w.oauth.authHeaders('notion'), { authorization: 'Bearer at-3' });
  const [refresh] = refreshes(w);
  assert.equal(refresh!.params.get('refresh_token'), 'rt-2');
  assert.equal(refresh!.params.get('client_id'), 'client-1');
  assert.equal(refresh!.params.get('resource'), `${w.as.base}/mcp`);
  assert.deepEqual([...w.vault.entries.keys()], [secretId], 'one entry');
  assert.equal(w.vault.entries.get(secretId!)!.value, 'rt-3', 'the rotated refresh token is stored');
  assert.deepEqual(w.vault.uses.at(-1), { id: secretId, agentId: 'system', domain: '127.0.0.1' });
  assert.ok(!w.kvText().includes('rt-3') && !w.kvText().includes('at-3'));
});

test('two requests at once share one refresh', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  await w.signIn();
  w.clock.advance(3_600_000);
  w.as.setTokenDelay(40);
  const [a, b, c] = await Promise.all([w.oauth.authHeaders('notion'), w.oauth.authHeaders('notion'), w.oauth.authHeaders('notion')]);
  assert.deepEqual(a, { authorization: 'Bearer at-3' });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(refreshes(w).length, 1, 'rotating servers may revoke a grant when an old refresh token is replayed');
});

test('invalid_grant: ReconnectNeeded, and the grant and its vault entry are gone', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  await w.signIn();
  w.as.refreshTokens.clear(); // revoked at the server
  w.clock.advance(3_600_000);
  await assert.rejects(w.oauth.authHeaders('notion'), ReconnectNeeded);
  assert.equal(w.oauth.hasGrant('notion'), false);
  assert.equal(w.vault.entries.size, 0);
  assert.equal(w.kv.get(grantKey('notion')), undefined);
  assert.deepEqual(await w.oauth.authHeaders('notion'), {});
});

test('a server failure keeps the grant and says the status only', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  await w.signIn();
  w.clock.advance(3_600_000);
  w.as.failTokenCalls(503);
  await assert.rejects(w.oauth.authHeaders('notion'), (error: Error & { code?: string }) =>
    error.code === 'unavailable' && /HTTP 503/.test(error.message) && !/secret body|rt-|at-/.test(error.message));
  assert.equal(w.oauth.hasGrant('notion'), true);
  w.as.failTokenCalls(undefined);
  assert.deepEqual(await w.oauth.authHeaders('notion'), { authorization: 'Bearer at-3' });
});

test('after a restart the refresh token comes from the vault; invalidate() renews a refused access token', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  await w.signIn();
  const restarted = w.make();
  assert.equal(restarted.hasGrant('notion'), true);
  assert.deepEqual(await restarted.authHeaders('notion'), { authorization: 'Bearer at-3' }, 'nothing in memory: one refresh');
  assert.deepEqual(await restarted.authHeaders('notion'), { authorization: 'Bearer at-3' });
  restarted.invalidate('notion');
  assert.deepEqual(await restarted.authHeaders('notion'), { authorization: 'Bearer at-4' });
  assert.equal(refreshes(w).length, 2);
});

test('without a refresh token the access token is kept in the vault until it expires', async (t) => {
  const w = await world({ noRefresh: true, expiresIn: 600 });
  t.after(() => w.as.close());
  await w.signIn();
  assert.deepEqual(w.vault.values(), ['at-2']);
  assert.ok(!w.kvText().includes('at-2'));
  const restarted = w.make();
  assert.deepEqual(await restarted.authHeaders('notion'), { authorization: 'Bearer at-2' }, 'read from the vault, no token call');
  assert.equal(w.as.tokenRequests.length, 1);
  w.clock.advance(590_000);
  assert.deepEqual(await restarted.authHeaders('notion'), { authorization: 'Bearer at-2' }, 'nothing to refresh with: used to the end');
  w.clock.advance(11_000);
  assert.equal(restarted.hasGrant('notion'), false);
  await assert.rejects(restarted.authHeaders('notion'), ReconnectNeeded);
  assert.equal(w.vault.entries.size, 0);
});

test('forget() revokes the refresh token, then deletes the vault entry, the grant and the registration no grant uses any more', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  await w.signIn();
  await w.oauth.forget('notion');
  assert.equal(w.as.revocations.length, 1);
  assert.equal(w.as.revocations[0]!.get('token'), 'rt-2');
  assert.equal(w.as.revocations[0]!.get('token_type_hint'), 'refresh_token');
  assert.equal(w.as.revocations[0]!.get('client_id'), 'client-1');
  assert.equal(w.vault.entries.size, 0);
  assert.equal(w.kv.get(grantKey('notion')), undefined);
  assert.equal(w.oauth.hasGrant('notion'), false);
  assert.deepEqual(await w.oauth.authHeaders('notion'), {});
  assert.equal(w.kv.keys('oauth:client:').length, 0, 'no grant uses that client: the next sign-in registers anew');
  await w.oauth.forget('notion'); // twice is harmless
});

test('forget() during a refresh waits for it, and nothing is written back', async (t) => {
  const w = await world({ revocation: false });
  t.after(() => w.as.close());
  await w.signIn();
  w.clock.advance(3_600_000);
  w.as.setTokenDelay(40);
  const running = w.oauth.authHeaders('notion');
  await w.oauth.forget('notion');
  assert.deepEqual(await running, { authorization: 'Bearer at-3' }, 'the caller still gets its token once');
  assert.equal(w.vault.entries.size, 0, 'the rotated token was not stored');
  assert.equal(w.kv.get(grantKey('notion')), undefined);
  assert.equal(w.oauth.hasGrant('notion'), false);
});
