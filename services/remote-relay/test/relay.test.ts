// Meeting server tests on loopback with real WebSocket clients: registration by signed challenge, presence
// (with the address the server sees and the peer port) and tunnels only between devices that pinned each other, unpinning cuts tunnels, Remote ID
// lookup only for devices that accept requests, sealed pairing messages are passed through
// untouched, and the limits (rate, per-address connections, replaced registrations).

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, remoteIdOf } from '../src/relay.ts';
import { connect, device, settle } from './clients.ts';

test('registration needs a signature of the challenge; presence and tunnels only between devices that pinned each other', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  t.after(() => relay.close());
  const impostor = await connect(relay.port, { badSig: true });
  assert.equal(await impostor.closed, 4000, 'a wrong signature ends the connection');

  const a = device();
  const b = device();
  const ca = await connect(relay.port, { me: a, peers: [b.fp] });
  assert.deepEqual((await ca.next('ready')).online, []);
  const cb = await connect(relay.port, { me: b, peers: [] }); // B has not pinned A (yet)
  assert.deepEqual((await cb.next('ready')).online, []);
  await settle();
  assert.equal(ca.frames.filter((frame) => frame.t === 'presence').length, 0, 'a one-sided pin shows no presence');
  ca.send({ t: 'open', ref: 1, to: b.fp });
  assert.equal((await ca.next('error')).code, 'unavailable', 'no tunnel without a mutual pin');

  cb.send({ t: 'update', peers: [a.fp] });
  const seenByA = await ca.next('presence');
  const seenByB = await cb.next('presence');
  assert.equal(seenByA.fp, b.fp); assert.equal(seenByA.online, true); assert.equal(seenByA.box, b.box);
  assert.equal(seenByB.fp, a.fp); assert.equal(seenByB.online, true);

  ca.send({ t: 'open', ref: 2, to: b.fp, e: 'ZXBo' });
  const opened = await ca.next('opened');
  const incoming = await cb.next('incoming');
  assert.equal(incoming.tid, opened.tid); assert.equal(incoming.from, a.fp); assert.equal(incoming.e, 'ZXBo');
  const frame = Buffer.concat([Buffer.alloc(5), Buffer.from('opaque bytes')]);
  frame.writeUInt32BE(opened.tid, 0);
  ca.ws.send(frame);
  await settle();
  assert.deepEqual(cb.binary.map(String), [String(frame)], 'binary frames pass unchanged');

  cb.send({ t: 'update', peers: [] }); // B unpins (revoke)
  assert.equal((await ca.next('closed')).code, 'forbidden');
  assert.equal((await ca.next('presence')).online, false);
  ca.ws.send(frame);
  await settle();
  assert.equal(cb.binary.length, 1, 'nothing is forwarded after the pin ended');
  assert.deepEqual(relay.stats().tunnels, 0);
  ca.ws.close(); cb.ws.close();
});

test('Remote ID lookup finds only devices that accept requests; sealed pairing messages pass through; a disconnect ends presence and tunnels', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  t.after(() => relay.close());
  assert.equal(remoteIdOf('a'.repeat(64)), '967872979', 'the same Remote ID as the desktop app');
  assert.equal(remoteIdOf('0123456789abcdef'.repeat(4)), '771762408');
  const target = device();
  const ct = await connect(relay.port, { me: target, findable: true });
  await ct.next('ready');
  const hidden = await connect(relay.port, { findable: false });
  await hidden.next('ready');
  const asker = await connect(relay.port);
  await asker.next('ready');

  asker.send({ t: 'find', ref: 1, id: remoteIdOf(target.fp) });
  const found = await asker.next('found');
  assert.deepEqual(found.entries, [{ pub: target.pub, box: target.box, boxSig: found.entries[0].boxSig }]);
  asker.send({ t: 'find', ref: 2, id: remoteIdOf(hidden.fp) });
  assert.deepEqual((await asker.next('found')).entries, [], 'a device that does not accept requests is not found');

  asker.send({ t: 'pair', ref: 7, to: target.fp, e: 'ZQ', c: 'Y2lwaGVy' });
  const delivered = await ct.next('pair');
  assert.equal(delivered.from, asker.fp); assert.equal(delivered.c, 'Y2lwaGVy');
  assert.match(delivered.src, /^[0-9a-f]{16}$/, 'an opaque tag of the source, never its address');
  ct.send({ t: 'pairReply', ref: delivered.ref, c: 'cmVwbHk' });
  assert.deepEqual(await asker.next('pairReply'), { t: 'pairReply', ref: 7, c: 'cmVwbHk' });
  asker.send({ t: 'pair', ref: 8, to: hidden.fp, e: 'ZQ', c: 'eA' });
  assert.equal((await asker.next('error')).code, 'unavailable');

  // Pinned pair: a disconnect is presence "offline" and the tunnel's "closed" for the other side.
  const x = device();
  const y = device();
  const cx = await connect(relay.port, { me: x, peers: [y.fp] });
  await cx.next('ready');
  const cy = await connect(relay.port, { me: y, peers: [x.fp] });
  assert.equal((await cy.next('ready')).online[0].fp, x.fp);
  cx.send({ t: 'open', ref: 1, to: y.fp });
  const tunnel = await cx.next('opened');
  await cy.next('incoming');
  cy.ws.close();
  assert.equal((await cx.next('closed')).tid, tunnel.tid);
  assert.equal((await cx.next('presence', (frame) => frame.online === false)).fp, y.fp);
  for (const client of [ct, hidden, asker, cx]) client.ws.close();
});

