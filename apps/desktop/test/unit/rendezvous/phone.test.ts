// The phone bridge (rendezvous/phone.ts): a phone tunnel carrying byte streams to this PC's own HTTP listener after the
// pinned-key handshake – the dialing side here is the desktop's own connectSecure, the Android app's Java side is checked
// against the real runtime by the interop harness. Pairing itself is the connect request (phone-pair.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { connectSecure, socketPair } from '../../../src/runtime/devices/channel.ts';
import { b64url } from '../../../src/runtime/devices/keys.ts';
import { PhoneBridge, STREAM_WINDOW } from '../../../src/runtime/devices/rendezvous/phone.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { fakeHost, memoryDb, silentLog } from '../devices/fakes.ts';

const identity = (name: string) => DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name });

function bridge(pc: DeviceIdentity, port: () => number) {
  return { phone: new PhoneBridge({ identity: pc, log: silentLog, port }) };
}

test('phone tunnel: pinned-key handshake, then streams to the local listener with a bounded window', async (t) => {
  const pc = await identity('PC');
  const handset = await identity('Phone');
  const big = Buffer.alloc(STREAM_WINDOW * 3 + 123, 7);
  const server = http.createServer((request, response) => { response.setHeader('content-length', String(big.length)); response.end(big); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const { phone } = bridge(pc, () => port);
  const record = { id: 'dev_phone0000001', name: 'Phone', kind: 'phone', role: 'client', fingerprint: handset.fingerprint, publicKey: b64url(handset.publicKey), addresses: [], caps: {}, status: 'online', self: false } as unknown as DeviceRecord;

  const stranger = await identity('Stranger');
  const [s1, s2] = socketPair();
  const refused = phone.accept(s2, record);
  await assert.rejects(connectSecure(s1, stranger, pc.fingerprint), 'an unpaired key is refused in the handshake');
  await assert.rejects(refused);

  const [mine, theirs] = socketPair();
  const accepted = phone.accept(theirs, record);
  const channel = await connectSecure(mine, handset, pc.fingerprint);
  await accepted;
  const received: Buffer[] = [];
  let bytes = 0;
  let maxUnacked = 0;
  const ended = new Promise<void>((resolve) => {
    channel.onMessage((value) => {
      const message = value as { t: string; s: number; b?: string };
      if (message.t === 'd') {
        const data = Buffer.from(message.b!, 'base64');
        received.push(data);
        bytes += data.length;
        maxUnacked = Math.max(maxUnacked, bytes);
        // acknowledge in steps, like the phone's writer thread after each write
        setTimeout(() => { bytes -= data.length; if (!channel.closed) channel.send({ t: 'a', s: 1, n: data.length }); }, 1);
      }
      if (message.t === 'e') resolve();
    });
  });
  channel.send({ t: 'o', s: 1 });
  channel.send({ t: 'd', s: 1, b: Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n').toString('base64') });
  await ended;
  const whole = Buffer.concat(received).toString('latin1');
  const body = whole.slice(whole.indexOf('\r\n\r\n') + 4);
  assert.match(whole, /^HTTP\/1\.1 200/);
  assert.equal(body.length, big.length, 'the whole body arrived');
  assert.ok(maxUnacked <= STREAM_WINDOW + 64 * 1024, `unacknowledged bytes stayed near the window (${maxUnacked})`);
  phone.closeAll();
  await new Promise((resolve) => setImmediate(resolve)); // the test socket pair closes on the next tick
  assert.equal(channel.closed, true, 'closeAll ends the phone channels');
});
