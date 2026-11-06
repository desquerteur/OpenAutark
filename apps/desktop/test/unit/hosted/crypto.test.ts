// The iPhone web app's cryptography (src/ui/hosted/crypto.ts, sas.ts) on Node's WebCrypto: the RFC 8032 / 7748 / 5869
// vectors, the connect-request vectors android/test/RemotePairTest.java checks (the same values the desktop's own
// remote/sas.ts and devices/pair-proof.ts print), and equality with the runtime's own code on random inputs.
// Owns: these assertions. Never: a network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign } from 'node:crypto';
import { b64url, fromB64url, fromHex, hex, utf8 } from '../../../src/ui/hosted/bytes.ts';
import { CounterCipher, fingerprint, hkdf, remoteIdOf, toBox, validRemoteId, verify, x25519, newDeviceKey, sign } from '../../../src/ui/hosted/crypto.ts';
import { commitment, lpHash, mac, matchCode, signedBytes, stable, transcript } from '../../../src/ui/hosted/sas.ts';
import * as runtimeSas from '../../../src/runtime/remote/sas.ts';
import { mac as runtimeMac, stable as runtimeStable } from '../../../src/runtime/devices/pair-proof.ts';
import { remoteIdOf as runtimeRemoteId, validRemoteId as runtimeValid } from '../../../src/runtime/remote/id.ts';
import { fromSender, newBox, TUNNEL_INFO } from '../../../src/runtime/devices/rendezvous/seal.ts';
import { verifyEd25519 } from '../../../src/runtime/devices/keys.ts';

const fill = (n: number, value: number) => new Uint8Array(n).fill(value);

