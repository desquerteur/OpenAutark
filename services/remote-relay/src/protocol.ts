// Workforce remote relay, protocol v1: frame shapes, strict parsing and the few crypto checks the
// relay itself makes. The relay never decrypts anything – it checks that a device holds the
// Ed25519 key it registers with (a signed challenge), derives its routing key (fingerprint) and,
// for devices that accept connection requests, its Remote ID (the same derivation as the desktop
// app: apps/desktop/src/runtime/remote/id.ts).
// Owns: constants, validation of client frames, signature/fingerprint/Remote ID helpers.
// Never: sockets, state or logging.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const PROTOCOL = 1;
/** Text (control) frames are JSON of at most this size. */
export const MAX_CONTROL_BYTES = 16 * 1024;
/** Binary (tunnel) frames: 4-byte tunnel id, 1 flag byte, at most 64 KiB payload. */
export const DATA_HEADER = 5;
export const MAX_DATA_PAYLOAD = 64 * 1024;
export const MAX_PEERS = 64;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const FP = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export const b64url = (data: Uint8Array): string => Buffer.from(data).toString('base64url');

/** 32 random bytes, base64url: the per-connection challenge. */
export const newChallenge = (): string => b64url(randomBytes(32));

/** Raw 32-byte key from base64url, else undefined. */
export function key32(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length > 64 || !B64URL.test(value)) return undefined;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === 32 ? raw : undefined;
}

/** Ed25519 signature check over UTF-8 text; false for any malformed input. */
export function signed(pub: Buffer, text: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || signature.length > 128 || !B64URL.test(signature)) return false;
  try {
    const keyObject = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(text, 'utf8'), keyObject, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** Device fingerprint: sha256 (hex) of the raw Ed25519 public key – the relay's routing key. */
export const fingerprintOf = (pub: Uint8Array): string => createHash('sha256').update(pub).digest('hex');

export const isFingerprint = (value: unknown): value is string => typeof value === 'string' && FP.test(value);

function luhnDigit(payload: string): string {
  let sum = 0;
  for (let index = 0; index < payload.length; index++) {
    let digit = Number(payload[payload.length - 1 - index]);
    if (index % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/** The 9-digit Remote ID of a fingerprint (8 digits from its hash + a Luhn check digit). */
export function remoteIdOf(fingerprint: string): string {
  const digest = createHash('sha256').update(`wf-remote-id-v1|${fingerprint.toLowerCase()}`).digest();
  const payload = String(digest.readUInt32BE(0) * 4 + (digest.readUInt8(4) & 3)).padStart(10, '0').slice(-8);
  return payload + luhnDigit(payload);
}

/** What a device signs to register: proves it holds the key for this connection's challenge. */
export const helloText = (challenge: string): string => `wf-relay-v1|hello|${challenge}`;
/** What a device signs so others can trust its per-session X25519 box key (checked by peers, not the relay). */
export const boxText = (box: string): string => `wf-relay-v1|box|${box}`;

export type Frame = Record<string, unknown> & { t: string };

/** A client's JSON control frame, or undefined (not JSON, too big, no type). */
export function parseControl(data: Buffer): Frame | undefined {
  if (data.length > MAX_CONTROL_BYTES) return undefined;
  try {
    const value = JSON.parse(data.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const frame = value as Frame;
    return typeof frame.t === 'string' && frame.t.length <= 20 ? frame : undefined;
  } catch {
    return undefined;
  }
}

/** A list of at most MAX_PEERS fingerprints (duplicates dropped), else undefined. */
export function peerList(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value) || value.length > MAX_PEERS || !value.every(isFingerprint)) return undefined;
  return new Set(value as string[]);
}

/** A client-chosen request reference: a small non-negative integer. */
export const isRef = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 2 ** 31;

/** An opaque base64url value of bounded length (ciphertext, ephemeral keys). */
export const opaque = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && B64URL.test(value);

/** Binary tunnel frame header → tunnel id, or undefined when malformed. */
export function tunnelOf(frame: Buffer): number | undefined {
  if (frame.length < DATA_HEADER || frame.length > DATA_HEADER + MAX_DATA_PAYLOAD) return undefined;
  return frame.readUInt32BE(0);
}
