// Message encryption for Web Push (RFC 8291) with the "aes128gcm" content coding (RFC 8188),
// implemented with node:crypto only. One record; payloads are small JSON notifications.
// Owns: encrypt (server side) and decrypt (used by tests and diagnostics).
// Never: network, subscription storage or VAPID (see vapid.ts / push.ts).
//
//   ecdh_secret = ECDH(as_private, ua_public)
//   PRK_key     = HMAC(auth_secret, ecdh_secret)
//   IKM         = HMAC(PRK_key, "WebPush: info\0" ‖ ua_public ‖ as_public ‖ 0x01)
//   PRK         = HMAC(salt, IKM)
//   CEK         = HMAC(PRK, "Content-Encoding: aes128gcm\0" ‖ 0x01)[0..16]
//   NONCE       = HMAC(PRK, "Content-Encoding: nonce\0" ‖ 0x01)[0..12]
//   body        = salt(16) ‖ rs(4, BE) ‖ idlen(1)=65 ‖ as_public(65) ‖ AES-128-GCM(plaintext ‖ 0x02)

import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

const RECORD_SIZE = 4096;

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function keys(input: { ecdhSecret: Buffer; auth: Buffer; uaPublic: Buffer; asPublic: Buffer; salt: Buffer }): { cek: Buffer; nonce: Buffer } {
  const prkKey = hmac(input.auth, input.ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), input.uaPublic, input.asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(input.salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  return { cek, nonce };
}

/** Encrypts `plaintext` for a subscription's `p256dh` (65-byte uncompressed point) and `auth` (16 bytes). */
export function encryptPayload(plaintext: Uint8Array, uaPublic: Uint8Array, auth: Uint8Array, testing?: { asPrivate?: Buffer; salt?: Buffer }): Buffer {
  const ua = Buffer.from(uaPublic);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error('Invalid p256dh key');
  if (auth.length !== 16) throw new Error('Invalid auth secret');
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error('Push payload too large');
  const ecdh = createECDH('prime256v1');
  if (testing?.asPrivate) ecdh.setPrivateKey(testing.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = testing?.salt ?? randomBytes(16);
  const { cek, nonce } = keys({ ecdhSecret: ecdh.computeSecret(ua), auth: Buffer.from(auth), uaPublic: ua, asPublic, salt });
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Decrypts an aes128gcm push body with the user agent's private key (what a browser does). */
export function decryptPayload(body: Uint8Array, uaPrivate: Buffer, auth: Uint8Array): Buffer {
  const data = Buffer.from(body);
  const salt = data.subarray(0, 16);
  const idLength = data[20];
  const asPublic = data.subarray(21, 21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const { cek, nonce } = keys({ ecdhSecret: ecdh.computeSecret(asPublic), auth: Buffer.from(auth), uaPublic: ecdh.getPublicKey(), asPublic, salt });
  const record = data.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('Invalid padding delimiter');
  return padded.subarray(0, end);
}
