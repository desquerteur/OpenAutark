// The cryptography of a connect request (requester B asks target A), a numeric-comparison exchange
// in the style of Bluetooth Secure Simple Pairing / ZRTP:
//   B → A  remote1 { device B, ephB }
//   A → B          { device A, ephA, commit = H("commit" ‖ ephA ‖ ephB ‖ Na) }
//   B → A  remote2 { Nb, sigB = Ed25519_B("B" ‖ T) }
//   A → B          { Na, sigA = Ed25519_A("A" ‖ T) }        T = H(device A, device B, ephA, ephB, commit, role)
//   code  = 4 digits of H("code" ‖ T ‖ Na ‖ Nb), shown on both screens
//   key   = HKDF(X25519(eph, eph'), salt T) – MACs the waiting, cancel and acceptance messages.
// A commits to Na before it sees Nb and B reveals Nb before it sees Na, so someone in the middle
// (two exchanges with different ephemeral keys) cannot steer both codes to the same value: the two
// people see different codes (it succeeds at most once in 10 000 tries, and requests are rate
// limited). The signatures bind each PC's long-term key – the one that gets pinned – to T.
// Owns: message values, transcript, code and key derivation. Never: sockets, storage or trust decisions.

import { createHash, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { b64url, fromB64url, generateX25519, rawPublic, verifyEd25519, x25519Shared } from '../devices/keys.ts';
import { stable, type PeerInfo } from '../devices/pair-proof.ts';
import type { JoinRole } from '../../shared/model/remote.ts';

export const REMOTE_PROTOCOL = 1;
export const NONCE_BYTES = 16;

export interface Ephemeral { privateKey: KeyObject; pub: Buffer }

export interface TranscriptInput {
  a: PeerInfo;
  b: PeerInfo;
  ephA: Buffer;
  ephB: Buffer;
  commit: string;
  /** How B joins (the CEO, an employee, or the owner's phone app, B-078) – part of what both people confirm with the code. */
  role: JoinRole | 'phone';
}

const hash = (...parts: Array<string | Uint8Array>): Buffer => {
  const h = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part);
    h.update(String(bytes.length)).update(':').update(bytes); // length-prefixed: no ambiguous joins
  }
  return h.digest();
};

export function newEphemeral(): Ephemeral {
  const pair = generateX25519();
  return { privateKey: pair.privateKey, pub: rawPublic(pair.publicKey) };
}

export function newNonce(): Buffer {
  return randomBytes(NONCE_BYTES);
}

/** A's commitment to its nonce, sent before B reveals its own. */
export function commitment(ephA: Uint8Array, ephB: Uint8Array, na: Uint8Array): string {
  return b64url(hash('wf-remote-v1 commit', ephA, ephB, na));
}

export function transcript(input: TranscriptInput): Buffer {
  return hash('wf-remote-v1 transcript', stable(input.a), stable(input.b), input.ephA, input.ephB, input.commit, input.role);
}

/** The 4-digit match code both people compare. */
export function matchCode(t: Uint8Array, na: Uint8Array, nb: Uint8Array): string {
  return String(hash('wf-remote-v1 code', t, na, nb).readUInt32BE(0) % 10_000).padStart(4, '0');
}

/** The key that MACs this request's later messages (X25519 of the two ephemeral keys, salted with T). */
export function sessionKey(own: KeyObject, peerEph: Uint8Array, t: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', x25519Shared(own, peerEph), t, Buffer.from('wf-remote-v1 key'), 32));
}

/** The signed form for side 'A' (target) or 'B' (requester). */
export function signedBytes(side: 'A' | 'B', t: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`wf-remote-v1 ${side}|`), Buffer.from(t)]);
}

export function verifySide(publicKey: string, side: 'A' | 'B', t: Uint8Array, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature.length > 200) return false;
  return verifyEd25519(fromB64url(publicKey), signedBytes(side, t), fromB64url(signature));
}

/** 32 bytes from base64url, else undefined. */
export function bytes(value: unknown, length = 32): Buffer | undefined {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  const out = fromB64url(value);
  return out.length === length ? out : undefined;
}
