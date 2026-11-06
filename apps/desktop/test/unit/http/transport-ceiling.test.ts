// DEV2 transport ceiling and bind gate: which peers count as secure (loopback incl. the local
// `tailscale serve` proxy, tailnet peers that reached this PC's tailnet address) versus plain LAN
// http (also a LAN using 100.64/10), device scopes carrying that flag, settings.pwa.bind
// 'tailscale' answering 403 to LAN peers on every client route while linked-PC pairing keeps its
// own rules, and LAN sockets opened before switching to 'tailscale' being closed. Remote peers
// are stood in for by replacing the server's request-facts step (the sockets are real, on loopback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { bindAllows, isLoopback, isSecureTransport, isTailnetAddress } from '../../../src/runtime/http/security.ts';
import type { RequestInfo } from '../../../src/runtime/http/types.ts';
import { BLOB_ID, DEVICE_TOKEN, LAUNCH_TOKEN, closeCode, fixture, nextMessage, openSocket, request } from './fixture.ts';

const LOOPBACK = ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'];
const TAILNET = ['100.64.0.1', '100.101.102.103', '100.127.255.254', '::ffff:100.100.1.1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', 'FD7A:115C:A1E0::53'];
const LAN = ['192.168.1.20', '10.0.0.5', '172.16.3.4', '169.254.10.1', '100.63.255.255', '100.128.0.1', 'fe80::1%eth0', 'fd7a:115c:a1e1::1', '8.8.8.8', ''];
/** This PC's own addresses: its tailnet IP and its LAN IP. */
const TAILNET_LOCAL = '100.100.1.1';
const LAN_LOCAL = '192.168.1.5';

test('secure transport: loopback, and tailnet peers on the tailnet interface; never LAN or public addresses', () => {
  for (const address of LOOPBACK) assert.ok(isSecureTransport(address, LAN_LOCAL) && isLoopback(address), address);
  for (const address of TAILNET) assert.ok(isSecureTransport(address, TAILNET_LOCAL) && isTailnetAddress(address) && !isLoopback(address), address);
  // A 100.64/10 peer that reached the LAN address (carrier-grade-NAT LAN, spoofing host) is plain LAN; no local address fails closed.
  for (const address of TAILNET) assert.ok(!isSecureTransport(address, LAN_LOCAL) && !isSecureTransport(address), address);
  for (const address of LAN) assert.ok(!isSecureTransport(address, TAILNET_LOCAL) && !isTailnetAddress(address), address);
});

test("bind gate: 'tailscale' admits loopback and tailnet peers only; 'lan' and 'localhost' admit what reached the socket", () => {
  for (const address of LOOPBACK) assert.ok(bindAllows('tailscale', address, LAN_LOCAL), address);
  for (const address of TAILNET) assert.ok(bindAllows('tailscale', address, TAILNET_LOCAL) && !bindAllows('tailscale', address, LAN_LOCAL), address);
  for (const address of LAN) assert.ok(!bindAllows('tailscale', address, TAILNET_LOCAL), address);
  for (const address of [...LOOPBACK, ...TAILNET, ...LAN]) assert.ok(bindAllows('lan', address, LAN_LOCAL) && bindAllows('localhost', address), address);
});

type Fixture = ReturnType<typeof fixture>;

/**
 * Makes every request look like it came from `remote` (proxy-free, like a direct TCP peer) and
 * arrived on `local` (default: the tailnet IP for tailnet peers, else the LAN IP).
 */
function asRemote(f: Fixture, remote: string, local = isLoopback(remote) ? '127.0.0.1' : isTailnetAddress(remote) ? TAILNET_LOCAL : LAN_LOCAL): void {
  const server = f.server as unknown as { requestFacts(req: IncomingMessage): (RequestInfo & { local: string }) | undefined };
  const original = server.requestFacts.bind(server);
  server.requestFacts = (req) => {
    const info = original(req);
    return info && { ...info, remote, local, loopback: isLoopback(remote) };
  };
}

function setBind(f: Fixture, bind: 'localhost' | 'lan' | 'tailscale'): void {
  (f.settings.pwa as { bind: string }).bind = bind;
}

const hello = (token: string) => JSON.stringify({ protocol: 1, token, client: 'pwa' });

