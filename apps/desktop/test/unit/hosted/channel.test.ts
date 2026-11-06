// The iPhone web app's peer channel (src/ui/hosted/channel.ts) and tunnel (tunnel.ts) against the runtime's real
// acceptSecure (devices/channel.ts) over the runtime's RelayTunnel: the handshake with the pinned PC key, messages both
// ways in order, a wrong PC key, a PC that refuses, tampered / replayed / reordered frames, and a message far larger than
// one 60 KiB relay frame (MORE) both ways.
// Owns: these assertions. Never: a meeting server (pair-flow.test.ts runs the real one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptSecure, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { connectChannel } from '../../../src/ui/hosted/channel.ts';
import { HEADER } from '../../../src/ui/hosted/tunnel.ts';
import { pcIdentity, phoneKey, tunnelPair, until } from './rig.ts';

async function connected() {
  const pc = await pcIdentity();
  const key = await phoneKey();
  const pair = await tunnelPair();
  const accepted = acceptSecure(pair.runtime as SocketLike, pc, (pub) => (Buffer.compare(pub, Buffer.from(key.pub)) === 0 ? 'dev_phone0000000001' : undefined));
  const phone = await connectChannel(pair.hosted, { key, deviceId: 'dev_phone0000000001' }, pc.publicKey);
  const desk = await accepted;
  return { pc, key, pair, phone, desk };
}

test('handshake with the pinned PC key; messages both ways arrive in order', async () => {
  const { phone, desk } = await connected();
  assert.equal(desk.peerId, 'dev_phone0000000001');
  const atPc: unknown[] = [];
  const atPhone: unknown[] = [];
  desk.onMessage((message) => atPc.push(message));
  phone.onMessage((message) => atPhone.push(message));
  for (let i = 0; i < 50; i++) { void phone.send({ i }); desk.send({ i }); }
  await until(() => atPc.length + atPhone.length, (n) => n === 100, 'both directions');
  assert.deepEqual(atPc, Array.from({ length: 50 }, (_, i) => ({ i })));
  assert.deepEqual(atPhone, Array.from({ length: 50 }, (_, i) => ({ i })));
  phone.close();
  await until(() => desk.closed, Boolean, 'the PC side closes too');
});

test('a PC with another key is refused; a PC that refuses this phone ends the handshake', async () => {
  const pc = await pcIdentity('Real');
  const other = await pcIdentity('Other');
  const key = await phoneKey();
  const pair = await tunnelPair();
  const accepted = acceptSecure(pair.runtime as SocketLike, other, () => 'dev_phone0000000001');
  await assert.rejects(connectChannel(pair.hosted, { key, deviceId: 'dev_phone0000000001' }, pc.publicKey), /not the paired PC/);
  await assert.rejects(accepted);

  const again = await tunnelPair();
  const refusing = acceptSecure(again.runtime as SocketLike, pc, () => undefined);
  await assert.rejects(connectChannel(again.hosted, { key, deviceId: 'dev_phone0000000001' }, pc.publicKey, 2_000));
  await assert.rejects(refusing, /Unknown device/);
});

test('tampered, replayed and reordered frames close the channel', async () => {
  for (const attack of ['tamper', 'replay', 'reorder'] as const) {
    const { phone, desk, pair } = await connected();
    const frames: Uint8Array[] = [];
    const tap = pair.runtime as unknown as { link: { send(frame: Buffer): void } };
    const original = tap.link.send.bind(tap.link);
    tap.link.send = (frame) => { frames.push(new Uint8Array(frame)); if (attack === 'tamper' || attack === 'replay') original(frame); };
    const got: unknown[] = [];
    phone.onMessage((message) => got.push(message));
    desk.send({ n: 1 });
    desk.send({ n: 2 });
    await until(() => frames.length, (n) => n === 2, 'frames');
    if (attack === 'tamper') {
      await until(() => got.length, (n) => n === 2, 'delivered');
      const bad = frames[1].slice();
      bad[0] = 0; bad[1] = 0; bad[2] = 0; bad[3] = 7; // keep the tunnel id
      bad[HEADER + 8] = 0;
      bad[HEADER + 7] = 9; // a higher counter, wrong ciphertext
      pair.inject(bad);
    } else if (attack === 'replay') {
      await until(() => got.length, (n) => n === 2, 'delivered');
      pair.inject(frames[0]);
    } else {
      pair.inject(frames[1]);
      pair.inject(frames[0]);
    }
    await until(() => phone.closed, Boolean, `${attack} closes the channel`);
    assert.ok(got.length <= 2, attack);
  }
});

test('a message far over one relay frame (MORE) arrives whole in both directions', async () => {
  const { phone, desk, pair } = await connected();
  const big = 'x'.repeat(5 * 1024 * 1024);
  const atPhone: Array<{ big: string }> = [];
  const atPc: Array<{ big: string }> = [];
  phone.onMessage((message) => atPhone.push(message as { big: string }));
  desk.onMessage((message) => atPc.push(message as { big: string }));
  desk.send({ big });
  await phone.send({ big });
  await until(() => atPhone.length + atPc.length, (n) => n === 2, 'both big messages', 20_000);
  assert.equal(atPhone[0].big.length, big.length);
  assert.equal(atPc[0].big.length, big.length);
  assert.ok(pair.toPc.length > 80, 'the phone split it into relay frames');
  assert.ok(pair.toPc.every((frame) => frame.length <= HEADER + 60 * 1024));
});