test('limits: finds per minute, connections per address, a second registration of a key replaces the first', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { findsPerMinute: 2, maxPerIp: 3 } });
  t.after(() => relay.close());
  const me = device();
  const first = await connect(relay.port, { me });
  await first.next('ready');
  for (const ref of [1, 2]) { first.send({ t: 'find', ref, id: '967872979' }); await first.next('found'); }
  first.send({ t: 'find', ref: 3, id: '967872979' });
  assert.equal((await first.next('error')).code, 'rate_limited');

  const second = await connect(relay.port, { me });
  await second.next('ready');
  assert.equal(await first.closed, 4009, 'the same key registering again replaces the old connection');
  const extra = [await connect(relay.port), await connect(relay.port)];
  await extra[1].next('ready');
  const over = await connect(relay.port);
  assert.equal(await over.closed, 1013, 'a fourth connection from one address is refused');
  for (const client of [second, ...extra]) client.ws.close();
});

test('presence carries the address the server sees with the peer port; a new port reaches the pinned peer', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  t.after(() => relay.close());
  const a = device();
  const b = device();
  const ca = await connect(relay.port, { me: a, peers: [b.fp], peerPort: 47812 });
  await ca.next('ready');
  const cb = await connect(relay.port, { me: b, peers: [a.fp] });
  const ready = await cb.next('ready');
  assert.deepEqual(ready.online[0].addrs, ['http://127.0.0.1:47812'], 'the server builds the address from the source it sees');
  const seen = await ca.next('presence');
  assert.equal(seen.addrs, undefined, 'a device without a peer port has no address to share');
  ca.send({ t: 'update', peers: [b.fp], port: 47900 });
  const moved = await cb.next('presence', (frame) => frame.fp === a.fp);
  assert.deepEqual(moved.addrs, ['http://127.0.0.1:47900']);
});

test('mounted on another HTTP server (noServer): its upgrades register and meet; the address comes from the proxy header', async (t) => {
  const relay = await createRelay({ noServer: true, trustProxy: true, ipHeader: 'CF-Connecting-IP' });
  const host = createServer((_request, response) => response.end('host'));
  host.on('upgrade', (request, socket, head) => {
    if (request.url === '/meet') relay.handleUpgrade(request, socket, head); else socket.destroy();
  });
  await new Promise<void>((done) => host.listen(0, '127.0.0.1', done));
  t.after(async () => { await relay.close(); await new Promise((done) => host.close(done)); });
  const port = (host.address() as AddressInfo).port;
  assert.equal(relay.port, 0);
  const a = device();
  const b = device();
  const ca = await connect(port, { me: a, peers: [b.fp], peerPort: 47812, path: '/meet', headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 104.16.0.1' } });
  await ca.next('ready');
  const cb = await connect(port, { me: b, peers: [a.fp], path: '/meet' });
  const ready = await cb.next('ready');
  assert.deepEqual(ready.online[0].addrs, ['http://203.0.113.7:47812'], 'the client address from the configured header, not the last X-Forwarded-For entry');
  assert.equal(relay.stats().devices, 2);
});
