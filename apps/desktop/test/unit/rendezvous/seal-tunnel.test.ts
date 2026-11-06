// Sealing to a box key (rendezvous/seal.ts) and the relay tunnel framing (rendezvous/tunnel.ts):
// both directions open, tampering/wrong keys fail, box keys need the device key's signature,
// large messages are split into relay-sized chunks and joined again, text frames never travel in
// the clear, closing tells the relay once, and nothing big is held before the other end proved
// it holds the tunnel keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptSecure, connectSecure } from '../../../src/runtime/devices/channel.ts';
import { b64url, fingerprintOf, generateEd25519, rawPublic, signEd25519 } from '../../../src/runtime/devices/keys.ts';
import { PAIR_INFO, TUNNEL_INFO, boxSigned, boxText, fromSender, newBox, openJson, sealJson, toBox } from '../../../src/runtime/devices/rendezvous/seal.ts';
import { CHUNK, HEADER, MAX_TEXT, RelayTunnel } from '../../../src/runtime/devices/rendezvous/tunnel.ts';

test('a sealed message opens only for the box owner, the reply only for the sender; box keys must be signed', () => {
  const owner = newBox();
  const { e, cipher } = toBox(owner.pub, PAIR_INFO);
  const sealed = sealJson(cipher, { kind: 'remote1', name: 'Laptop' });
  assert.ok(!Buffer.from(sealed, 'base64url').toString('latin1').includes('Laptop'), 'no plain text on the wire');
  const opened = fromSender(owner, e, PAIR_INFO)!;
  assert.deepEqual(openJson(opened, sealed), { kind: 'remote1', name: 'Laptop' });
  assert.deepEqual(openJson(cipher, sealJson(opened, { ok: true })), { ok: true }, 'the reply goes back with the other key');
  assert.equal(openJson(fromSender(newBox(), e, PAIR_INFO)!, sealed), undefined, 'another box cannot open it');
  assert.equal(openJson(fromSender(owner, e, TUNNEL_INFO)!, sealed), undefined, 'keys are bound to their purpose');
  const tampered = Buffer.from(sealed, 'base64url');
  tampered[2] ^= 1;
  assert.equal(openJson(fromSender(owner, e, PAIR_INFO)!, b64url(tampered)), undefined);
  assert.equal(fromSender(owner, 'short', PAIR_INFO), undefined);

  const device = generateEd25519();
  const pub = b64url(rawPublic(device.publicKey));
  const sig = b64url(signEd25519(device.privateKey, Buffer.from(boxText(owner.pub))));
  assert.equal(boxSigned(pub, owner.pub, sig), true);
  assert.equal(boxSigned(pub, newBox().pub, sig), false, 'a swapped box key fails');
  assert.equal(boxSigned(b64url(rawPublic(generateEd25519().publicKey)), owner.pub, sig), false, 'another device key fails');
});

function pair() {
  const owner = newBox();
  const { e, cipher } = toBox(owner.pub, TUNNEL_INFO);
  const wire: { a: Buffer[]; b: Buffer[]; closes: string[] } = { a: [], b: [], closes: [] };
  const a = new RelayTunnel(7, 'fp-b', { send: (frame) => wire.a.push(frame), close: () => wire.closes.push('a') }, cipher);
  const b = new RelayTunnel(7, 'fp-a', { send: (frame) => wire.b.push(frame), close: () => wire.closes.push('b') }, fromSender(owner, e, TUNNEL_INFO)!);
  return { a, b, wire };
}

