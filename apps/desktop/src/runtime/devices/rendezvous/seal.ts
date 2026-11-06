// End-to-end sealing for traffic that passes the meeting server (services/remote-relay): every
// device publishes a per-session X25519 "box" key there, signed with its long-term Ed25519 device
// key. A sender derives two AES-256-GCM keys from a fresh ephemeral key and the receiver's box
// (HKDF-SHA256, salt = ephemeral ‖ box): one per direction, nonces are message counters. Used
// for pairing messages to a PC known only by its Remote ID and for the first (text) handshake
// frames of a relay tunnel, so the relay sees ciphertext only – the peer channel's own
// encryption (devices/channel.ts) protects everything after that. A tunnel's `e` is signed by
// the opener's device key (tunnelText), so an active relay cannot stand in for a pinned PC.
// Owns: box key pairs, their signatures, key derivation and the counter cipher. Never: sockets,
// storage, or trusting a box key whose signature does not match the pinned/registered key.

import { createCipheriv, createDecipheriv, hkdfSync, type KeyObject } from 'node:crypto';
import { b64url, fromB64url, generateX25519, rawPublic, verifyEd25519, x25519Shared } from '../keys.ts';

export const PAIR_INFO = 'wf-relay-pair-v1';
export const TUNNEL_INFO = 'wf-relay-tunnel-v1';

/** What the relay protocol has a device sign (services/remote-relay/src/protocol.ts). */
export const helloText = (challenge: string): string => `wf-relay-v1|hello|${challenge}`;
export const boxText = (box: string): string => `wf-relay-v1|box|${box}`;
/**
 * What the opener of a tunnel signs with its device key: its ephemeral key `e` for the receiver's
 * box. Without it a relay could open a tunnel with its own `e` and claim to be a pinned PC.
 */
export const tunnelText = (e: string, box: string): string => `wf-relay-v1|tunnel|${e}|${box}`;

export interface Box { privateKey: KeyObject; pub: string }

/** A fresh per-session box key pair (kept in memory only). */
export function newBox(): Box {
  const pair = generateX25519();
  return { privateKey: pair.privateKey, pub: b64url(rawPublic(pair.publicKey)) };
}

/** True when `boxSig` is the device key `pub` (base64url) signing `box`. */
export function boxSigned(pub: string, box: unknown, boxSig: unknown): box is string {
  if (typeof box !== 'string' || typeof boxSig !== 'string' || box.length > 64 || boxSig.length > 128) return false;
  try {
    const raw = fromB64url(pub);
    return raw.length === 32 && fromB64url(box).length === 32 && verifyEd25519(raw, Buffer.from(boxText(box), 'utf8'), fromB64url(boxSig));
  } catch {
    return false;
  }
}

/** AES-256-GCM with implicit counters (frames arrive in order over one relay connection). */
export class CounterCipher {
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;
  private sent = 0n;
  private received = 0n;

  constructor(sendKey: Buffer, receiveKey: Buffer) {
    this.sendKey = sendKey;
    this.receiveKey = receiveKey;
  }

  seal(plain: Buffer): Buffer {
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonce(this.sent++));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  /** The plain bytes, or undefined (tampered, replayed or out of order). */
  open(frame: Buffer): Buffer | undefined {
    if (frame.length < 16) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, nonce(this.received));
      decipher.setAuthTag(frame.subarray(frame.length - 16));
      const plain = Buffer.concat([decipher.update(frame.subarray(0, frame.length - 16)), decipher.final()]);
      this.received++;
      return plain;
    } catch {
      return undefined;
    }
  }
}

function nonce(counter: bigint): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(counter, 4);
  return out;
}

function derive(shared: Buffer, e: Buffer, box: Buffer, info: string): { toOwner: Buffer; toOpener: Buffer } {
  const okm = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([e, box]), Buffer.from(info), 64));
  return { toOwner: okm.subarray(0, 32), toOpener: okm.subarray(32, 64) };
}

/** Sender side: a fresh ephemeral key `e` (sent along) and the cipher towards `box`'s owner. */
export function toBox(box: string, info: string): { e: string; cipher: CounterCipher } {
  const boxRaw = fromB64url(box);
  const eph = generateX25519();
  const e = rawPublic(eph.publicKey);
  const keys = derive(x25519Shared(eph.privateKey, boxRaw), e, boxRaw, info);
  return { e: b64url(e), cipher: new CounterCipher(keys.toOwner, keys.toOpener) };
}

/** Owner side: the cipher for a sender's ephemeral key `e`, or undefined when `e` is malformed. */
export function fromSender(own: Box, e: unknown, info: string): CounterCipher | undefined {
  if (typeof e !== 'string' || e.length > 64) return undefined;
  try {
    const eRaw = fromB64url(e);
    if (eRaw.length !== 32) return undefined;
    const keys = derive(x25519Shared(own.privateKey, eRaw), eRaw, fromB64url(own.pub), info);
    return new CounterCipher(keys.toOpener, keys.toOwner);
  } catch {
    return undefined;
  }
}

/** JSON ↔ sealed base64url with one cipher (one message each way for pairing). */
export const sealJson = (cipher: CounterCipher, value: unknown): string => b64url(cipher.seal(Buffer.from(JSON.stringify(value), 'utf8')));

export function openJson(cipher: CounterCipher, sealed: unknown): unknown {
  if (typeof sealed !== 'string' || sealed.length > 22_000) return undefined;
  const plain = cipher.open(fromB64url(sealed));
  if (!plain) return undefined;
  try { return JSON.parse(plain.toString('utf8')); } catch { return undefined; }
}
