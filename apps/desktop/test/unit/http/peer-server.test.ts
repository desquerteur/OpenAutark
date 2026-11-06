// Dedicated peer listener (MP1): serves only the linked-PC routes (everything else answers 404),
// opens while this PC's own connect request holds it or a PC is linked and closes otherwise – without
// cutting established peer sockets –, falls back to another port when the configured one is taken,
// reports bind errors with their code, re-opens on a changed tailnet address and advertises its
// addresses. Real sockets on an injected 127.0.0.1 listen host; fake mesh and fake pairing routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type os from 'node:os';
import WebSocket from 'ws';
import { Bus } from '../../../src/runtime/bus.ts';
import type { SocketLike } from '../../../src/runtime/devices/channel.ts';
import { PeerServer, hasLinkedPc, type PeerMode, type PeerServerDeps } from '../../../src/runtime/http/peer-server.ts';
import type { PairingHttp } from '../../../src/runtime/http/types.ts';
import { globalIpv6, peerAddresses } from '../../../src/runtime/pwa/urls.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { validateSettings } from '../../../src/runtime/settings/validate.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import { DEFAULT_RELAY } from '../../../src/shared/model/relay.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { silentLog } from '../devices/fakes.ts';
import { openSocket, request } from './fixture.ts';

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;
const nic = (address: string) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.0.0', mac: '00:00:00:00:00:00', cidr: null }) as unknown as os.NetworkInterfaceInfo;
const INTERFACES: Interfaces = { lo: [{ ...nic('127.0.0.1'), internal: true }], wifi: [nic('192.168.1.20')], cable: [nic('169.254.7.7')], ts: [nic('100.64.0.5')] };

const device = (patch: Partial<Device>): Device => ({
  id: 'dev_other00000001', name: 'Tower', kind: 'pc', role: 'home', fingerprint: 'ab', addresses: [], caps: {}, status: 'offline', self: false, ...patch,
});

function fixture(options: { mode?: PeerMode; port?: number; linked?: boolean; hosts?: string[] | null; interfaces?: Interfaces; remembered?: number; pairing?: () => PairingHttp; portmap?: PeerServerDeps['portmap'] } = {}) {
  const config = { mode: options.mode ?? 'lan', port: options.port ?? 0 };
  let linked = options.linked ?? false;
  let hostCalls = 0;
  const bus = new Bus((error) => { throw error; });
  const pairCalls: Array<{ body: unknown; remote: { address?: string } }> = [];
  const fake: PairingHttp = {
    wellKnown: () => ({ app: 'workforce', protocol: 1, deviceId: 'dev_self00000001', name: 'Desk', fingerprint: 'ff' }),
    handle: async (body, remote) => { pairCalls.push({ body, remote }); return { ok: true }; },
  };
  const pairing = options.pairing ?? (() => fake);
  const accepted: SocketLike[] = [];
  const remembered: number[] = options.remembered ? [options.remembered] : [];
  const stored: number[] = [];
  const server = new PeerServer({
    pairing: { wellKnown: () => pairing().wellKnown(), handle: (body, remote) => pairing().handle(body, remote) },
    mesh: { accept: async (socket) => { accepted.push(socket); return 'dev_peer00000001'; } },
    log: () => silentLog,
    bus,
    config: () => config,
    linked: () => linked,
    hosts: options.hosts === null ? undefined : () => { hostCalls++; return options.hosts ?? ['127.0.0.1']; },
    interfaces: () => options.interfaces ?? INTERFACES,
    remember: { get: () => remembered.at(-1), set: (port) => { stored.push(port); remembered.push(port); } },
    fallbackAddresses: () => ['http://10.9.9.9:47811'],
    ...(options.portmap ? { portmap: options.portmap } : {}),
  });
  const states: string[] = [];
  server.onChange((state) => states.push(state.status));
  let opened = 0;
  server.onOpened(() => { opened++; });
  return {
    server, bus, config, pairCalls, accepted, stored, states,
    setLinked(value: boolean) { linked = value; },
    get opened() { return opened; },
    get hostCalls() { return hostCalls; },
  };
}

