// Web pushes that reach the phones of all my devices (D3, owner 06.11.2026: "das Handy mit der Firma connecten"): the
// roster (roster.ts) hands this PC every push subscription my other PCs hold, each with the VAPID key it was made under
// – a push service takes a push only when it is signed with that key – so the PC that decides a notification pushes to
// every phone itself, under the same tag everywhere (the service worker replaces a duplicate within its origin).
// Storage: kv ns 'sync.roster' – 'subs' (the subscriptions held from my other PCs) and 'keys' (their VAPID keys, the
// private part sealed with this PC's keychain). This PC's own subscriptions stay in push_subscriptions (pwa/push.ts).
// Owns: the held subscriptions and keys, this PC's own key and subscriptions as the roster carries them, signing and
// sending to a list of subscriptions. Never: logs a payload or a key, or decides who gets what (callers pick targets).

import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { RuntimeServices } from '../../contracts.ts';
import { json, type Db } from '../../db/database.ts';
import { KvRepo } from '../../store/kv.ts';
import type { PushSubscriptionData } from '../../pwa/push.ts';
import { VAPID_SUBJECT } from '../../pwa/vapid.ts';
import { encryptPayload } from '../../pwa/webpush-crypto.ts';

/** One subscription as the roster carries it: `key` is the VAPID public key it was made under; `person`: a person's device. */
export interface HeldSub { endpoint: string; data: PushSubscriptionData; deviceId?: string; key: string; person?: string }
/** A VAPID key pair: `priv` is the raw P-256 scalar, base64url (only ever inside the sealed link between my PCs). */
export interface KeyPair { pub: string; priv: string }

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ ok: boolean; status: number }>;
type Services = Pick<RuntimeServices, 'db' | 'host' | 'clock' | 'log'>;

const NS = 'sync.roster';
const b64 = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');

export function heldSubs(db: Db): HeldSub[] {
  return new KvRepo(db).get<HeldSub[]>(NS, 'subs') ?? [];
}

export function keepSubs(db: Db, subs: HeldSub[], now: number): void {
  new KvRepo(db).set(NS, 'subs', subs, now);
}

/** This PC's own VAPID key (none before the first phone subscribed). */
export async function ownKey(s: Pick<Services, 'db' | 'host'>): Promise<KeyPair | undefined> {
  const stored = new KvRepo(s.db).get<{ publicKey: string; privateCipher: string }>('pwa', 'vapid');
  if (!stored) return undefined;
  try { return { pub: stored.publicKey, priv: await s.host.decrypt(Buffer.from(stored.privateCipher, 'base64')) }; } catch { return undefined; }
}

/** The VAPID keys held from my other PCs, by public key. */
export async function heldKeys(s: Pick<Services, 'db' | 'host'>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of new KvRepo(s.db).get<Array<{ pub: string; cipher: string }>>(NS, 'keys') ?? []) {
    try { out.set(entry.pub, await s.host.decrypt(Buffer.from(entry.cipher, 'base64'))); } catch { /* sealed by another keychain: gone */ }
  }
  return out;
}

/** Stores keys from my other PCs (never this PC's own); returns whether one was new. */
export async function keepKeys(s: Pick<Services, 'db' | 'host' | 'clock'>, keys: KeyPair[], own: string | undefined): Promise<boolean> {
  const kv = new KvRepo(s.db);
  const stored = kv.get<Array<{ pub: string; cipher: string }>>(NS, 'keys') ?? [];
  const fresh = keys.filter((key) => key.pub !== own && !stored.some((entry) => entry.pub === key.pub));
  if (!fresh.length) return false;
  for (const key of fresh) stored.push({ pub: key.pub, cipher: Buffer.from(await s.host.encrypt(key.priv)).toString('base64') });
  kv.set(NS, 'keys', stored, s.clock.now());
  return true;
}

const LIVE_DEVICE_TOKEN = `EXISTS (SELECT 1 FROM tokens t WHERE t.device_id = p.device_id AND t.kind = 'device' AND t.revoked_at IS NULL
  AND (t.expires_at IS NULL OR t.expires_at > ?))`;

