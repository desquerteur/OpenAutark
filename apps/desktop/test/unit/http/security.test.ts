// Pure security helpers, the loopback rule of /mcp and port selection of the HTTP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { HostGuard, RateLimiter, bearerToken, hostOf, isLoopback, normalizeAddress, tokensEqual } from '../../../src/runtime/http/security.ts';
import { cacheControlFor, resolveUnder } from '../../../src/runtime/http/static.ts';
import { parseRange } from '../../../src/runtime/http/files.ts';
import { handleMcp } from '../../../src/runtime/http/mcp.ts';
import { DEFAULT_PORT, bindHostFor, rememberedPort } from '../../../src/runtime/http/listen.ts';
import { fixture, request } from './fixture.ts';
import { silentLog } from '../devices/fakes.ts';

test('host parsing, loopback detection and the Host allowlist', () => {
  assert.equal(hostOf('LocalHost:47811'), 'localhost');
  assert.equal(hostOf('[::1]:47811'), '::1');
  assert.equal(hostOf('pc.tailnet.ts.net.'), 'pc.tailnet.ts.net');
  assert.equal(hostOf('evil.com/x'), undefined);
  assert.equal(hostOf(undefined), undefined);
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  assert.ok(isLoopback('::1'));
  assert.ok(!isLoopback('192.168.1.20'));

  let reads = 0;
  let now = 0;
  const interfaces = { eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }], ts: [{ address: '100.101.102.103', family: 'IPv4', internal: false }] };
  const guard = new HostGuard({ interfaces: () => { reads++; return interfaces as never; }, hostname: () => 'DESK', extra: () => ['studio.local:47811'], now: () => now });
  assert.ok(guard.allows('127.0.0.1:47811'));
  assert.ok(guard.allows('192.168.1.20:47811'));
  assert.ok(guard.allows('100.101.102.103'));
  assert.ok(guard.allows('desk:47811'));
  assert.ok(guard.allows('desk.local'));
  assert.ok(guard.allows('studio.local'));
  assert.ok(!guard.allows('evil.example'));
  assert.ok(!guard.allows(undefined));
  // A miss re-reads interfaces at most every few seconds (no timers).
  const before = reads;
  guard.allows('other.example');
  assert.equal(reads, before);
  now = 10_000;
  guard.allows('other.example');
  assert.equal(reads, before + 1);
  guard.setServed(['https://desk.tail1.ts.net', 'http://localhost:47811']);
  assert.ok(guard.allows('desk.tail1.ts.net'));
  assert.ok(guard.isServed('desk.tail1.ts.net:443'));
  assert.ok(guard.allowsOrigin(undefined));
  assert.ok(guard.allowsOrigin('https://desk.tail1.ts.net'));
  assert.ok(!guard.allowsOrigin('https://evil.example'));
  assert.ok(!guard.allowsOrigin('null'));
});

test('tokens, bearer parsing and the rate limiter', () => {
  assert.ok(tokensEqual('abc', 'abc'));
  assert.ok(!tokensEqual('abc', 'abd'));
  assert.ok(!tokensEqual('', 'abc'));
  assert.ok(!tokensEqual(undefined, 'abc'));
  assert.equal(bearerToken('Bearer abc.DEF-123'), 'abc.DEF-123');
  assert.equal(bearerToken('Basic abc'), undefined);
  let now = 0;
  const limiter = new RateLimiter(2, 1000, () => now);
  assert.ok(limiter.take('a'));
  assert.ok(limiter.take('a'));
  assert.ok(!limiter.take('a'));
  assert.ok(limiter.take('b'));
  now = 1000;
  assert.ok(limiter.take('a'));
});

