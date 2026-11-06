// HttpServer routes over real node:http on an ephemeral loopback port (fakes behind it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxDocument } from '../../../src/runtime/http/sandbox.ts';
import { SANDBOX_URL_TTL_MS, sandboxTokens } from '../../../src/runtime/http/sandbox-token.ts';
import { APP_CSP, SANDBOX_CSP } from '../../../src/runtime/http/static.ts';
import { BLOB_ID, BLOB_TEXT, DEVICE_TOKEN, LAUNCH_TOKEN, MESSAGE_ID, fixture, request } from './fixture.ts';

test('serves static UI files with MIME, cache headers and the app CSP on HTML', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    assert.equal(f.server.port, port);
    const index = await request(port, { path: '/' });
    assert.equal(index.status, 200);
    assert.match(index.text, /Workforce/);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(index.headers['content-security-policy'], APP_CSP);
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['access-control-allow-origin'], undefined);

    const sw = await request(port, { path: '/sw.js' });
    assert.equal(sw.status, 200);
    assert.equal(sw.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(sw.headers['cache-control'], 'no-cache');
    assert.equal(sw.headers['content-security-policy'], undefined);

    const chunk = await request(port, { path: '/chunks/chat-ABCDEFGH.js' });
    assert.equal(chunk.status, 200);
    assert.equal(chunk.headers['cache-control'], 'public, max-age=31536000, immutable');

    const manifest = await request(port, { path: '/manifest.webmanifest' });
    assert.equal(manifest.headers['content-type'], 'application/manifest+json');
    const icon = await request(port, { path: '/icons/icon.png' });
    assert.equal(icon.headers['content-type'], 'image/png');

    // Conditional request → 304.
    const again = await request(port, { path: '/main.js', headers: { 'if-none-match': String((await request(port, { path: '/main.js' })).headers.etag) } });
    assert.equal(again.status, 304);
  } finally {
    await f.close();
  }
});

test('SPA fallback for navigation paths, 404 for missing files and reserved prefixes', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const nav = await request(port, { path: '/chats/ch_01jab3k9z7mx2c4q' });
    assert.equal(nav.status, 200);
    assert.match(nav.text, /Workforce/);
    assert.equal(nav.headers['content-security-policy'], APP_CSP);
    assert.equal((await request(port, { path: '/missing.js' })).status, 404);
    assert.equal((await request(port, { path: '/api/anything' })).status, 404);
    assert.equal((await request(port, { path: '/files/not-a-hash' })).status, 404);
    assert.equal((await request(port, { path: '/ws' })).status, 426);
    assert.equal((await request(port, { method: 'POST', path: '/main.js', body: 'x' })).status, 405);
  } finally {
    await f.close();
  }
});

test('path traversal and dotfiles are blocked', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/chunks/..%2f..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/.env', '/foo%00.js']) {
      const reply = await request(port, { path });
      assert.notEqual(reply.status, 200, path);
      assert.doesNotMatch(reply.text, /top secret/, path);
    }
  } finally {
    await f.close();
  }
});

