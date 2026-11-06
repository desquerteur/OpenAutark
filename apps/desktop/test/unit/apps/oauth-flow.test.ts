// B-052 track B: the MCP sign-in against a fake authorization server – path-aware discovery, a native public client
// registration (stored per issuer and reused by the next app), the stable loopback port (moved to the next free one
// and registered again when it is busy, kept when only another sign-in of this PC holds it), PKCE S256 + state +
// resource in the authorization address, the grant in the vault (no token in KV), the header from memory, a removal
// during the code exchange, a client secret the server insists on, and the 403 step-up.
// Owns: checks of runtime/apps/oauth/index.ts (with discover/register/loopback/tokens) only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PORT_FIRST, PORT_KEY, PORT_LAST } from '../../../src/runtime/apps/oauth/index.ts';
import { world } from './oauth-fixture.ts';

test('a first sign-in: path-aware discovery, a native public registration, PKCE S256, state and resource; the grant goes to the vault', async (t) => {
  const w = await world({ prmScopes: ['read', 'write'], asScopes: ['read', 'write', 'offline_access'] });
  t.after(() => w.as.close());
  const start = await w.oauth.begin({ appId: 'notion', appName: 'Notion', resourceUrl: w.as.mcpUrl, challenge: w.challenge() });
  assert.ok(w.as.hits.includes('GET /.well-known/oauth-protected-resource/mcp'), 'the path-aware resource metadata');
  assert.ok(w.as.hits.includes('GET /.well-known/oauth-authorization-server'));

  const port = w.loopback.port();
  assert.ok(port >= PORT_FIRST && port <= PORT_LAST, 'a port of the stable range');
  assert.equal(w.kv.get(PORT_KEY), port, 'picked once and kept');
  assert.equal(w.as.registrations.length, 1);
  assert.deepEqual(w.as.registrations[0], {
    client_name: 'Workforce', redirect_uris: [`http://127.0.0.1:${port}/callback`], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native',
  });

  const url = new URL(start.authUrl);
  const params = url.searchParams;
  assert.equal(`${url.origin}${url.pathname}`, `${w.as.base}/authorize`);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('client_id'), 'client-1');
  assert.equal(params.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('code_challenge')!.length, 43);
  assert.ok(params.get('state')!.length >= 20);
  assert.equal(params.get('resource'), `${w.as.base}/mcp`);
  assert.equal(params.get('scope'), 'read write offline_access', 'offline_access only because the server lists it');
  assert.equal(params.get('prompt'), 'consent');

  const page = w.loopback.hit(w.as.authorize(start.authUrl));
  assert.equal(page.status, 200);
  assert.match(page.body, /You're signed in – you can close this tab\./);
  await start.done;
  assert.equal(w.loopback.isOpen(), false, 'the listener closes after the one answer');

  const [exchange] = w.as.tokenRequests;
  assert.equal(exchange!.params.get('grant_type'), 'authorization_code');
  assert.equal(exchange!.params.get('resource'), `${w.as.base}/mcp`);
  assert.equal(createHash('sha256').update(exchange!.params.get('code_verifier')!).digest('base64url'), params.get('code_challenge'));

  const entries = [...w.vault.entries.values()];
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { label: 'Notion sign-in', kind: 'token', value: 'rt-2', source: '127.0.0.1' });
  for (const token of ['rt-2', 'at-2']) assert.ok(!w.kvText().includes(token), `no ${token} outside the vault`);

  assert.deepEqual(await w.oauth.authHeaders('notion'), { authorization: 'Bearer at-2' });
  assert.equal(w.as.tokenRequests.length, 1, 'the access token from the sign-in is used from memory');
  assert.equal(w.oauth.hasGrant('notion'), true);
  assert.equal(w.oauth.hasGrant('linear'), false);
  assert.deepEqual(await w.oauth.authHeaders('linear'), {}, 'no grant: no header');
});

test('the registration at an issuer is reused by the next app; a busy port moves to the next free one and registers again', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  w.kv.set(PORT_KEY, 33420);
  await w.signIn('notion');
  assert.equal(w.loopback.port(), 33420, 'the stored port');
  await w.signIn('second');
  assert.equal(w.as.registrations.length, 1, 'one registration per issuer');
  assert.equal(new URL(w.as.tokenRequests.at(-1)!.params.get('redirect_uri')!).port, '33420');

  w.loopback.busy.add(33420);
  const moved = await w.signIn('third');
  assert.equal(w.loopback.port(), 33421, 'the next port of the range');
  assert.equal(w.as.registrations.length, 2, 'the redirect changed, so Workforce registers again');
  assert.deepEqual(w.as.registrations[1]!.redirect_uris, ['http://127.0.0.1:33421/callback']);
  assert.equal(moved.params.get('client_id'), 'client-2');
  assert.equal(w.kv.get(PORT_KEY), 33421, 'the new port is the install port from now on');

  w.loopback.busy.clear();
  const again = await w.signIn('fourth');
  assert.equal(w.loopback.port(), 33421, "the registration's port comes first");
  assert.equal(again.params.get('client_id'), 'client-2');
  assert.equal(w.as.registrations.length, 2);
  assert.deepEqual(await w.oauth.authHeaders('notion'), { authorization: 'Bearer at-2' }, 'earlier grants keep working');
});

