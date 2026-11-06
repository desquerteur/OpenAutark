// LAN discovery (devices/discovery.ts): while this PC accepts requests the responder answers the hello
// probe from this network only (private, link-local, loopback; never a VPN, the internet or a low
// port) with the public identity and the Remote ID of its key; the asking PC keeps one entry per
// device and key, never itself, only for its own probe, at most MAX_HELLO_ANSWERS, and stops after
// its timeout; directed broadcasts include link-local networks; the test-only
// WORKFORCE_DISCOVERY_TARGETS override sends probes to loopback only and binds the responder there.
// Owns: these assertions only. Never: binds anything but 127.0.0.1 or leaves sockets open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { broadcastAddresses, discover, DiscoveryResponder, loopbackTargets, MAX_HELLO_ANSWERS, parseAnswer, type Candidate, type UdpSocket } from '../../../src/runtime/devices/discovery.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';

const FP = 'a'.repeat(64);
const identity = (id = 'dev_aaaaaaaaaaaa'): Candidate => ({ deviceId: id, name: 'Laptop', fingerprint: FP, addresses: ['http://192.168.1.20:47812'], remoteId: remoteIdOf(FP) });

/** A fake socket: records what it sends; `deliver` plays an incoming datagram. */
function fakeSocket() {
  const handlers: Record<string, Array<(...args: never[]) => void>> = {};
  const sent: Array<{ message: string; port: number; address: string }> = [];
  let closed = false;
  let bound: number | undefined;
  let boundAddress: string | undefined;
  const socket: UdpSocket = {
    on: ((event: string, listener: (...args: never[]) => void) => { (handlers[event] ??= []).push(listener); return socket; }) as UdpSocket['on'],
    bind: (port: number, address?: string, callback?: () => void) => { bound = port; boundAddress = address; callback?.(); return socket; },
    setBroadcast: () => undefined,
    send: (message, port, address) => { sent.push({ message: Buffer.from(message).toString('utf8'), port, address }); },
    close: () => { closed = true; },
    unref: () => undefined,
  };
  const deliver = (value: unknown, from = { address: '192.168.1.30', port: 50000 }) =>
    handlers.message?.forEach((fn) => (fn as (message: Buffer, remote: typeof from) => void)(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), from));
  return { socket, sent, deliver, closed: () => closed, bound: () => bound, boundAddress: () => boundAddress };
}

test('responder: answers hello with the public identity only while answering, from this network only', () => {
  const fake = fakeSocket();
  const responder = new DiscoveryResponder({ socket: () => fake.socket, env: {} });
  responder.answer(() => undefined);
  fake.deliver({ q: 'wf-hello', v: 1, n: 'h0' });
  assert.equal(fake.sent.length, 0, 'no identity given: silent');
  responder.answer(() => identity());
  const probe = (n: string) => ({ q: 'wf-hello', v: 1, n });
  for (const address of ['8.8.8.8', '100.64.1.2', '172.32.0.1', '192.169.1.1', 'fd7a:115c::1', '::ffff:8.8.4.4']) fake.deliver(probe('x'), { address, port: 50000 });
  fake.deliver(probe('x'), { address: '192.168.1.30', port: 53 });
  fake.deliver({ q: 'wf-pair', v: 1, n: 'old' });
  assert.equal(fake.sent.length, 0, 'nothing beyond this network and no old probe kinds');
  for (const address of ['10.1.2.3', '172.16.5.5', '169.254.7.7', '127.0.0.1', '::ffff:192.168.1.31']) fake.deliver(probe('ok'), { address, port: 50000 });
  assert.deepEqual(fake.sent.map((item) => item.address), ['10.1.2.3', '172.16.5.5', '169.254.7.7', '127.0.0.1', '::ffff:192.168.1.31']);
  const answer = JSON.parse(fake.sent[0].message) as Record<string, unknown>;
  assert.deepEqual(Object.keys(answer).sort(), ['a', 'addresses', 'deviceId', 'fingerprint', 'n', 'name', 'remoteId', 'v']);
  responder.answer(undefined);
  assert.equal(responder.open, false);
  assert.equal(fake.closed(), true);
});

