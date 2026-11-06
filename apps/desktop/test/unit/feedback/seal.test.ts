// B-055 Q1: sealed feedback – the envelope v1 layout, the documented key derivation (checked with an independent
// opener written from the format description), tamper and wrong-key errors, key formats.
// Owns: these assertions. Never: uses a real team key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { ENVELOPE_MAGIC, checkPublicKey, generateReceiverKeys, openReport, publicKeyOf, sealReport } from '../../../src/runtime/feedback/seal.ts';

const message = Buffer.from(JSON.stringify({ v: 1, id: 'x', text: 'Grüße – the sidebar flickers 🙂' }), 'utf8');

test('seal/open roundtrip; layout WFB1 | ephemeral key | nonce | ciphertext | tag; every seal differs', () => {
  const keys = generateReceiverKeys();
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(publicKeyOf(keys.privateKey), keys.publicKey);
  const sealed = sealReport(keys.publicKey, message);
  assert.deepEqual(sealed.subarray(0, 4), ENVELOPE_MAGIC);
  assert.equal(sealed.subarray(0, 4).toString('ascii'), 'WFB1');
  assert.equal(sealed.length, 4 + 32 + 12 + message.length + 16);
  assert.deepEqual(openReport(keys.privateKey, sealed), message);
  const again = sealReport(keys.publicKey, message);
  assert.notDeepEqual(again.subarray(4, 48), sealed.subarray(4, 48), 'a new ephemeral key and nonce each time');
  assert.equal(sealed.includes(Buffer.from('sidebar')), false, 'no plaintext in the envelope');
});

test('the format as documented: X25519 + HKDF-SHA256 (salt eph‖recipient, info "workforce-feedback v1") + AES-256-GCM', () => {
  const keys = generateReceiverKeys();
  const sealed = sealReport(keys.publicKey, message);
  const eph = sealed.subarray(4, 36);
  const nonce = sealed.subarray(36, 48);
  const tag = sealed.subarray(sealed.length - 16);
  const own = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: keys.privateKey, x: keys.publicKey }, format: 'jwk' });
  const shared = diffieHellman({ privateKey: own, publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: eph.toString('base64url') }, format: 'jwk' }) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, Buffer.from(keys.publicKey, 'base64url')]), 'workforce-feedback v1', 32));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  assert.deepEqual(Buffer.concat([decipher.update(sealed.subarray(48, sealed.length - 16)), decipher.final()]), message);
});

test('a changed byte anywhere, a cut envelope or another format fails with one clean error', () => {
  const keys = generateReceiverKeys();
  const sealed = sealReport(keys.publicKey, message);
  for (const at of [0, 3, 4, 20, 35, 36, 47, 48, 60, sealed.length - 17, sealed.length - 16, sealed.length - 1]) {
    const changed = Buffer.from(sealed);
    changed[at] ^= 0x01;
    assert.throws(() => openReport(keys.privateKey, changed), /could not be opened/, `byte ${at}`);
  }
  for (const cut of [sealed.subarray(0, 63), sealed.subarray(0, sealed.length - 1), Buffer.alloc(0), Buffer.from('WFB1')]) {
    assert.throws(() => openReport(keys.privateKey, cut), /could not be opened/);
  }
  const low = Buffer.from(sealed);
  low.fill(0, 4, 36); // an all-zero ephemeral key (low order point)
  assert.throws(() => openReport(keys.privateKey, low), /could not be opened/);
});

test('another private key cannot open it', () => {
  const team = generateReceiverKeys();
  const other = generateReceiverKeys();
  assert.throws(() => openReport(other.privateKey, sealReport(team.publicKey, message)), (error: Error) => {
    assert.match(error.message, /sealed for another key/);
    assert.doesNotMatch(error.message, new RegExp(other.privateKey));
    return true;
  });
});

test('keys must be raw 32-byte base64url strings', () => {
  for (const bad of ['', 'abc', 'A'.repeat(42), `${'A'.repeat(42)}=`, 'A'.repeat(44), Buffer.alloc(32).toString('base64')]) {
    assert.throws(() => sealReport(bad, message), /32-byte base64url/, bad);
    assert.throws(() => checkPublicKey(bad), /32-byte base64url/);
  }
  assert.throws(() => openReport('nope', Buffer.alloc(80)), /32-byte base64url/);
  const keys = generateReceiverKeys();
  assert.equal(checkPublicKey(keys.publicKey), keys.publicKey);
});