test('Host header allowlist rejects DNS rebinding on every route', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    for (const path of ['/', '/main.js', '/.well-known/workforce', `/files/${BLOB_ID}?token=${DEVICE_TOKEN}`]) {
      const reply = await request(port, { path, headers: { host: `evil.example:${port}` } });
      assert.equal(reply.status, 403, path);
      assert.equal(reply.json().error.code, 'forbidden');
    }
    assert.equal((await request(port, { method: 'POST', path: '/rpc', headers: { host: 'attacker.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await request(port, { path: '/', headers: { host: `localhost:${port}` } })).status, 200);
    assert.equal((await request(port, { path: '/', headers: { host: `[::1]:${port}` } })).status, 200);

    // A phone at `tailscale serve` (its MagicDNS name) or at a fixed IP is answered at once – the guard has learned nothing.
    assert.equal((await request(port, { path: '/', headers: { host: 'desk.tail1234.ts.net' } })).status, 200);
    assert.equal((await request(port, { path: '/', headers: { host: '203.0.113.7:47811' } })).status, 200);
    assert.equal((await request(port, { path: '/', headers: { host: 'desk.tail1234.ts.net.evil.example' } })).status, 403);
    // The proxy reaches this server from 127.0.0.1, yet a request for that name is a phone, not this computer: /mcp stays closed to it.
    const viaProxy = await request(port, { method: 'POST', path: '/mcp', headers: { host: 'desk.tail1234.ts.net', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(viaProxy.status, 403);
    assert.match(viaProxy.text, /only available on this computer/);
    // pwa.updated still adds the https hosts it lists (a custom domain in front of the app).
    assert.equal((await request(port, { path: '/', headers: { host: 'phone.example.org' } })).status, 403);
    f.bus.emit('pwa.updated', { enabled: true, urls: ['https://phone.example.org', `http://localhost:${port}`], secure: true, devices: [], pushReady: true });
    assert.equal((await request(port, { path: '/', headers: { host: 'phone.example.org' } })).status, 200);
  } finally {
    await f.close();
  }
});

test('foreign Origin is refused for state-changing requests', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const body = JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret: 's' } });
    const foreign = await request(port, { method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body });
    assert.equal(foreign.status, 403);
    const same = await request(port, { method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` }, body });
    assert.equal(same.status, 200);
  } finally {
    await f.close();
  }
});

test('POST /rpc hands one frame to rpc.handleHttp (pairing exchange) and limits the body', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const reply = await request(port, {
      method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json', 'x-workforce-protocol': '1' },
      body: JSON.stringify({ id: 7, method: 'pwa.exchange', params: { secret: 'one-time', name: 'iPhone · Safari' } }),
    });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json(), { id: 7, result: { token: 'new-device-token', deviceId: 'dev_new' } });
    assert.deepEqual(f.rpc.http, [{ id: 7, method: 'pwa.exchange', params: { secret: 'one-time', name: 'iPhone · Safari' } }]);

    const invalid = await request(port, { method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json().error.code, 'bad_request');

    const huge = await request(port, { method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { pad: 'x'.repeat(70 * 1024) } }) }).catch(() => ({ status: 413 }));
    assert.equal(huge.status, 413);
    assert.equal(f.rpc.http.length, 1);
    assert.equal((await request(port, { path: '/rpc' })).status, 405);
  } finally {
    await f.close();
  }
});

test('/files streams blobs with auth, Range support and protective headers', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    assert.equal((await request(port, { path: `/files/${BLOB_ID}` })).status, 401);
    assert.equal((await request(port, { path: `/files/${BLOB_ID}?token=wrong-token-0123456789` })).status, 401);

    const whole = await request(port, { path: `/files/${BLOB_ID}`, headers: { authorization: `Bearer ${DEVICE_TOKEN}` } });
    assert.equal(whole.status, 200);
    assert.equal(whole.text, BLOB_TEXT);
    assert.equal(whole.headers['content-type'], 'audio/webm');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.match(String(whole.headers['content-disposition']), /^inline; filename="clip _.webm"; filename\*=UTF-8''clip%20%C3%A4.webm$/);
    assert.match(String(whole.headers['content-security-policy']), /sandbox/);

    const part = await request(port, { path: `/files/${BLOB_ID}?token=${DEVICE_TOKEN}`, headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.text, '2345');
    assert.equal(part.headers['content-range'], `bytes 2-5/${BLOB_TEXT.length}`);

    const suffix = await request(port, { path: `/files/${BLOB_ID}?token=${DEVICE_TOKEN}`, headers: { range: 'bytes=-3' } });
    assert.equal(suffix.text, 'xyz');
    const bad = await request(port, { path: `/files/${BLOB_ID}?token=${DEVICE_TOKEN}`, headers: { range: 'bytes=999-' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers['content-range'], `bytes */${BLOB_TEXT.length}`);

    // The launch token is owner scope from this computer.
    assert.equal((await request(port, { path: `/files/${BLOB_ID}`, headers: { authorization: `Bearer ${LAUNCH_TOKEN}` } })).status, 200);
    assert.equal((await request(port, { path: `/files/${'b'.repeat(64)}?token=${DEVICE_TOKEN}` })).status, 404);
  } finally {
    await f.close();
  }
});

test('/mcp forwards token + body to the hub; GET is 405; bearer works on /mcp', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const lease = 'lease-token-0123456789abcdef';
    const call = await request(port, { method: 'POST', path: `/mcp/${lease}`, headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
    assert.equal(call.status, 200);
    assert.equal(call.headers['mcp-session-id'], 'session-1');
    assert.deepEqual(call.json(), { jsonrpc: '2.0', id: 3, result: { ok: true } });
    assert.equal(f.mcpCalls[0].token, lease);
    assert.equal(f.mcpCalls[0].headers?.['mcp-protocol-version'], '2025-06-18');

    const bearer = await request(port, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${lease}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(bearer.status, 202);
    assert.equal(bearer.text, '');
    assert.equal(f.mcpCalls[1].token, lease);
    assert.equal(f.mcpCalls[1].headers?.authorization, undefined); // never forwarded

    const unknown = await request(port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    assert.equal(unknown.status, 401);
    const parse = await request(port, { method: 'POST', path: `/mcp/${lease}`, headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(parse.status, 400);
    assert.equal(parse.json().error.code, -32700);
    const get = await request(port, { path: `/mcp/${lease}` });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
  } finally {
    await f.close();
  }
});

test('requests forwarded by a local proxy (tailscale serve) never count as this computer', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const lease = 'lease-token-0123456789abcdef';
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const forwarded = await request(port, { method: 'POST', path: `/mcp/${lease}`, headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.9' }, body });
    assert.equal(forwarded.status, 403);
    assert.equal(f.mcpCalls.length, 0);
    // The launch token is refused through the served name, a device token still works.
    f.bus.emit('pwa.updated', { enabled: true, urls: ['https://desk.tail1234.ts.net'], secure: true, devices: [], pushReady: true });
    const served = { host: 'desk.tail1234.ts.net' };
    assert.equal((await request(port, { path: `/files/${BLOB_ID}`, headers: { ...served, authorization: `Bearer ${LAUNCH_TOKEN}` } })).status, 401);
    assert.equal((await request(port, { path: `/files/${BLOB_ID}`, headers: { ...served, authorization: `Bearer ${DEVICE_TOKEN}` } })).status, 200);
  } finally {
    await f.close();
  }
});

test('/.well-known/workforce and POST /peer/pair go to pairing with the remote address', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const known = await request(port, { path: '/.well-known/workforce' });
    assert.equal(known.status, 200);
    assert.equal(known.json().app, 'workforce');
    const pair = await request(port, { method: 'POST', path: '/peer/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'link', device: {}, mac: 'x' }) });
    assert.equal(pair.status, 200);
    assert.deepEqual(pair.json(), { ok: true });
    assert.deepEqual(f.pairCalls, [{ body: { kind: 'link', device: {}, mac: 'x' }, remote: { address: '127.0.0.1' } }]);
    const tooBig = await request(port, { method: 'POST', path: '/peer/pair', headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) }, body: 'x'.repeat(65 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(tooBig.status, 413);
    assert.equal(f.pairCalls.length, 1);
  } finally {
    await f.close();
  }
});

test('/sandbox/app serves the app block in an opaque-origin sandbox document', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const tokens = sandboxTokens(f.services);
    const app = await request(port, { path: tokens.mint(MESSAGE_ID, 0).url });
    assert.equal(app.status, 200);
    assert.equal(app.headers['content-security-policy'], SANDBOX_CSP);
    assert.equal(app.headers['cache-control'], 'no-store');
    assert.match(app.text, /<button>Go<\/button>/);
    assert.match(app.text, /window\.wf = \{ ready: true \}/);
    assert.doesNotMatch(app.text, /\/\/ <\/script> inside/); // inline helper is escaped
    assert.equal((await request(port, { path: tokens.mint(MESSAGE_ID, 1).url })).status, 404);
    assert.equal((await request(port, { path: '/sandbox/app?m=../x&i=0' })).status, 400);
    const helper = await request(port, { path: '/sandbox/wf.js' });
    assert.equal(helper.status, 200);
  } finally {
    await f.close();
  }
});

test('/sandbox/app needs a valid unexpired capability token: the message id alone gets 403', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const tokens = sandboxTokens(f.services);
    const { url } = tokens.mint(MESSAGE_ID, 0);
    const query = new URL(url, 'http://x').searchParams;
    const bare = await request(port, { path: `/sandbox/app?m=${MESSAGE_ID}&i=0` });
    assert.equal(bare.status, 403);
    assert.equal(bare.json().error.code, 'forbidden');
    assert.doesNotMatch(bare.text, /<button>/);
    // The token is bound to message + block + expiry.
    assert.equal((await request(port, { path: `/sandbox/app?m=${MESSAGE_ID}&i=1&e=${query.get('e')}&t=${query.get('t')}` })).status, 403);
    assert.equal((await request(port, { path: `/sandbox/app?m=${MESSAGE_ID}&i=0&e=${Number(query.get('e')) + 60_000}&t=${query.get('t')}` })).status, 403);
    assert.equal((await request(port, { path: `${url.replace(/t=[^&]+/, `t=${'A'.repeat(43)}`)}` })).status, 403);
    // HEAD follows the same rule.
    assert.equal((await request(port, { method: 'HEAD', path: url })).status, 200);
    assert.equal((await request(port, { method: 'HEAD', path: `/sandbox/app?m=${MESSAGE_ID}&i=0` })).status, 403);
    // Valid for 10 minutes of runtime time.
    f.clock.advance(SANDBOX_URL_TTL_MS - 1);
    assert.equal((await request(port, { path: url })).status, 200);
    f.clock.advance(1);
    assert.equal((await request(port, { path: url })).status, 403);
  } finally {
    await f.close();
  }
});

test('a Host name from allowedHosts (a domain in front of the app) is served; others still get 403', async () => {
  let names: string[] = [];
  const f = fixture({ allowedHosts: () => names });
  try {
    const { port } = await f.server.listen();
    const magic = { host: `phone.example.org:${port}` };
    assert.equal((await request(port, { path: '/', headers: magic })).status, 403);
    names = ['phone.example.org'];
    assert.equal((await request(port, { path: '/', headers: magic })).status, 200);
    assert.equal((await request(port, { path: '/', headers: { host: `evil.example:${port}` } })).status, 403);
  } finally {
    await f.close();
  }
});

test('sandboxDocument puts the helper into <head>, never into a <header> element', () => {
  const doc = sandboxDocument('<html><body><header>Top</header><script>wf.ready()</script></body></html>', 'window.wf={}');
  assert.match(doc, /^<html><head><meta charset="utf-8">.*<script>window\.wf=\{\}<\/script><\/head><body><header>Top<\/header>/);
  const withHead = sandboxDocument('<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>', 'h()');
  assert.match(withHead, /<head><meta charset="utf-8">[^]*<script>h\(\)<\/script><title>x<\/title>/);
  const fragment = sandboxDocument('<button>Go</button>', undefined);
  assert.equal(fragment, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><button>Go</button></body></html>');
});