/**
 * This PC's own subscriptions (push_subscriptions) under its key, by the rule pwa/push.ts sends by: the owner's own (no
 * device) and those of a device with a live device token; a person's device (any person token, revoked or not) only
 * while its person token lives, and then it carries its person. A removed or expired device's subscription stays out.
 */
export function localSubs(db: Db, key: string, now: number): HeldSub[] {
  return db.all<{ endpoint: string; data: string; device_id: string | null; person: string | null; personal: number; owner: number }>(
    `SELECT p.endpoint, p.data, p.device_id,
       (SELECT json_extract(t.scope, '$.personId') FROM tokens t WHERE t.device_id = p.device_id AND t.kind = 'person' AND t.revoked_at IS NULL LIMIT 1) AS person,
       EXISTS (SELECT 1 FROM tokens t WHERE t.device_id = p.device_id AND t.kind = 'person') AS personal,
       (p.device_id IS NULL OR ${LIVE_DEVICE_TOKEN}) AS owner
     FROM push_subscriptions p`,
    [now],
  ).flatMap((row) => {
    const data = json<PushSubscriptionData | undefined>(row.data, undefined);
    if (!data || (Number(row.personal) ? !row.person : !Number(row.owner))) return [];
    return [{ endpoint: row.endpoint, data, key, ...(row.device_id ? { deviceId: row.device_id } : {}), ...(row.person ? { person: String(row.person) } : {}) }];
  });
}

/**
 * The owner's targets among held subscriptions: no person, and either no device or a device with a live device token
 * here (the roster carries the token hashes, so a removed or expired phone is not the owner's on this PC either).
 */
export function ownerHeld(db: Db, subs: HeldSub[], now: number): HeldSub[] {
  const live = new Set(db.all<{ device_id: string }>(
    `SELECT DISTINCT t.device_id FROM tokens t WHERE t.kind = 'device' AND t.device_id IS NOT NULL AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > ?)`, [now],
  ).map((row) => row.device_id));
  const personal = new Set(db.all<{ device_id: string }>("SELECT DISTINCT device_id FROM tokens WHERE kind = 'person' AND device_id IS NOT NULL").map((row) => row.device_id));
  return subs.filter((sub) => !sub.person && (!sub.deviceId || (live.has(sub.deviceId) && !personal.has(sub.deviceId))));
}

function keyObject(pair: KeyPair): KeyObject {
  const point = Buffer.from(pair.pub, 'base64url');
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: pair.priv, x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) }, format: 'jwk' });
}

/** `Authorization: vapid …` for one endpoint under one key (RFC 8292, valid 12 h). */
export function vapidHeader(endpoint: string, now: number, pair: KeyPair): string {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: keyObject(pair), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${pair.pub}`;
}

/**
 * Sends `payload` to each target under its own key (a target whose key this PC does not hold is skipped); a held
 * subscription the push service no longer knows (404/410) leaves the held list. Returns how many were delivered.
 */
export async function pushTo(s: Services, targets: HeldSub[], payload: unknown, options: { urgent?: boolean; fetch?: PushFetch } = {}): Promise<number> {
  if (!targets.length) return 0;
  const keys = await heldKeys(s);
  const own = await ownKey(s);
  if (own) keys.set(own.pub, own.priv);
  const send = options.fetch ?? (globalThis.fetch as unknown as PushFetch);
  const body = Buffer.from(JSON.stringify(payload));
  const gone: string[] = [];
  let delivered = 0;
  await Promise.all(targets.map(async (target) => {
    const priv = keys.get(target.key);
    if (!priv) return;
    try {
      const response = await send(target.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: options.urgent ? 'high' : 'normal',
          Authorization: vapidHeader(target.endpoint, s.clock.now(), { pub: target.key, priv }),
        },
        body: encryptPayload(body, Buffer.from(target.data.keys.p256dh, 'base64url'), Buffer.from(target.data.keys.auth, 'base64url')),
      });
      if (response.status === 404 || response.status === 410) gone.push(target.endpoint);
      else if (response.ok) delivered++;
      else s.log.debug('held push rejected', { status: response.status });
    } catch (error) {
      s.log.debug('held push failed', { error: String((error as Error)?.message ?? error) });
    }
  }));
  if (gone.length) keepSubs(s.db, heldSubs(s.db).filter((sub) => !gone.includes(sub.endpoint)), s.clock.now());
  return delivered;
}