test("bind 'tailscale': a LAN peer gets 403 on every client route; pairing routes stay open", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    setBind(f, 'tailscale');
    asRemote(f, '192.168.1.20');
    for (const path of ['/', '/main.js', `/files/${BLOB_ID}?token=${DEVICE_TOKEN}`, '/sandbox/app?m=x&i=0&e=1&t=y', '/ws']) {
      assert.equal((await request(port, { path })).status, 403, path);
    }
    const rpc = await request(port, { method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method: 'pwa.exchange', params: { secret: 's' } }) });
    assert.equal(rpc.status, 403);
    assert.equal(f.rpc.http.length, 0, 'the pairing exchange never ran');
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/ws`), /status 403/);
    assert.equal((await request(port, { path: '/.well-known/workforce' })).status, 200, 'linked-PC discovery keeps its own rules');
  } finally {
    await f.close();
  }
});

test("bind 'tailscale': tailnet and loopback peers are served", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    setBind(f, 'tailscale');
    assert.equal((await request(port, { path: '/' })).status, 200, 'loopback');
    asRemote(f, '100.101.102.103');
    assert.equal((await request(port, { path: '/' })).status, 200, 'tailnet v4');
    asRemote(f, 'fd7a:115c:a1e0::9');
    assert.equal((await request(port, { path: '/main.js' })).status, 200, 'tailnet v6');
  } finally {
    await f.close();
  }
});

test('device scopes carry secure: true on loopback/tailnet and false on plain LAN http', async () => {
  for (const [remote, bind, secure] of [['192.168.1.20', 'lan', false], ['100.101.102.103', 'tailscale', true], ['127.0.0.1', 'localhost', true]] as const) {
    const f = fixture({ pwaEnabled: true });
    try {
      const { port } = await f.server.listen();
      setBind(f, bind);
      asRemote(f, remote);
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
      ws.send(hello(DEVICE_TOKEN));
      ws.send(JSON.stringify({ id: 1, method: 'session.info' }));
      assert.deepEqual(await nextMessage(ws), { id: 1, result: { method: 'session.info', scope: 'device' } });
      assert.deepEqual(f.rpc.attached[0].scope, { kind: 'device', deviceId: 'dev_phone0000001', capabilities: ['todo'], secure }, remote);
      ws.close();
    } finally {
      await f.close();
    }
  }
});

test("a 100.64/10 peer that reached this PC's LAN address is plain LAN: 403 under 'tailscale', not secure under 'lan'", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    setBind(f, 'tailscale');
    asRemote(f, '100.101.102.103', LAN_LOCAL);
    assert.equal((await request(port, { path: '/' })).status, 403);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/ws`), /status 403/);
    setBind(f, 'lan');
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
    ws.send(hello(DEVICE_TOKEN));
    ws.send(JSON.stringify({ id: 1, method: 'session.info' }));
    await nextMessage(ws);
    assert.equal((f.rpc.attached[0].scope as { secure?: boolean }).secure, false);
    ws.close();
  } finally {
    await f.close();
  }
});

test("switching bind 'lan' to 'tailscale' closes client sockets already open over the LAN; tailnet and loopback ones stay", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    setBind(f, 'lan');
    const connect = async () => {
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
      ws.send(hello(DEVICE_TOKEN));
      ws.send(JSON.stringify({ id: 1, method: 'todos.list' }));
      await nextMessage(ws);
      return ws;
    };
    const local = await connect();
    asRemote(f, '100.101.102.103');
    const tailnet = await connect();
    asRemote(f, '192.168.1.20');
    const lan = await connect();
    const lanClosed = closeCode(lan);
    f.bus.emit('settings.updated', f.settings as never); // still 'lan': nothing is closed
    setBind(f, 'tailscale');
    f.bus.emit('settings.updated', f.settings as never);
    assert.equal(await Promise.race([lanClosed, delay(3_000, 'still open')]), 1001);
    for (const ws of [local, tailnet]) {
      ws.send(JSON.stringify({ id: 2, method: 'todos.list' }));
      assert.deepEqual(await nextMessage(ws), { id: 2, result: { method: 'todos.list', scope: 'device' } });
      ws.close();
    }
  } finally {
    await f.close();
  }
});

test('the launch token is refused from a LAN or tailnet peer (owner scope stays on this computer)', async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    setBind(f, 'lan');
    asRemote(f, '100.101.102.103');
    const ws = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const closed = closeCode(ws);
    ws.send(hello(LAUNCH_TOKEN));
    assert.equal(await closed, 4401);
    assert.equal(f.rpc.attached.length, 0);
  } finally {
    await f.close();
  }
});