test('static path mapping, cache policy and range parsing', () => {
  const root = process.platform === 'win32' ? 'C:\\ui' : '/ui';
  assert.ok(resolveUnder(root, '/')?.endsWith('index.html'));
  assert.equal(resolveUnder(root, '/..%2fsecret'), null);
  assert.equal(resolveUnder(root, '/a%5c..%5c..%5cx'), null);
  assert.equal(resolveUnder(root, '/.git/config'), null);
  assert.equal(resolveUnder(root, '/%E0%A4%A'), null);
  assert.equal(cacheControlFor('index.html'), 'no-cache');
  assert.equal(cacheControlFor('main.js'), 'no-cache');
  assert.equal(cacheControlFor('chunks/x-ABCDEFGH.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('font-QWERTY12.woff2'), 'public, max-age=31536000, immutable');
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'invalid');
  assert.equal(parseRange('bytes=1-2,4-5', 10), 'invalid');
  assert.equal(parseRange(undefined, 10), null);
});

test('/mcp refuses non-loopback callers before touching the hub', async () => {
  const calls: unknown[] = [];
  const mcp = { handle: async (token: string | undefined, body: unknown) => { calls.push({ token, body }); return { status: 200, body: {} }; } };
  const server = createServer((req, res) => {
    const remote = req.headers['x-test-remote'] === 'lan' ? '192.168.1.50' : '127.0.0.1';
    void handleMcp(req, res, { url: new URL(`http://localhost${req.url}`), remote, loopback: remote === '127.0.0.1' }, { mcp, log: () => silentLog }, 'lease-token-0123456789abcdef');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const lan = await request(port, { method: 'POST', path: '/mcp', headers: { 'x-test-remote': 'lan', 'content-type': 'application/json' }, body });
    assert.equal(lan.status, 403);
    assert.equal(calls.length, 0);
    const local = await request(port, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body });
    assert.equal(local.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('bind setting maps to the listen address', () => {
  assert.equal(DEFAULT_PORT, 47811);
  assert.equal(bindHostFor('localhost'), '127.0.0.1');
  assert.equal(bindHostFor('lan'), '0.0.0.0');
  assert.equal(bindHostFor('tailscale'), '0.0.0.0');
});

test('busy configured port falls back to another port and remembers it; close frees it', async () => {
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = (blocker.address() as { port: number }).port;
  const f = fixture({ port: busy });
  try {
    const { host, port } = await f.server.listen();
    assert.equal(host, '127.0.0.1');
    assert.notEqual(port, busy);
    assert.equal(f.server.port, port);
    assert.equal(rememberedPort(f.services), port);
    assert.equal((await request(port, { path: '/' })).status, 200);
    assert.deepEqual(await f.server.listen(), { host, port }); // idempotent
    await f.server.close();
    await assert.rejects(request(port, { path: '/' }));
  } finally {
    await f.close();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('a changed bind host re-listens on the same port', async (t) => {
  const f = fixture();
  let bindHost = '127.0.0.1';
  // Re-point bind() at a mutable host (settings.pwa.bind changes in the real runtime).
  (f.server as unknown as { deps: { bind: () => { host: string; port: number } } }).deps.bind = () => ({ host: bindHost, port: 0 });
  try {
    const { port } = await f.server.listen();
    bindHost = '127.0.0.2';
    f.bus.emit('settings.updated', {} as never);
    await f.server.rebind();
    const moved = await request(port, { host: '127.0.0.2', path: '/' }).catch((error: NodeJS.ErrnoException) => error);
    if (moved instanceof Error) {
      t.skip(`127.0.0.2 not usable here (${moved.code})`);
      return;
    }
    assert.equal(moved.status, 200);
    assert.equal(f.server.port, port);
  } finally {
    await f.close();
  }
});

test('close() while listen() is still binding never leaves a listener behind', async () => {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const free = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  const f = fixture({ port: free });
  try {
    const starting = f.server.listen();
    await f.server.close();
    await assert.rejects(starting, /closed while starting/);
    await assert.rejects(request(free, { path: '/' }));
  } finally {
    await f.close();
  }
});

test('a phone through tailscale serve or at a fixed IP is not answered 403 – a made-up name still is', () => {
  const guard = new HostGuard({ interfaces: () => ({ eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] }) as never, hostname: () => 'DESK' });
  // Nothing was ever told to the guard (PwaState.urls lists no https address): the MagicDNS name is enough.
  assert.ok(guard.allows('desk.tail1.ts.net'));
  assert.ok(guard.allows('DESK.Tail1.ts.net:443'));
  assert.ok(guard.isServed('desk.tail1.ts.net'), 'such a request counts as remote even from the proxy on 127.0.0.1');
  assert.ok(guard.allowsOrigin('https://desk.tail1.ts.net'));
  // A fixed or public IP (not an address of this PC): the browser typed the address itself, there was no DNS name to rebind.
  assert.ok(guard.allows('203.0.113.7:47811'));
  assert.ok(guard.allows('[2001:db8::7]:47811'));
  assert.ok(guard.allowsOrigin('http://203.0.113.7:47811'));
  assert.ok(!guard.isServed('203.0.113.7'));
  // Names are not addresses: a name that only looks like one, and look-alikes of ts.net, stay refused.
  for (const host of ['203.0.113.7.evil.example', 'ts.net', 'desk.ts.net.evil.example', 'desk.tsxnet', 'evil-ts.net', 'evil.example']) {
    assert.ok(!guard.allows(host), host);
  }
  assert.ok(!guard.isServed('evil.example'));
});
