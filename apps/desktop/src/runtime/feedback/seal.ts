// Sealed feedback (B-055 Q1): a report is encrypted on the sender's PC for the team's public key; only the team's
// private key opens it, so the mailbox (and anyone on the way) sees bytes only.
// Envelope v1: ASCII "WFB1" | ephemeral X25519 public key (32 raw bytes) | nonce (12) | AES-256-GCM ciphertext | tag (16).
// Content key: HKDF-SHA256 over the X25519 shared secret, salt = ephemeral public key ‖ recipient public key,
// info = "workforce-feedback v1". Keys travel as raw 32-byte base64url strings (public: JWK x, private: JWK d).
// Owns: key generation, sealing and opening (node:crypto only). Never: stores, logs or returns a private key.

import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
  type KeyObject,
} from 'node:crypto';
import { WorkforceError } from '../../shared/errors.ts';

export const ENVELOPE_MAGIC = Buffer.from('WFB1', 'ascii');
const INFO = 'workforce-feedback v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENVELOPE_MAGIC.length + KEY_BYTES + NONCE_BYTES;
/** PKCS#8 DER prefix of a raw X25519 private key (RFC 8410): node's JWK import needs `x` as well, DER does not. */
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

export interface ReceiverKeys {
  /** Raw 32-byte X25519 public key, base64url (receiver.json). */
  publicKey: string;
  /** Raw 32-byte X25519 private key, base64url (the team's vault only). */
  privateKey: string;
}

const unreadable = () => new WorkforceError('bad_request', 'This report could not be opened: it is damaged or sealed for another key.');

function raw(value: string, what: string): Buffer {
  const bytes = typeof value === 'string' && RAW_KEY.test(value) ? Buffer.from(value, 'base64url') : undefined;
  if (bytes?.length !== KEY_BYTES) throw new WorkforceError('bad_request', `The ${what} is not a 32-byte base64url X25519 key.`);
  return bytes;
}

function publicObject(bytes: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: bytes.toString('base64url') }, format: 'jwk' });
}

function privateObject(privateKey: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw(privateKey, 'private key')]), format: 'der', type: 'pkcs8' });
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(String(key.export({ format: 'jwk' }).x), 'base64url');
}

function contentKey(own: KeyObject, other: KeyObject, ephemeral: Buffer, recipient: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: own, publicKey: other }); // throws on a low-order point (all-zero secret)
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

/** A new key pair for the team (wf feedback setup). */
export function generateReceiverKeys(): ReceiverKeys {
  const jwk = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  return { publicKey: String(jwk.x), privateKey: String(jwk.d) };
}

/** The public half of a private key. */
export function publicKeyOf(privateKey: string): string {
  return rawPublic(createPublicKey(privateObject(privateKey))).toString('base64url');
}

/** Throws a clean error unless `publicKey` is a usable X25519 public key. */
export function checkPublicKey(publicKey: string): string {
  publicObject(raw(publicKey, 'public key'));
  return publicKey;
}

/** Seals `bytes` for the holder of `publicKey`'s private key. */
export function sealReport(publicKey: string, bytes: Uint8Array): Buffer {
  const recipient = raw(publicKey, 'public key');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublic(ephemeral.publicKey);
  const key = contentKey(ephemeral.privateKey, publicObject(recipient), ephemeralRaw, recipient);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([ENVELOPE_MAGIC, ephemeralRaw, nonce, body, cipher.getAuthTag()]);
}

/** Opens an envelope with the team's private key; a changed byte, another key or another format throws one clean error. */
export function openReport(privateKey: string, envelope: Uint8Array): Buffer {
  const own = privateObject(privateKey);
  const data = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  if (data.length < HEADER_BYTES + TAG_BYTES || !data.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) throw unreadable();
  const ephemeralRaw = data.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + KEY_BYTES);
  try {
    const key = contentKey(own, publicObject(Buffer.from(ephemeralRaw)), ephemeralRaw, rawPublic(createPublicKey(own)));
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(HEADER_BYTES - NONCE_BYTES, HEADER_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES, data.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw unreadable();
  }
}
