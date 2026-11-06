// The iPhone web app's cryptography (B-078 follow-up): the exact primitives Autark's PCs use for the meeting server and
// the peer channel – Ed25519 device keys, X25519, HKDF-SHA256, HMAC-SHA256, SHA-256, AES-256-GCM with counter nonces –
// byte for byte as runtime/devices/{keys,handshake,channel}.ts, rendezvous/seal.ts and Android's relay/Crypto.java, but on
// WebCrypto (Safari 17 / iOS 17, Node 24). WebCrypto answers asynchronously, so every counter cipher runs its seals and
// opens through one ordered queue: counters leave and are opened in order, as the PC requires. The phone's private key is
// created non-extractable and only ever used through WebCrypto. Also the fingerprint and the Remote ID (remote/id.ts).
// Owns: these primitives and the ordering queue. Never: stores keys, sockets, or logs key material.

import { b64url, concat, hex, own, utf8, type Bytes } from './bytes.ts';

const subtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw new Error('This browser has no WebCrypto (iOS 17 or newer is needed).');
  return globalThis.crypto.subtle;
};

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

export async function sha1(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-1', data));
}

export async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}

/** HKDF-SHA256 (RFC 5869); an empty salt is HashLen zeros, as everywhere else. */
export async function hkdf(ikm: Bytes, salt: Bytes, info: string | Bytes, length: number): Promise<Bytes> {
  const k = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? utf8(info) : info }, k, length * 8));
}

// ------------------------------------------------------------------ Ed25519 device key

/** A device key: the private half stays inside WebCrypto (non-extractable), the raw public key travels. */
export interface DeviceKey { privateKey: CryptoKey; pub: Bytes }

export async function newDeviceKey(): Promise<DeviceKey> {
  const pair = (await subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, pub: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}

export async function sign(key: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key, data));
}

export async function verify(pub: Uint8Array, data: Bytes, signature: Uint8Array): Promise<boolean> {
  if (pub.length !== 32 || signature.length !== 64) return false;
  try {
    const k = await subtle().importKey('raw', own(pub), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, k, own(signature), data);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ X25519

export interface Ephemeral { privateKey: CryptoKey; pub: Bytes }

export async function newX25519(): Promise<Ephemeral> {
  const pair = (await subtle().generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, pub: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}

/** The shared secret with a peer's raw X25519 key; throws for a malformed or low-order key (all-zero result). */
export async function x25519(own32: CryptoKey, peer: Uint8Array): Promise<Bytes> {
  if (peer.length !== 32) throw new Error('bad key');
  const k = await subtle().importKey('raw', own(peer), { name: 'X25519' }, false, []);
  const out = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: k }, own32, 256));
  if (out.every((b) => b === 0)) throw new Error('weak key');
  return out;
}

// ------------------------------------------------------------------ AES-256-GCM with counters

export function nonce(counter: bigint): Bytes {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, counter);
  return out;
}

export async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, counter: bigint, plain: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce(counter), tagLength: 128 }, key, plain));
}

/** The plain bytes, or undefined when the frame does not open with this key and counter. */
export async function open(key: CryptoKey, counter: bigint, sealed: Bytes): Promise<Bytes | undefined> {
  if (sealed.length < 16) return undefined;
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce(counter), tagLength: 128 }, key, sealed));
  } catch {
    return undefined;
  }
}

/** Runs async steps one after another, in the order they were queued (a failed step does not stop the next). */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.tail.then(step, step);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** rendezvous/seal.ts CounterCipher: implicit counters, one key per direction, strictly in order. */
export class CounterCipher {
  private readonly send: Promise<CryptoKey>;
  private readonly receive: Promise<CryptoKey>;
  private sent = 0n;
  private received = 0n;
  private readonly sealing = new Serial();
  private readonly opening = new Serial();

  constructor(sendKey: Bytes, receiveKey: Bytes) {
    this.send = aesKey(sendKey);
    this.receive = aesKey(receiveKey);
  }

  seal(plain: Bytes): Promise<Bytes> {
    const counter = this.sent++;
    return this.sealing.run(async () => seal(await this.send, counter, plain));
  }

  /** The plain bytes, or undefined (tampered, replayed or out of order: the counter does not move). */
  open(frame: Bytes): Promise<Bytes | undefined> {
    return this.opening.run(async () => {
      const plain = await open(await this.receive, this.received, frame);
      if (plain) this.received++;
      return plain;
    });
  }
}

/** Sender side of seal.ts toBox: a fresh ephemeral key `e` and the cipher towards the owner of `box`. */
export async function toBox(box: Uint8Array, info: string): Promise<{ e: string; cipher: CounterCipher }> {
  const eph = await newX25519();
  const okm = await hkdf(await x25519(eph.privateKey, box), concat(eph.pub, box), info, 64);
  return { e: b64url(eph.pub), cipher: new CounterCipher(okm.slice(0, 32), okm.slice(32, 64)) };
}

// ------------------------------------------------------------------ fingerprint and Remote ID

/** The device fingerprint: sha256 (hex) of the raw Ed25519 public key. */
export const fingerprint = async (pub: Uint8Array): Promise<string> => hex(await sha256(own(pub)));

export function luhnDigit(payload: string): string {
  let sum = 0;
  for (let index = 0; index < payload.length; index++) {
    let digit = Number(payload[payload.length - 1 - index]);
    if (index % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/** The 9-digit Remote ID of a fingerprint (remote/id.ts): 8 digits from a hash plus a Luhn check digit. */
export async function remoteIdOf(fp: string): Promise<string> {
  const digest = await sha256(utf8(`wf-remote-id-v1|${fp.toLowerCase()}`));
  const high = new DataView(digest.buffer).getUint32(0);
  const payload = String(high * 4 + (digest[4] & 3)).padStart(10, '0').slice(-8);
  return payload + luhnDigit(payload);
}

export const validRemoteId = (digits: string): boolean => /^\d{9}$/.test(digits) && luhnDigit(digits.slice(0, 8)) === digits[8];
