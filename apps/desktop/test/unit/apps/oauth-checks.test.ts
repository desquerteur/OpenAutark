// B-052 track B: what an MCP sign-in refuses – an issuer that does not match, a server without PKCE S256, no way to
// register (OAuthUnsupported, before any listener opens), resource metadata of another address, a wrong state, a
// wrong or missing `iss`, the person's refusal, the 5-minute timeout, cancel/close/replacement – and the pure parts:
// scope choice, canonical resource, well-known addresses, the endpoint URL rule; errors never carry a body or a token.
// Owns: checks of runtime/apps/oauth/{discover,index}.ts refusals only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthUnsupported } from '../../../src/runtime/apps/types.ts';
import {
  canonicalResource, chooseScopes, resourceCovers, resourceMetadataCandidates, serverMetadataCandidates,
} from '../../../src/runtime/apps/oauth/discover.ts';
import { endpointUrl } from '../../../src/runtime/apps/oauth/http.ts';
import { world } from './oauth-fixture.ts';

const coded = (code: string) => (error: Error & { code?: string }) => error.code === code;

test('an issuer that does not match its metadata and a server without S256 are refused before anything opens', async (t) => {
  const wrong = await world({ wrongIssuer: true });
  t.after(() => wrong.as.close());
  await assert.rejects(wrong.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: wrong.as.mcpUrl, challenge: wrong.challenge() }), coded('forbidden'));
  assert.deepEqual(wrong.loopback.tried, [], 'no listener');
  assert.equal(wrong.as.registrations.length, 0);

  const plain = await world({ s256: false });
  t.after(() => plain.as.close());
  await assert.rejects(plain.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: plain.as.mcpUrl, challenge: plain.challenge() }),
    (error: Error & { code?: string }) => error.code === 'forbidden' && /PKCE/.test(error.message));
});

test('no registration endpoint, or no sign-in metadata at all: OAuthUnsupported (the token prompt)', async (t) => {
  const closed = await world({ registration: false });
  t.after(() => closed.as.close());
  await assert.rejects(closed.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: closed.as.mcpUrl, challenge: closed.challenge() }), OAuthUnsupported);
  assert.deepEqual(closed.loopback.tried, []);

  const none = await world({ prm: 'none', issuerPath: '/elsewhere' });
  t.after(() => none.as.close());
  await assert.rejects(none.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: none.as.mcpUrl, challenge: none.challenge() }), OAuthUnsupported);
});

test('resource metadata that belongs to another address is refused', async (t) => {
  const w = await world({ prmResource: 'http://127.0.0.1:1/other' });
  t.after(() => w.as.close());
  await assert.rejects(w.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: w.as.mcpUrl, challenge: w.challenge() }), coded('forbidden'));
});

test('a wrong state is answered and ignored: any page could send one, so the open sign-in goes on', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  const start = await w.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: w.as.mcpUrl, challenge: w.challenge() });
  const forged = w.loopback.hit(w.as.authorize(start.authUrl, { state: 'forged' }));
  assert.equal(forged.status, 400);
  assert.match(forged.body, /This is not the sign-in that is open/);
  assert.equal(w.loopback.isOpen(), true, 'still waiting for the real answer');
  w.loopback.hit(w.as.authorize(start.authUrl));
  await start.done;
  assert.equal(w.oauth.hasGrant('a'), true);
});

test('a wrong iss and a missing iss (when the server sends it) end the sign-in without a token call', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  for (const extra of [{ iss: 'http://evil.example' }, { iss: null }]) {
    const start = await w.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: w.as.mcpUrl, challenge: w.challenge() });
    const page = w.loopback.hit(w.as.authorize(start.authUrl, extra));
    assert.equal(page.status, 400);
    assert.match(page.body, /Sign-in failed – go back to Autark\./);
    await assert.rejects(start.done, coded('forbidden'));
    assert.equal(w.loopback.isOpen(), false);
  }
  assert.equal(w.as.tokenRequests.length, 0);
  assert.equal(w.oauth.hasGrant('a'), false);

  const quiet = await world({ issParameter: false });
  t.after(() => quiet.as.close());
  const start = await quiet.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: quiet.as.mcpUrl, challenge: quiet.challenge() });
  quiet.loopback.hit(quiet.as.authorize(start.authUrl, { iss: null }));
  await start.done;
  assert.equal(quiet.oauth.hasGrant('a'), true, 'a server that does not send iss signs in without it');
});

