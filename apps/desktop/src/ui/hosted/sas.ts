// The connect request's math for the iPhone web app (B-078 follow-up), exactly as runtime/remote/sas.ts and
// devices/pair-proof.ts (and Android's RemotePair.java): stable JSON, the length-prefixed hash, the PC's commitment, the
// transcript, the 4-digit code both screens show, the signed forms and the session-key MACs. The shared vectors of
// android/test/RemotePairTest.java and test/unit/hosted/crypto.test.ts keep the three implementations equal.
// Owns: these pure values. Never: sockets, storage or trust decisions.

import { b64url, concat, same, utf8, type Bytes } from './bytes.ts';
import { hkdf, hmac, sha256, x25519 } from './crypto.ts';

/** pair-proof.ts stable(): sorted keys, JSON.stringify for every leaf. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/** sha256 over length-prefixed parts ("<length>:" + bytes each). */
export async function lpHash(...parts: Array<string | Uint8Array>): Promise<Bytes> {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const bytes = typeof part === 'string' ? utf8(part) : part;
    chunks.push(utf8(`${bytes.length}:`), bytes);
  }
  return sha256(concat(...chunks));
}

export interface PeerInfo { id: string; name: string; role: string; pub: string; addresses: string[] }

export const commitment = async (ephA: Uint8Array, ephB: Uint8Array, na: Uint8Array): Promise<string> =>
  b64url(await lpHash('wf-remote-v1 commit', ephA, ephB, na));

export const transcript = (a: unknown, b: unknown, ephA: Uint8Array, ephB: Uint8Array, commit: string, role: string): Promise<Bytes> =>
  lpHash('wf-remote-v1 transcript', stable(a), stable(b), ephA, ephB, commit, role);

/** The 4-digit match code both people compare. */
export async function matchCode(t: Uint8Array, na: Uint8Array, nb: Uint8Array): Promise<string> {
  const h = await lpHash('wf-remote-v1 code', t, na, nb);
  return String(new DataView(h.buffer).getUint32(0) % 10_000).padStart(4, '0');
}

/** The signed form for side 'A' (the PC) or 'B' (this phone). */
export const signedBytes = (side: 'A' | 'B', t: Uint8Array): Bytes => concat(utf8(`wf-remote-v1 ${side}|`), t);

/** The key that MACs the request's later messages (X25519 of the two ephemeral keys, salted with T). */
export async function sessionKey(own: CryptoKey, peerEph: Uint8Array, t: Bytes): Promise<Bytes> {
  return hkdf(await x25519(own, peerEph), t, 'wf-remote-v1 key', 32);
}

export async function mac(key: Bytes, label: string, ...parts: unknown[]): Promise<string> {
  return b64url(await hmac(key, utf8(`wf-pair-v1|${label}|${parts.map(stable).join('|')}`)));
}

export function macOk(expected: string, given: unknown): boolean {
  return typeof given === 'string' && same(utf8(expected), utf8(given));
}