test('tunnel frames: large binary messages are chunked and joined, text is sealed, close is told once', async () => {
  const { a, b, wire } = pair();
  const got: Array<{ data: string; text: boolean }> = [];
  b.onMessage((data, text) => got.push({ data: text ? data.toString('utf8') : `bin:${data.length}:${data[data.length - 1]}`, text }));
  a.send('{"t":"hello","id":"dev_secret"}'); // the handshake always starts with text
  assert.ok(!wire.a[0].toString('latin1').includes('dev_secret'), 'handshake text is sealed for the relay');
  b.receive(wire.a.shift()!);
  const big = Buffer.alloc(200_000, 3);
  a.send(big);
  assert.equal(wire.a.length, Math.ceil(big.length / CHUNK));
  assert.ok(wire.a.every((frame) => frame.length <= HEADER + CHUNK && frame.readUInt32BE(0) === 7));
  assert.deepEqual(wire.a.map((frame) => frame[4]), [2, 2, 2, 0], 'MORE on all but the last chunk');
  for (const frame of wire.a.splice(0)) b.receive(frame);
  assert.deepEqual(got, [{ data: '{"t":"hello","id":"dev_secret"}', text: true }, { data: 'bin:200000:3', text: false }]);

  let closed = 0;
  a.onClose(() => closed++);
  a.close();
  a.close();
  a.ended();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.deepEqual(wire.closes, ['a']);
  a.send('after close');
  assert.equal(wire.a.length, 0, 'nothing is sent after close');

  const forged = Buffer.concat([Buffer.from([0, 0, 0, 7, 1]), Buffer.alloc(40, 9)]);
  b.receive(forged);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.closed, true, 'a text frame that does not open ends the tunnel');
});

test('a relay cannot make a tunnel hold much: binary before the other end proved its keys, or big text, ends it', async () => {
  const frame = (flags: number, size: number) => { const out = Buffer.alloc(HEADER + size, 1); out.writeUInt32BE(7, 0); out[4] = flags; return out; };
  const early = pair().b;
  early.receive(frame(2, CHUNK)); // MORE, binary, before any sealed text
  assert.equal(early.closed, true, 'binary before the handshake ends the tunnel');

  const flood = pair().b;
  for (let index = 0; index < 3 && !flood.closed; index++) flood.receive(frame(1 | 2, 8 * 1024)); // TEXT | MORE
  assert.equal(flood.closed, true, 'text beyond 16 KiB ends it (nothing is reassembled up to 8 MiB)');

  const { a, b, wire } = pair();
  a.send('x'.repeat(MAX_TEXT + 1));
  for (const sent of wire.a.splice(0)) b.receive(sent);
  assert.equal(b.closed, true, 'even a genuine text message over the limit');
});

test('the peer channel runs over a tunnel; messages right behind the handshake reach the first listener', async () => {
  const owner = newBox();
  const { e, cipher } = toBox(owner.pub, TUNNEL_INFO);
  const sides: { a?: RelayTunnel; b?: RelayTunnel } = {};
  // Synchronous delivery: the relay hands several frames over in one tick.
  sides.a = new RelayTunnel(1, 'b', { send: (frame) => sides.b!.receive(frame), close: () => sides.b!.ended() }, cipher);
  sides.b = new RelayTunnel(1, 'a', { send: (frame) => sides.a!.receive(frame), close: () => sides.a!.ended() }, fromSender(owner, e, TUNNEL_INFO)!);
  const signer = (deviceId: string) => {
    const keys = generateEd25519();
    return { deviceId, publicKey: rawPublic(keys.publicKey), sign: (data: Uint8Array) => signEd25519(keys.privateKey, data) };
  };
  const client = signer('dev_client00000');
  const server = signer('dev_server00000');
  const accepted = acceptSecure(sides.b, server, () => 'dev_client00000');
  const dialed = await connectSecure(sides.a, client, fingerprintOf(server.publicKey));
  dialed.send({ n: 1 });
  dialed.send({ n: 2 });
  const channel = await accepted;
  const got: unknown[] = [];
  channel.onMessage((message) => got.push(message));
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }]);
  channel.send({ back: true });
  const back: unknown[] = [];
  dialed.onMessage((message) => back.push(message));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(back, [{ back: true }]);
});