test('two sign-ins at once: the second takes the next port and the install port stays; a removal during the code exchange stores nothing', async (t) => {
  const w = await world();
  t.after(() => w.as.close());
  w.kv.set(PORT_KEY, 33430);
  const begin = (appId: string) => w.oauth.begin({ appId, appName: appId, resourceUrl: w.as.mcpUrl, challenge: w.challenge() });
  const a = await begin('notion');
  const b = await begin('linear');
  assert.deepEqual(w.loopback.openPorts().sort(), [33430, 33431]);
  assert.equal(w.kv.get(PORT_KEY), 33430, 'its own other listener does not move the install port');
  w.loopback.back(b.authUrl, w.as.authorize(b.authUrl));
  w.loopback.back(a.authUrl, w.as.authorize(a.authUrl));
  await Promise.all([a.done, b.done]);
  assert.equal(w.oauth.hasGrant('notion'), true);
  assert.equal(w.oauth.hasGrant('linear'), true);

  const entries = w.vault.entries.size;
  const removed = await begin('removed');
  w.as.setTokenDelay(40);
  w.loopback.back(removed.authUrl, w.as.authorize(removed.authUrl));
  await w.oauth.forget('removed');
  await assert.rejects(removed.done, (error: Error & { code?: string }) => error.code === 'cancelled');
  assert.equal(w.oauth.hasGrant('removed'), false);
  assert.equal(w.vault.entries.size, entries, 'no vault entry for a removed app');
});

test('the 401 header names the metadata; an issuer with a path uses the path-aware address; without resource metadata the origin is the issuer', async (t) => {
  const header = await world({ prm: 'root', issuerPath: '/tenant' });
  t.after(() => header.as.close());
  await header.signIn('notion', header.challenge({ resourceMetadata: `${header.as.base}/.well-known/oauth-protected-resource` }));
  assert.ok(!header.as.hits.includes('GET /.well-known/oauth-protected-resource/mcp'), 'the header address only');
  assert.ok(header.as.hits.includes('GET /.well-known/oauth-authorization-server/tenant'));
  assert.equal(header.oauth.hasGrant('notion'), true);

  const root = await world({ prm: 'root' });
  t.after(() => root.as.close());
  await root.signIn();
  const prm = root.as.hits.filter((hit) => hit.includes('oauth-protected-resource'));
  assert.deepEqual(prm, ['GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-protected-resource'], 'path-aware first, then the root');

  const legacy = await world({ prm: 'none' });
  t.after(() => legacy.as.close());
  const { params } = await legacy.signIn();
  assert.equal(params.get('resource'), `${legacy.as.base}/mcp`, 'the canonical app address');
  assert.equal(legacy.oauth.hasGrant('notion'), true);
});

test('a client secret the server insists on goes to the vault and authenticates the token calls', async (t) => {
  const w = await world({ clientSecret: 'cs-hidden' });
  t.after(() => w.as.close());
  await w.signIn();
  assert.equal(w.as.tokenRequests[0]!.params.get('client_secret'), 'cs-hidden');
  assert.ok(!w.kvText().includes('cs-hidden'), 'only its vault id is in KV');
  assert.ok(w.vault.values().includes('cs-hidden'));
  const labels = [...w.vault.entries.values()].map((entry) => entry.label).sort();
  assert.deepEqual(labels, ['Notion sign-in', 'Sign-in registration at 127.0.0.1']);
  w.clock.advance(3_600_000);
  await w.oauth.authHeaders('notion');
  assert.equal(w.as.tokenRequests[1]!.params.get('client_secret'), 'cs-hidden', 'the refresh authenticates too');
});

test('a 403 insufficient_scope step-up asks for the granted scopes united with the challenged ones', async (t) => {
  const w = await world({ prmScopes: ['read'] });
  t.after(() => w.as.close());
  const first = await w.signIn();
  assert.equal(first.params.get('scope'), 'read');
  const second = await w.signIn('notion', w.challenge({ status: 403, scope: 'write admin', error: 'insufficient_scope' }));
  assert.equal(second.params.get('scope'), 'write admin read');
  assert.equal(w.as.registrations.length, 1);
  assert.equal([...w.vault.entries.keys()].length, 1, 'the new grant replaces the old one in the same vault entry');
  assert.deepEqual(await w.oauth.authHeaders('notion'), { authorization: 'Bearer at-4' }, 'the token of the second sign-in');
  const fresh = await w.signIn('notion', w.challenge({ scope: 'other' }));
  assert.equal(fresh.params.get('scope'), 'other', 'a 401 asks for what the challenge names');
});
