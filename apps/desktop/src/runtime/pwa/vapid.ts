// VAPID (RFC 8292) application server keys and the signed JWT for push requests.
// Owns: generating/loading the P-256 key pair (private key encrypted with the host keychain,
// stored in kv) and building `Authorization: vapid t=…, k=…`. Never: sends anything.

import { createECDH, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { Clock } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Host } from '../host.ts';
import { KvRepo } from '../store/kv.ts';

/** Contact for push services (RFC 8292 `sub`); the public project page, not personal data. */
export const VAPID_SUBJECT = 'https://github.com/teydra/OpenAutark';

interface StoredVapid {
  publicKey: string; // base64url, 65-byte uncompressed point
  privateCipher: string; // base64 of host.encrypt(raw private scalar base64url)
}

function b64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

/** P-256 KeyObject from raw private scalar + public point (via JWK). */
function privateKeyObject(rawPrivate: Buffer, publicPoint: Buffer): KeyObject {
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(rawPrivate), x: b64url(publicPoint.subarray(1, 33)), y: b64url(publicPoint.subarray(33, 65)) },
    format: 'jwk',
  });
}

export class VapidKeys {
  readonly publicKey: string; // base64url (what PushManager.subscribe needs as applicationServerKey)
  private readonly key: KeyObject;

  private constructor(publicKey: string, key: KeyObject) {
    this.publicKey = publicKey;
    this.key = key;
  }

  static async load(input: { db: Db; host: Host; clock: Clock }): Promise<VapidKeys> {
    const kv = new KvRepo(input.db);
    const stored = kv.get<StoredVapid>('pwa', 'vapid');
    if (stored) {
      const raw = Buffer.from(await input.host.decrypt(Buffer.from(stored.privateCipher, 'base64')), 'base64url');
      return new VapidKeys(stored.publicKey, privateKeyObject(raw, Buffer.from(stored.publicKey, 'base64url')));
    }
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const rawPrivate = ecdh.getPrivateKey();
    const publicPoint = ecdh.getPublicKey();
    const cipher = await input.host.encrypt(b64url(rawPrivate));
    kv.set('pwa', 'vapid', { publicKey: b64url(publicPoint), privateCipher: Buffer.from(cipher).toString('base64') } satisfies StoredVapid, input.clock.now());
    return new VapidKeys(b64url(publicPoint), privateKeyObject(rawPrivate, publicPoint));
  }

  /** `Authorization` header value for a push endpoint (JWT ES256, valid 12 h). */
  authorization(endpoint: string, nowMs: number): string {
    const audience = new URL(endpoint).origin;
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${this.publicKey}`;
  }
}
