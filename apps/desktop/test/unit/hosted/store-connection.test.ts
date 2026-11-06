// What the iPhone web app keeps and how it reconnects (src/ui/hosted/store.ts, connection.ts): the non-extractable key
// survives a store round trip and still signs, broken records read as "not paired", the PC list is checked, the PC
// UI's marker decides whether it loads; reconnecting backs off 1 s, 2 s, … with one-shot timers and a resume redials
// at once; a throwaway key proves the store keeps keys before Connect. Owns: these assertions. Never: a meeting server
// (pair-flow.test.ts) or IndexedDB itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { b64url, utf8 } from '../../../src/ui/hosted/bytes.ts';
import { newDeviceKey, sign } from '../../../src/ui/hosted/crypto.ts';
import { BACKOFF_MS, Connection } from '../../../src/ui/hosted/connection.ts';
import { newDeviceId, phoneName } from '../../../src/ui/hosted/pair.ts';
import { HostedStore, keepsKeys, memoryBackend, pcEntry, pcsOf } from '../../../src/ui/hosted/store.ts';
import { verifyEd25519 } from '../../../src/runtime/devices/keys.ts';

async function saved() {
  const key = await newDeviceKey();
  const pub = b64url(new Uint8Array(32).fill(7));
  const pc = { deviceId: 'dev_desk0000001', name: 'Desk', fingerprint: createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex'), publicKey: pub };
  return { key, deviceId: newDeviceId(), relay: 'ws://127.0.0.1:9', token: 'tok_secret', pcs: [pc] };
}

test('the store keeps the key as a CryptoKey that still signs; broken records read as not paired', async () => {
  const backend = memoryBackend();
  const store = new HostedStore(backend);
  assert.equal(await store.load(), undefined);
  const state = await saved();
  await store.save(state, 1);
  const identity = backend.data.get('identity') as { privateKey: CryptoKey; pub: string };
  assert.equal(identity.privateKey.extractable, false, 'the private half never leaves WebCrypto');
  assert.equal(JSON.stringify(identity).includes('tok_secret'), false, 'the token is not stored with the key');
  const loaded = (await store.load())!;
  assert.equal(loaded.token, 'tok_secret');
  const signature = await sign(loaded.key.privateKey, utf8('x'));
  assert.ok(verifyEd25519(loaded.key.pub, utf8('x'), signature), 'the stored key signs for its public half');
  await store.savePcs([...state.pcs, { deviceId: 'x', name: 'Bad', fingerprint: 'nothex', publicKey: 'A' }]);
  assert.equal((await store.load())!.pcs.length, 1, 'a row that does not hold together is dropped');
  backend.data.set('pairing', { relay: 'ws://x', token: 'tok', pcs: [] });
  assert.equal(await store.load(), undefined, 'no PC: not paired');
  await store.clear();
  assert.equal(backend.data.size, 0);
  assert.match(newDeviceId(), /^dev_[0-9a-z]{20}$/);
  assert.equal(phoneName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)'), 'iPhone');
  assert.equal(phoneName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'iPad');
  assert.deepEqual(pcsOf([{ deviceId: 'd', name: 'n', fingerprint: 'a'.repeat(64), publicKey: 'k' }, null]).length, 1);
});

test('before Connect a throwaway key round-trips through the store; a browser that loses or refuses it is caught', async () => {
  const backend = memoryBackend();
  assert.equal(await keepsKeys(backend), true);
  assert.equal(backend.data.size, 0, 'the probe is removed again');
  const forgetful = { ...memoryBackend(), get: async () => undefined };
  assert.equal(await keepsKeys(forgetful), false, 'a key that does not come back');
  const refusing = { ...memoryBackend(), set: async () => { throw new Error('DataCloneError'); } };
  assert.equal(await keepsKeys(refusing), false, 'WebKit refusing to clone the CryptoKey');
  const other = await newDeviceKey();
  const swapped = { ...memoryBackend(), get: async () => ({ privateKey: other.privateKey }) };
  assert.equal(await keepsKeys(swapped), false, 'a key that no longer signs for its public half');
});

test('the PC UI loads only with the autark-hosted marker (an older PC says "Update")', () => {
  assert.deepEqual(pcEntry('<meta name="autark-hosted" content="1"><link rel="stylesheet" href="main.css"><script type="module" src="main.js"></script>'), { css: 'main.css', js: 'main.js' });
  assert.equal(pcEntry('<link rel="stylesheet" href="main.css"><script type="module" src="main.js"></script>'), undefined);
  assert.deepEqual(pcEntry('<meta name="autark-hosted" content="1"><script type="module" src="https://evil.example/x.js"></script>'), { css: 'main.css', js: 'main.js' }, 'never another origin');
});

test('reconnecting backs off 1 s, 2 s … with one-shot timers; a resume redials at once', async () => {
  let dials = 0;
  const statuses: string[] = [];
  const state = await saved();
  const connection = new Connection({
    saved: state,
    socket: () => { dials++; throw new Error('The meeting server is not reachable.'); },
    status: (text) => statuses.push(text),
  });
  assert.deepEqual(BACKOFF_MS, [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]);
  connection.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dials, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(dials, 2, 'again after 1 s');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(dials, 2, 'the next pause is 2 s');
  connection.nudge(60_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dials, 3, 'a resume after a long pause dials at once');
  assert.equal(await connection.awaitMux(30), undefined);
  connection.stop();
  const before = dials;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(dials, before, 'stopped: no timer left');
  assert.ok(statuses.some((text) => /not reachable/.test(text)));
});