/** A free loopback port (listened on once, then released). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const refused = (port: number) => request(port, { path: '/.well-known/workforce' }).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED');

test('serves only /.well-known/workforce, POST /peer/pair and the /peer upgrade; everything else is 404', async () => {
  const f = fixture({ linked: true });
  await f.server.start();
  try {
    const port = f.server.port()!;
    assert.ok(port > 0);
    const known = await request(port, { path: '/.well-known/workforce' });
    assert.equal(known.status, 200);
    assert.equal(known.json().deviceId, 'dev_self00000001');
    const pair = await request(port, { method: 'POST', path: '/peer/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'link' }) });
    assert.equal(pair.status, 200);
    assert.deepEqual(f.pairCalls.map((call) => call.remote.address), ['127.0.0.1']);

    for (const path of ['/', '/index.html', '/main.js', '/rpc', '/ws', `/files/${'a'.repeat(64)}`, '/mcp', '/mcp/abcdefghijklmnop1234', '/sandbox/app', '/peer/other']) {
      assert.equal((await request(port, { path })).status, 404, path);
    }
    assert.equal((await request(port, { method: 'POST', path: '/rpc', headers: { 'content-type': 'application/json' }, body: '{"id":1,"method":"pwa.exchange"}' })).status, 404);
    assert.equal((await request(port, { path: '/peer' })).status, 426);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/ws`), /status 404/);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/mcp`), /status 404/);

    // Host allowlist (DNS rebinding) and Origin checks are the same as on the runtime server.
    assert.equal((await request(port, { path: '/.well-known/workforce', headers: { host: 'evil.example' } })).status, 403);
    const foreign = await request(port, { method: 'POST', path: '/peer/pair', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(foreign.status, 403);
    await assert.rejects(openSocket(`ws://127.0.0.1:${port}/peer`, { origin: 'http://evil.example' }), /status 403/);
    assert.equal(f.pairCalls.length, 1, 'refused requests never reach pairing');

    const ws = await openSocket(`ws://127.0.0.1:${port}/peer`);
    assert.equal(f.accepted.length, 1, 'the /peer upgrade goes to the mesh');
    ws.close();
  } finally {
    await f.server.close();
  }
});

test('a hold opens it and advertises its addresses; releasing it closes it when no PC is linked', async () => {
  const f = fixture();
  await f.server.start();
  try {
    assert.equal(f.server.state().status, 'closed');
    assert.equal(f.server.port(), undefined);
    assert.deepEqual(f.server.addresses(), ['http://10.9.9.9:47811'], 'while closed: the fallback addresses');

    const release = await f.server.hold();
    const port = f.server.port()!;
    assert.ok(port > 0, 'the hold opened the listener');
    assert.deepEqual(f.server.addresses(), [`http://100.64.0.5:${port}`, `http://192.168.1.20:${port}`, `http://169.254.7.7:${port}`]);
    assert.equal((await request(port, { path: '/.well-known/workforce' })).status, 200);

    release();
    release(); // a second release changes nothing
    await f.server.update();
    assert.equal(f.server.state().status, 'closed');
    assert.equal(await refused(port), true, 'nothing listens after the hold ended');

    // A linked PC keeps it open after the hold ends.
    const again = await f.server.hold();
    f.setLinked(true);
    again();
    await f.server.update();
    assert.equal(f.server.state().status, 'open');
    assert.deepEqual(f.states, ['open', 'closed', 'open']);
    assert.equal(f.opened, 2);
  } finally {
    await f.server.close();
  }
});

test('device and settings events open, move and close it; mode off never opens', async () => {
  const f = fixture();
  await f.server.start();
  try {
    assert.equal(f.server.state().status, 'closed');
    f.setLinked(true);
    f.bus.emit('device.upserted', device({}));
    await f.server.update();
    assert.equal(f.server.state().status, 'open');
    assert.equal(f.opened, 1, 'the open hook fires (main.ts dials linked PCs then)');

    f.config.mode = 'tailscale';
    f.bus.emit('settings.updated', defaultSettings() as Settings);
    await f.server.update();
    assert.deepEqual({ status: f.server.state().status, mode: f.server.state().mode }, { status: 'open', mode: 'tailscale' });
    assert.equal(f.opened, 2, 'a new mode reopens the listener');
    assert.deepEqual(f.server.addresses(), [`http://100.64.0.5:${f.server.port()}`], 'tailscale mode advertises tailnet addresses only');

    f.config.mode = 'off';
    f.bus.emit('settings.updated', defaultSettings() as Settings);
    await f.server.update();
    assert.equal(f.server.state().status, 'off');
    assert.equal(f.server.port(), undefined);
    const release = await f.server.hold();
    assert.equal(f.server.state().status, 'off', 'a pairing does not open it either');
    release();

    f.config.mode = 'lan';
    f.setLinked(false);
    f.bus.emit('device.removed', { id: 'dev_other00000001' });
    await f.server.update();
    assert.equal(f.server.state().status, 'closed');
  } finally {
    await f.server.close();
  }
});

test('closing the listener keeps established peer sockets; shutdown closes them', async () => {
  const f = fixture();
  await f.server.start();
  const release = await f.server.hold();
  const port = f.server.port()!;
  const ws = await openSocket(`ws://127.0.0.1:${port}/peer`);
  try {
    release();
    await f.server.update();
    assert.equal(f.server.state().status, 'closed');
    assert.equal(await refused(port), true, 'no new connections');
    assert.equal(ws.readyState, WebSocket.OPEN, 'the established peer socket stays');
    const received = new Promise<string>((resolve) => ws.once('message', (data) => resolve(String(data))));
    f.accepted[0].send('still connected');
    assert.equal(await received, 'still connected');
  } finally {
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    await f.server.close();
    assert.equal(await closed, 1001, 'shutdown closes the peer sockets');
  }
});

test('a taken port falls back to another free port and remembers it; a remembered port comes next', async () => {
  const blocker: Server = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = (blocker.address() as AddressInfo).port;
  try {
    const f = fixture({ port: busy, linked: true });
    await f.server.start();
    const chosen = f.server.port()!;
    assert.ok(chosen > 0 && chosen !== busy);
    assert.deepEqual(f.stored, [chosen], 'the fallback is remembered (linked PCs stored it)');
    await f.server.close();

    const remembered = await freePort();
    const g = fixture({ port: busy, linked: true, remembered });
    await g.server.start();
    assert.equal(g.server.port(), remembered);
    assert.deepEqual(g.stored, [], 'nothing new to remember');
    assert.equal((await request(remembered, { path: '/.well-known/workforce' })).status, 200);
    await g.server.close();
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('a bind error is reported with its code and retried only on refresh; no tailnet → NO_TAILNET', async () => {
  const f = fixture({ hosts: ['192.0.2.1'], port: 47999 }); // TEST-NET-1: not an address of this PC
  await f.server.start();
  try {
    const release = await f.server.hold();
    const state = f.server.state();
    assert.equal(state.status, 'error');
    assert.equal(state.error, 'EADDRNOTAVAIL');
    assert.deepEqual(state.addresses, []);
    const calls = f.hostCalls;
    await f.server.update();
    assert.equal(f.hostCalls, calls, 'device events do not retry a failed listen');
    await f.server.refresh();
    assert.equal(f.hostCalls, calls + 1, 'refresh (resume, a new pairing) tries again');
    release();
    await f.server.update();
    assert.deepEqual({ status: f.server.state().status, error: f.server.state().error }, { status: 'closed', error: undefined });
  } finally {
    await f.server.close();
  }

  const g = fixture({ mode: 'tailscale', hosts: null, interfaces: { wifi: [nic('192.168.1.20')] } });
  await g.server.start();
  try {
    const release = await g.server.hold();
    assert.deepEqual({ status: g.server.state().status, error: g.server.state().error }, { status: 'error', error: 'NO_TAILNET' });
    release();
  } finally {
    await g.server.close();
  }
});

test('tailscale mode: a changed tailnet address re-opens the listener there; a tailnet that appears ends NO_TAILNET', async () => {
  const hosts = ['127.0.0.1'];
  const f = fixture({ mode: 'tailscale', linked: true, hosts });
  await f.server.start();
  try {
    assert.equal(f.server.state().status, 'open');
    await f.server.update();
    assert.equal(f.opened, 1, 'the same tailnet address keeps the listener');
    hosts.splice(0, 1, 'localhost'); // this PC got another tailnet IP
    f.bus.emit('device.upserted', device({ status: 'offline' })); // e.g. a linked PC's link dropped
    await f.server.update();
    assert.deepEqual({ status: f.server.state().status, opened: f.opened }, { status: 'open', opened: 2 }, 're-opened on the new address');

    hosts.splice(0, 1); // no tailnet address
    await f.server.update();
    assert.deepEqual({ status: f.server.state().status, error: f.server.state().error }, { status: 'error', error: 'NO_TAILNET' });
    hosts.push('127.0.0.1'); // the tailnet is back: the next device event opens it, no resume needed
    await f.server.update();
    assert.deepEqual({ status: f.server.state().status, opened: f.opened }, { status: 'open', opened: 3 });
    assert.equal((await request(f.server.port()!, { path: '/.well-known/workforce' })).status, 200);
  } finally {
    await f.server.close();
  }
});

test('peer addresses: tailnet first, LAN next, link-local last, at most 8; tailscale lists the tailnet only', () => {
  assert.deepEqual(peerAddresses(47812, () => INTERFACES), ['http://100.64.0.5:47812', 'http://192.168.1.20:47812', 'http://169.254.7.7:47812']);
  assert.deepEqual(peerAddresses(47812, () => INTERFACES, 'tailscale'), ['http://100.64.0.5:47812']);
  const many: Interfaces = { lan: Array.from({ length: 12 }, (_, i) => nic(`10.0.0.${i + 1}`)) };
  assert.equal(peerAddresses(1, () => many).length, 8);
});

test('B-078 peer addresses: global IPv6 after the LAN (at most two), never link-local, ULA or Teredo', () => {
  const v6 = (address: string, scopeid = 0) => ({ address, family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: null, scopeid }) as unknown as os.NetworkInterfaceInfo;
  const withV6: Interfaces = { ...INTERFACES, wifi6: [v6('2a02:810d:1::5'), v6('fe80::1', 7), v6('fd00::2'), v6('2001:0:53aa::1'), v6('2a02:810d:1::6'), v6('2a02:810d:1::7')] };
  assert.deepEqual(globalIpv6(() => withV6), ['2a02:810d:1::5', '2a02:810d:1::6', '2a02:810d:1::7']);
  assert.deepEqual(peerAddresses(47812, () => withV6), [
    'http://100.64.0.5:47812', 'http://192.168.1.20:47812', 'http://[2a02:810d:1::5]:47812', 'http://[2a02:810d:1::6]:47812', 'http://169.254.7.7:47812',
  ]);
  assert.deepEqual(peerAddresses(47812, () => withV6, 'tailscale'), ['http://100.64.0.5:47812']);
});

test('B-078 the router\'s mapping joins the addresses first while open, and goes when the listener closes', async () => {
  let removed = 0;
  const portmap = { map: async (port: number) => ({ url: `http://203.0.113.7:${port}`, via: 'upnp' as const, lease: 3600, remove: async () => { removed++; } }) };
  const f = fixture({ linked: true, port: 0, portmap });
  const states: string[][] = [];
  f.server.onChange((state) => states.push(state.addresses));
  try {
    await f.server.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const port = f.server.port()!;
    assert.equal(f.server.addresses()[0], `http://203.0.113.7:${port}`);
    assert.ok(states.some((list) => list[0] === `http://203.0.113.7:${port}`), 'the linked PCs hear it');
  } finally {
    await f.server.close();
  }
  assert.equal(removed, 1, 'removed on close');
});

test('linked PCs and the peer settings', () => {
  assert.equal(hasLinkedPc([device({ self: true })]), false);
  assert.equal(hasLinkedPc([device({ status: 'revoked' }), device({ kind: 'phone', role: 'client' })]), false);
  assert.equal(hasLinkedPc([device({ status: 'pairing' })]), true);
  assert.equal(hasLinkedPc([device({ status: 'offline' })]), true);

  const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  assert.deepEqual(settings.devices, { peer: 'lan', peerPort: 47812, findable: true, relay: DEFAULT_RELAY }); // B-072: Autark's own meeting server
  assert.throws(() => validateSettings({ ...settings, devices: { peer: 'wifi' as PeerMode, peerPort: 47812 } }), /devices\.peer/);
  assert.throws(() => validateSettings({ ...settings, devices: { peer: 'lan', peerPort: 70_000 } }), /devices\.peerPort/);
});