test('RFC vectors: Ed25519 verify (8032 test 1), X25519 (7748 §6.1), HKDF-SHA256 (5869 case 1)', async () => {
  const pub = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const sig = fromHex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  assert.equal(await verify(pub, new Uint8Array(0), sig), true);
  assert.equal(await verify(pub, utf8('x'), sig), false);
  const alice = await crypto.subtle.importKey('jwk', {
    kty: 'OKP', crv: 'X25519',
    d: b64url(fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')),
    x: b64url(fromHex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')),
  }, { name: 'X25519' }, false, ['deriveBits']);
  const shared = await x25519(alice, fromHex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'));
  assert.equal(hex(shared), '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  await assert.rejects(x25519(alice, new Uint8Array(32)), 'a low-order key is refused');
  const okm = await hkdf(fill(22, 0x0b), fromHex('000102030405060708090a0b0c'), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
  assert.equal(hex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('the connect request vectors shared with Android (RemotePairTest.java)', async () => {
  const a = { id: 'dev_pc00000000001', name: 'Büro-PC "Nord"\b\f', role: 'home', pub: 'A'.repeat(43), addresses: ['http://192.168.1.2:47812', 'relay:x'] };
  const b = { id: 'dev_phone00000001', name: 'Pixel 8 😀', role: 'client', pub: 'B'.repeat(43), addresses: [] };
  const [ephA, ephB, na, nb] = [fill(32, 1), fill(32, 2), fill(16, 3), fill(16, 4)];
  assert.equal(stable(a), `{"addresses":["http://192.168.1.2:47812","relay:x"],"id":"dev_pc00000000001","name":"Büro-PC \\"Nord\\"\\b\\f","pub":"${'A'.repeat(43)}","role":"home"}`);
  const commit = await commitment(ephA, ephB, na);
  assert.equal(commit, 'n3COWC9UlCCqDOpIne6s5D01wBTN6IurBDoqNCHoGm4');
  const t = await transcript(a, b, ephA, ephB, commit, 'phone');
  assert.equal(hex(t), '1db4ffb7d7e36cbf29572f5eb12ae9df9a2940aaf41059658ddc538c1c783001');
  assert.equal(await matchCode(t, na, nb), '8629');
  assert.equal(await mac(fill(32, 5), 'remote-accept', a, b64url(t)), '30e2N-SIxf7uJVX2uehSOYY4OYeC8rTIEb9xP9Dn_xY');
  assert.equal(await mac(fill(32, 5), 'remote-wait', 'sess'), 'PTqd7ef_lYKBJOEU4Edkrk2Gi6e3T9SYRT8MwDY96NI');
  assert.equal(hex(signedBytes('B', t)).slice(0, 40), '77662d72656d6f74652d763120427c1db4ffb7d7');
});

test('equal to the runtime on random inputs: stable, hash, commitment, transcript, code, MAC, Remote ID', async () => {
  for (let round = 0; round < 25; round++) {
    const name = String.fromCharCode(...Array.from(randomBytes(12), (x) => 32 + (x % 0x2fd0)));
    const a = { id: `dev_${randomBytes(6).toString('hex')}`, name, role: 'home', pub: b64url(randomBytes(32)), addresses: [`http://10.0.0.${round}:47812`] };
    const b = { id: `dev_${randomBytes(6).toString('hex')}`, name: name.split('').reverse().join(''), role: 'client', pub: b64url(randomBytes(32)), addresses: [] };
    assert.equal(stable(a), runtimeStable(a));
    const [ephA, ephB, na, nb, key] = [randomBytes(32), randomBytes(32), randomBytes(16), randomBytes(16), randomBytes(32)];
    const commit = await commitment(new Uint8Array(ephA), new Uint8Array(ephB), new Uint8Array(na));
    assert.equal(commit, runtimeSas.commitment(ephA, ephB, na));
    const t = await transcript(a, b, new Uint8Array(ephA), new Uint8Array(ephB), commit, 'phone');
    assert.equal(hex(t), runtimeSas.transcript({ a: a as never, b: b as never, ephA, ephB, commit, role: 'phone' }).toString('hex'));
    assert.equal(await matchCode(t, new Uint8Array(na), new Uint8Array(nb)), runtimeSas.matchCode(t, na, nb));
    assert.equal(await mac(new Uint8Array(key), 'remote-accept', a, b64url(t)), runtimeMac(key, 'remote-accept', a, b64url(t)));
    const fp = createHash('sha256').update(randomBytes(32)).digest('hex');
    const id = await remoteIdOf(fp);
    assert.equal(id, runtimeRemoteId(fp));
    assert.equal(validRemoteId(id), runtimeValid(id));
    assert.equal(validRemoteId(id.slice(0, 8) + String((Number(id[8]) + 1) % 10)), false);
    assert.equal(hex(await lpHash('x', new Uint8Array(na))), createHash('sha256').update('1:x16:').update(na).digest('hex'));
  }
});

test('a device key made in WebCrypto is non-extractable and signs what the runtime verifies', async () => {
  const key = await newDeviceKey();
  assert.equal(key.privateKey.extractable, false);
  const data = utf8('wf-relay-v1|hello|abc');
  const signature = await sign(key.privateKey, data);
  assert.equal(verifyEd25519(key.pub, data, signature), true);
  assert.equal(await fingerprint(key.pub), createHash('sha256').update(key.pub).digest('hex'));
  const node = generateKeyPairSync('ed25519');
  const raw = node.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  assert.equal(await verify(new Uint8Array(raw), data, new Uint8Array(nodeSign(null, data, node.privateKey))), true);
});

test('the tunnel seal opens on the runtime side (toBox ↔ fromSender) in both directions, in order', async () => {
  const box = newBox();
  const mine = await toBox(fromB64url(box.pub), TUNNEL_INFO);
  const theirs = fromSender(box, mine.e, TUNNEL_INFO)!;
  const frames = await Promise.all(['one', 'two', 'three'].map((text) => mine.cipher.seal(utf8(text))));
  assert.deepEqual(frames.map((frame) => theirs.open(Buffer.from(frame))?.toString()), ['one', 'two', 'three']);
  const back = theirs.seal(Buffer.from('reply'));
  assert.equal(new TextDecoder().decode((await mine.cipher.open(new Uint8Array(back)))!), 'reply');
  const replay = await mine.cipher.open(new Uint8Array(back));
  assert.equal(replay, undefined, 'a replayed frame does not open');
  assert.ok(new CounterCipher(fill(32, 1), fill(32, 2)));
});