test('asking: one entry per device and key, never itself, only its own probe, wrong Remote IDs dropped, at most MAX_HELLO_ANSWERS', async () => {
  const joiner = fakeSocket();
  const pending = discover({ socket: () => joiner.socket, targets: () => ['255.255.255.255', '169.254.255.255'], timeoutMs: 30, self: 'dev_selfselfself' });
  assert.deepEqual(joiner.sent.map((item) => item.address), ['255.255.255.255', '169.254.255.255']);
  const probe = JSON.parse(joiner.sent[0].message) as { q: string; n: string };
  assert.deepEqual(Object.keys(probe).sort(), ['n', 'q', 'v'], 'a bare hello names nobody');
  const reply = (extra: Record<string, unknown> = {}, n = probe.n) => ({ a: 'wf-hello', v: 1, n, ...identity(), ...extra });
  joiner.deliver(reply());
  joiner.deliver(reply({ name: 'Laptop again' }));
  joiner.deliver(reply({ fingerprint: 'b'.repeat(64), remoteId: remoteIdOf('b'.repeat(64)), name: 'Impostor' }));
  joiner.deliver(reply({ deviceId: 'dev_cccccccccccc', remoteId: '123456782' }));
  joiner.deliver(reply({ deviceId: 'dev_selfselfself' }));
  joiner.deliver(reply({ deviceId: 'dev_dddddddddddd' }, 'another-probe'));
  const found = await pending;
  assert.deepEqual(found.map((candidate) => candidate.name), ['Laptop', 'Impostor'], 'the impostor never hides the real PC');
  assert.equal(joiner.closed(), true);

  const flood = fakeSocket();
  const many = discover({ socket: () => flood.socket, targets: () => ['192.168.1.255'], timeoutMs: 30 });
  const n = (JSON.parse(flood.sent[0].message) as { n: string }).n;
  for (let i = 0; i < MAX_HELLO_ANSWERS + 8; i++) {
    const fingerprint = i.toString(16).padStart(64, '0');
    flood.deliver({ a: 'wf-hello', v: 1, n, ...identity(`dev_${String(i).padStart(12, '0')}`), fingerprint, remoteId: remoteIdOf(fingerprint) });
  }
  assert.equal((await many).length, MAX_HELLO_ANSWERS);
});

test('test-only override: probes go to loopback only, the responder listens there, nothing is broadcast', async () => {
  const env = { WORKFORCE_DISCOVERY_TARGETS: ' 127.0.0.1, 192.168.1.255 ,255.255.255.255,127.0.0.2,localhost' };
  assert.deepEqual(loopbackTargets(env), ['127.0.0.1', '127.0.0.2'], 'entries beyond 127.0.0.0/8 are dropped');
  assert.equal(loopbackTargets({}), undefined, 'unset: normal LAN discovery');
  const responderSocket = fakeSocket();
  const responder = new DiscoveryResponder({ socket: () => responderSocket.socket, env });
  responder.answer(() => identity());
  assert.deepEqual([responderSocket.bound(), responderSocket.boundAddress()], [47813, '127.0.0.1']);
  responder.close();
  const joiner = fakeSocket();
  const found = discover({ socket: () => joiner.socket, env, timeoutMs: 10 });
  assert.deepEqual(joiner.sent.map((item) => item.address), ['127.0.0.1', '127.0.0.2']);
  assert.deepEqual(await found, []);
});

test('parseAnswer drops bad addresses; broadcastAddresses covers each IPv4 network incl. link-local', () => {
  const parsed = parseAnswer(Buffer.from(JSON.stringify({ a: 'wf-hello', v: 1, n: 'n', ...identity(), addresses: ['http://10.0.0.1:1', 'ftp://x', 5] })), 'n');
  assert.deepEqual(parsed, { deviceId: 'dev_aaaaaaaaaaaa', name: 'Laptop', fingerprint: FP, addresses: ['http://10.0.0.1:1'], remoteId: remoteIdOf(FP) });
  const targets = broadcastAddresses({
    eth: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
    cable: [{ address: '169.254.10.20', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null }],
  } as unknown as ReturnType<typeof import('node:os').networkInterfaces>);
  assert.deepEqual(targets, ['255.255.255.255', '192.168.1.255', '169.254.255.255']);
});

test('real sockets on 127.0.0.1: a directed hello is answered', async () => {
  const port = 47900 + Math.floor(Math.random() * 90);
  const loopback = () => {
    const socket = createSocket('udp4');
    const bind = socket.bind.bind(socket) as (port: number, address: string, callback?: () => void) => void;
    return Object.assign(socket, { bind: (p: number, _address?: string, callback?: () => void) => bind(p, '127.0.0.1', callback) }) as unknown as UdpSocket;
  };
  const responder = new DiscoveryResponder({ socket: loopback, port });
  responder.answer(() => identity());
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const found = await discover({ socket: loopback, port, targets: () => ['127.0.0.1'], timeoutMs: 600 });
    assert.deepEqual(found.map((candidate) => candidate.deviceId), ['dev_aaaaaaaaaaaa']);
  } finally {
    responder.close();
  }
});
