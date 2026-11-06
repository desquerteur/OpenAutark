// MP1: the runtime HTTP server's linked-PC routes (/.well-known/workforce, POST /peer/pair, the
// /peer upgrade) follow settings.devices.peer like the dedicated peer listener – 'lan' every
// peer, 'tailscale' tailnet peers on the tailnet address only, 'off' this computer only (same-host
// runtimes and tests; requests a local proxy such as `tailscale serve` forwards from 127.0.0.1 are
// not this computer) – independently of the phone bind gate. Remote peers are stood in for by
// replacing the server's request-facts step (the sockets are real, on loopback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { isLoopback } from '../../../src/runtime/http/security.ts';
import type { RequestInfo } from '../../../src/runtime/http/types.ts';
import { fixture, openSocket, request } from './fixture.ts';

type Fixture = ReturnType<typeof fixture>;

/** Every request looks like it came from `remote` and arrived on `local`. */
function asRemote(f: Fixture, remote: string, local: string): void {
  const server = f.server as unknown as { requestFacts(req: IncomingMessage): (RequestInfo & { local: string }) | undefined };
  const original = server.requestFacts.bind(server);
  server.requestFacts = (req) => {
    const info = original(req);
    return info && { ...info, remote, local, loopback: isLoopback(remote) };
  };
}

const setPeer = (f: Fixture, peer: 'lan' | 'tailscale' | 'off') => { (f.settings as Record<string, unknown>).devices = { peer, peerPort: 47812 }; };

async function peerRoutes(port: number, headers: Record<string, string> = {}): Promise<number[]> {
  const known = await request(port, { path: '/.well-known/workforce', headers });
  const pair = await request(port, { method: 'POST', path: '/peer/pair', headers: { ...headers, 'content-type': 'application/json' }, body: '{"kind":"link"}' });
  const upgrade = await openSocket(`ws://127.0.0.1:${port}/peer`, headers).then((ws) => { ws.close(); return 101; }, (error: Error) => Number(/status (\d+)/.exec(error.message)?.[1] ?? 0));
  return [known.status, pair.status, upgrade];
}

test("linked-PC routes on the runtime server follow devices.peer: 'lan' all, 'tailscale' tailnet only, 'off' this computer only", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    (f.settings.pwa as { bind: string }).bind = 'lan';
    asRemote(f, '192.168.1.20', '192.168.1.5');

    setPeer(f, 'lan');
    assert.deepEqual(await peerRoutes(port), [200, 200, 101]);
    setPeer(f, 'tailscale');
    assert.deepEqual(await peerRoutes(port), [403, 403, 403], 'a LAN peer under tailscale-only');
    const refused = await request(port, { path: '/.well-known/workforce' });
    assert.match(refused.json().error.message, /linked PCs/);
    setPeer(f, 'off');
    assert.deepEqual(await peerRoutes(port), [403, 403, 403]);
    assert.equal((await request(port, { path: '/' })).status, 200, 'phone routes keep the phone bind gate');
    assert.equal(f.pairCalls.length, 1, 'refused requests never reach pairing');
    assert.equal(f.accepted.length, 1, 'refused upgrades never reach the mesh');
  } finally {
    await f.close();
  }
});

test("devices.peer 'tailscale' serves tailnet peers on the tailnet address; 'off' still serves this computer", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    const { port } = await f.server.listen();
    setPeer(f, 'tailscale');
    asRemote(f, '100.64.0.2', '100.100.1.1');
    assert.deepEqual(await peerRoutes(port), [200, 200, 101]);

    const g = fixture();
    try {
      const { port: local } = await g.server.listen();
      setPeer(g, 'off');
      assert.deepEqual(await peerRoutes(local), [200, 200, 101], 'loopback: same-host runtimes and tests');
    } finally {
      await g.close();
    }
  } finally {
    await f.close();
  }
});

test("devices.peer 'off' refuses requests a local proxy (tailscale serve) forwards from 127.0.0.1; 'tailscale' admits them", async () => {
  const f = fixture({ pwaEnabled: true });
  try {
    f.setServedUrls(['https://desk.tail1234.ts.net']); // learned at listen, so the served Host passes the Host allowlist
    const { port } = await f.server.listen();
    const forwarded = { 'x-forwarded-for': '100.64.0.9' };
    const identity = { 'tailscale-user-login': 'someone@example.com' };
    const served = { host: 'desk.tail1234.ts.net' };

    setPeer(f, 'off');
    assert.deepEqual(await peerRoutes(port, forwarded), [403, 403, 403], 'x-forwarded-for is not this computer');
    assert.deepEqual(await peerRoutes(port, identity), [403, 403, 403], 'tailscale-user-login is not this computer');
    assert.deepEqual(await peerRoutes(port, served), [403, 403, 403], 'the served https name is not this computer');
    for (const headers of [forwarded, identity, served]) {
      const refused = await request(port, { path: '/.well-known/workforce', headers });
      assert.match(refused.json().error.message, /linked PCs/, 'refused by the devices.peer gate, not by the Host allowlist');
    }
    assert.equal(f.pairCalls.length, 0, 'refused requests never reach pairing');
    assert.equal(f.accepted.length, 0, 'refused upgrades never reach the mesh');
    assert.deepEqual(await peerRoutes(port), [200, 200, 101], 'a direct loopback request is still this computer');

    setPeer(f, 'tailscale');
    assert.deepEqual(await peerRoutes(port, { ...served, ...identity }), [200, 200, 101], 'tailnet traffic through tailscale serve');
    setPeer(f, 'lan');
    assert.deepEqual(await peerRoutes(port, forwarded), [200, 200, 101]);
    assert.equal(f.pairCalls.length, 3);
    assert.equal(f.accepted.length, 3);
  } finally {
    await f.close();
  }
});
