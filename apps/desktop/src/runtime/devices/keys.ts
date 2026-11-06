// Small key helpers on top of node:crypto for device identity and the peer handshake.
// Owns: raw <-> KeyObject conversion for Ed25519/X25519, signatures, fingerprints, base64url.
// Never: stores keys (identity.ts does) or logs key material.

import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

export function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Raw 32-byte public key of an Ed25519/X25519 KeyObject. */
export function rawPublic(key: KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function ed25519Public(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('Invalid Ed25519 public key');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

export function x25519Public(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('Invalid X25519 public key');
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

export function generateEd25519(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

export function generateX25519(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('x25519');
}

export function exportPrivate(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

export function importPrivate(pkcs8Base64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' });
}

export function signEd25519(privateKey: KeyObject, data: Uint8Array): Buffer {
  return sign(null, data, privateKey);
}

export function verifyEd25519(publicRaw: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, data, ed25519Public(publicRaw), signature);
  } catch {
    return false;
  }
}

export function x25519Shared(privateKey: KeyObject, peerRaw: Uint8Array): Buffer {
  return diffieHellman({ privateKey, publicKey: x25519Public(peerRaw) });
}

/** Device fingerprint: sha256 (hex) of the raw Ed25519 public key. */
export function fingerprintOf(publicRaw: Uint8Array): string {
  return createHash('sha256').update(publicRaw).digest('hex');
}

/** "abcd ef01 …" – 16 groups of 4 hex chars, shown as a 4×4 block in the UI. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? []).slice(0, 16).join(' ');
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}
