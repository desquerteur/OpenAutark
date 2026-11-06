// Relay abuse limits and flow control on loopback: a client that makes a fresh key per
// connection still hits the per-source limits (registrations, Remote ID lookups, request
// messages) and its requests carry the same opaque source tag; IPv6 sources count per /64; the
// opener's signed tunnel key is passed through; a lagging receiver pauses its sender and a
// receiver that never catches up loses that tunnel, while the sender stays connected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/relay.ts';
import { sourceOf } from '../src/limits.ts';
import { connect, device, settle, type Client } from './clients.ts';

test('client sources: IPv4 as is, IPv6 per /64', () => {
  assert.equal(sourceOf('203.0.113.7'), '203.0.113.7');
  assert.equal(sourceOf('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(sourceOf('2001:db8:0:12:aaaa::1'), '2001:db8:0:12::/64');
  assert.equal(sourceOf('2001:DB8::12:0:0:1'), '2001:db8:0:0::/64');
  assert.equal(sourceOf('2001:db8:0:12:ffff:1:2:3%eth0'), '2001:db8:0:12::/64');
  assert.equal(sourceOf('::1'), '0:0:0:0::/64');
});

test('fresh keys from one source: registrations, lookups and request messages stay limited; one tag per source', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { findsPerMinute: 3, pairsPerMinute: 3, registrationsPerMinute: 6, maxPerIp: 20 } });
  t.after(() => relay.close());
  const target = device();
  const ct = await connect(relay.port, { me: target, findable: true });
  await ct.next('ready');
  const open: Client[] = [ct];
  t.after(() => { for (const client of open) client.ws.close(); });

  const results: string[] = [];
  const tags = new Set<string>();
  for (let index = 0; index < 4; index++) { // every asker a new key – as a flood would do it
    const asker = await connect(relay.port);
    open.push(asker);
    await asker.next('ready');
    asker.send({ t: 'find', ref: 1, id: '123456782' });
    results.push(await Promise.race([asker.next('found').then(() => 'found'), asker.next('error').then((frame) => frame.code)]));
    asker.send({ t: 'pair', ref: 2, to: target.fp, e: 'ZQ', c: 'eA' });
    const outcome = await Promise.race([ct.next('pair').then((frame) => { tags.add(frame.src); ct.send({ t: 'pairReply', ref: frame.ref, error: 'declined' }); return 'delivered'; }), asker.next('error', (frame) => frame.ref === 2).then((frame) => frame.code)]);
    results.push(outcome);
  }
  assert.deepEqual(results, ['found', 'delivered', 'found', 'delivered', 'found', 'delivered', 'rate_limited', 'rate_limited'], 'per-key limits alone would have let all four through');
  assert.equal(tags.size, 1, 'requests from one source carry one tag');
  assert.match([...tags][0], /^[0-9a-f]{16}$/);
  assert.ok(![...tags][0].includes('127'), 'the tag is not the address');

  const extra = await connect(relay.port); // the 6th registration from this source in a minute
  open.push(extra);
  await extra.next('ready');
  const refused = await connect(relay.port);
  assert.equal((await refused.next('error')).code, 'rate_limited');
  assert.equal(await refused.closed, 1013, 'the 7th is refused');
});

async function pinnedPair(port: number) {
  const a = device();
  const b = device();
  const ca = await connect(port, { me: a, peers: [b.fp] });
  await ca.next('ready');
  const cb = await connect(port, { me: b, peers: [a.fp] });
  await cb.next('ready');
  return { ca, cb };
}

function frames(tid: number, count: number, size = 60 * 1024): Buffer[] {
  return Array.from({ length: count }, (_, index) => {
    const frame = Buffer.alloc(5 + size, index & 255);
    frame.writeUInt32BE(tid, 0);
    frame[4] = 0;
    return frame;
  });
}

test('the signed tunnel key is passed through; a lagging receiver pauses the sender, one that never catches up loses the tunnel', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { lowBufferedBytes: 64 * 1024, stallMs: 400, maxBufferedBytes: 512 * 1024 * 1024, bytesPerSecond: 1024 * 1024 * 1024 } });
  t.after(() => relay.close());
  const { ca, cb } = await pinnedPair(relay.port);
  t.after(() => { ca.ws.close(); cb.ws.close(); });
  ca.send({ t: 'open', ref: 1, to: cb.fp, e: 'ZXBo', es: 'c2ln' });
  const opened = await ca.next('opened');
  const incoming = await cb.next('incoming');
  assert.equal(incoming.e, 'ZXBo');
  assert.equal(incoming.es, 'c2ln', 'the opener\'s signature reaches the receiver untouched');

  cb.ws.pause(); // the receiver stops reading (a slow mobile link)
  for (const frame of frames(opened.tid, 400)) ca.ws.send(frame); // 24 MB – more than any socket buffer
  const closed = await ca.next('closed');
  assert.equal(closed.code, 'slow');
  assert.equal(closed.tid, opened.tid);
  assert.ok(relay.stats().connections >= 2, 'the sender stays connected');
  ca.send({ t: 'find', ref: 9, id: '123456782' });
  assert.ok(await ca.next('found'), 'and is read again once the stalled tunnel is gone');
  cb.ws.resume();
});

test('a receiver that catches up in time gets every frame; nothing is dropped', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { lowBufferedBytes: 64 * 1024, stallMs: 5_000, maxBufferedBytes: 512 * 1024 * 1024, bytesPerSecond: 1024 * 1024 * 1024 } });
  t.after(() => relay.close());
  const { ca, cb } = await pinnedPair(relay.port);
  t.after(() => { ca.ws.close(); cb.ws.close(); });
  ca.send({ t: 'open', ref: 1, to: cb.fp });
  const opened = await ca.next('opened');
  await cb.next('incoming');
  cb.ws.pause();
  const sent = frames(opened.tid, 150);
  for (const frame of sent) ca.ws.send(frame);
  await settle(300);
  cb.ws.resume();
  const deadline = Date.now() + 8_000;
  while (cb.binary.length < sent.length && Date.now() < deadline) await settle(50);
  assert.equal(cb.binary.length, sent.length);
  assert.ok(cb.binary.every((frame, index) => frame[5] === (index & 255)), 'in order');
  assert.equal(ca.frames.filter((frame) => frame.t === 'closed').length, 0);
});

test('a connection over the limit that sends a broken frame while it closes leaves the process running (B-072, mounted in TeleCoding)', async (t) => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', limits: { maxPerIp: 1 } });
  t.after(() => relay.close());
  const first = await connect(relay.port);
  t.after(() => first.ws.close());
  await first.next('ready');
  // the second socket from this address is 'busy'; right behind its upgrade it sends a frame with the reserved opcode 3
  const { connect: tcp } = await import('node:net');
  const socket = tcp(relay.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.on('error', () => undefined);
  socket.write(Buffer.concat([
    Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'),
    Buffer.from([0x83, 0x80, 1, 2, 3, 4]),
  ]));
  await settle(300);
  const health = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
  assert.equal(health.status, 200, 'the server still answers – an unhandled socket error would have ended this process');
});