test("the person's refusal, the timeout, cancel(), close() and a newer sign-in end it", async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  const begin = () => w.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: w.as.mcpUrl, challenge: w.challenge() });

  const denied = await begin();
  w.loopback.hit(w.as.authorize(denied.authUrl, { error: 'access_denied' }));
  await assert.rejects(denied.done, coded('cancelled'));

  const odd = await begin();
  w.loopback.hit(w.as.authorize(odd.authUrl, { error: 'server_error' }));
  await assert.rejects(odd.done, (error: Error) => error.message === 'The app did not finish the sign-in (server_error).');

  const slow = await begin();
  assert.equal(w.timers.pending.length, 1);
  assert.equal(w.timers.pending[0]!.ms, 5 * 60_000);
  w.timers.fireAll();
  await assert.rejects(slow.done, coded('timeout'));

  const cancelled = await begin();
  cancelled.cancel();
  await assert.rejects(cancelled.done, coded('cancelled'));
  cancelled.cancel(); // twice is harmless

  const first = await begin();
  const second = await begin();
  await assert.rejects(first.done, (error: Error) => /replaced/.test(error.message));
  w.oauth.close();
  await assert.rejects(second.done, coded('cancelled'));
  assert.equal(w.timers.pending.length, 0, 'every timer is cleared');
  assert.equal(w.as.tokenRequests.length, 0);
});

test('a failed code exchange says HTTP status and code only, never the body', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  w.as.failTokenCalls(500);
  const start = await w.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: w.as.mcpUrl, challenge: w.challenge() });
  w.loopback.hit(w.as.authorize(start.authUrl));
  await assert.rejects(start.done, (error: Error) => error.message === 'The sign-in could not be finished (HTTP 500, server_error). Try again.' && !/secret body/.test(error.message));
  assert.equal(w.oauth.hasGrant('a'), false);
  assert.equal(w.vault.entries.size, 0);
});

test('a server that no longer knows the registration (invalid_client): the next sign-in registers again', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  w.as.failTokenCalls(401, 'invalid_client');
  const start = await w.oauth.begin({ appId: 'a', appName: 'A', resourceUrl: w.as.mcpUrl, challenge: w.challenge() });
  w.loopback.hit(w.as.authorize(start.authUrl));
  await assert.rejects(start.done, coded('unavailable'));
  assert.deepEqual(w.kv.keys('oauth:client:'), [], 'the registration is forgotten');
  w.as.failTokenCalls(undefined);
  const again = await w.signIn('a');
  assert.equal(again.params.get('client_id'), 'client-2');
  assert.equal(w.oauth.hasGrant('a'), true);
});

test('scope choice: the challenge first, else the resource scopes; offline_access only when listed; a step-up unites', () => {
  assert.deepEqual(chooseScopes({ challenge: 'a b', resourceScopes: ['x'] }), ['a', 'b']);
  assert.deepEqual(chooseScopes({ resourceScopes: ['x', 'y'] }), ['x', 'y']);
  assert.deepEqual(chooseScopes({}), []);
  assert.deepEqual(chooseScopes({ resourceScopes: ['x'], serverScopes: ['x', 'offline_access'] }), ['x', 'offline_access']);
  assert.deepEqual(chooseScopes({ serverScopes: ['offline_access'] }), [], 'never offline_access alone');
  assert.deepEqual(chooseScopes({ challenge: 'write', granted: ['read', 'write'] }), ['write', 'read']);
});

test('canonical resource, coverage and the well-known addresses', () => {
  assert.equal(canonicalResource('https://mcp.example.com/mcp/#frag'), 'https://mcp.example.com/mcp');
  assert.equal(canonicalResource('https://MCP.example.com/'), 'https://mcp.example.com');
  assert.equal(resourceCovers('https://mcp.example.com', 'https://mcp.example.com/mcp'), true);
  assert.equal(resourceCovers('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp'), true);
  assert.equal(resourceCovers('https://mcp.example.com/mc', 'https://mcp.example.com/mcp'), false);
  assert.equal(resourceCovers('https://other.example.com', 'https://mcp.example.com/mcp'), false);
  assert.deepEqual(resourceMetadataCandidates('https://mcp.example.com/v2/mcp'), [
    'https://mcp.example.com/.well-known/oauth-protected-resource/v2/mcp', 'https://mcp.example.com/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(resourceMetadataCandidates('https://mcp.example.com'), ['https://mcp.example.com/.well-known/oauth-protected-resource']);
  assert.deepEqual(serverMetadataCandidates('https://auth.example.com/tenant1'), [
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    'https://auth.example.com/.well-known/openid-configuration/tenant1',
    'https://auth.example.com/tenant1/.well-known/openid-configuration',
  ]);
  assert.deepEqual(serverMetadataCandidates('https://auth.example.com'), [
    'https://auth.example.com/.well-known/oauth-authorization-server', 'https://auth.example.com/.well-known/openid-configuration',
  ]);
  assert.throws(() => resourceMetadataCandidates('https://mcp.example.com/mcp', 'http://intranet.example/prm'), coded('forbidden'));
});

test('endpoints: HTTPS, plain HTTP only on this PC, never credentials or a fragment', () => {
  assert.ok(endpointUrl('https://auth.example.com/token'));
  assert.ok(endpointUrl('http://127.0.0.1:8080/token'));
  assert.ok(endpointUrl('http://localhost/token'));
  assert.equal(endpointUrl('http://auth.example.com/token'), undefined);
  assert.equal(endpointUrl('https://user:pw@auth.example.com/token'), undefined);
  assert.equal(endpointUrl('https://auth.example.com/token#x'), undefined);
  assert.equal(endpointUrl('javascript:alert(1)'), undefined);
  assert.equal(endpointUrl(42), undefined);
});
