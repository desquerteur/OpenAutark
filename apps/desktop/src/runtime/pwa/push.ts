// Web Push sender: stores browser subscriptions (`push_subscriptions`) and delivers small
// encrypted notifications through the browser vendor's push service (no own cloud).
// It is one channel of the NotificationService (the notification module decides *when*).
// Who receives a message is decided per subscription at send time: the owner's (no device id) and
// every paired phone/browser with a live device token get everything (one tier); a subscription
// whose device has no active token gets nothing.
// F-52: a person's device (person token) never gets the owner's messages; sendToPerson reaches only
// that person's live devices (pwa/person-push.ts decides when). A person's subscription must point at a
// browser vendor's push service (isPushServiceEndpoint – never a LAN or other host) and a device keeps
// at most PERSON_SUBSCRIPTIONS_PER_DEVICE of them (subscribeKeeping replaces the oldest).
// The id travels in the payload; ui/pwa/sw.ts deduplicates within one origin, not between subscriptions to different PCs.
// Owns: subscription validation/storage, recipients, request building, cleanup of gone subscriptions.
// Never: sends secrets or message bodies beyond the short title/body it is given.

import type { Clock, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { json, toJson } from '../db/database.ts';
import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { VapidKeys } from './vapid.ts';
import { encryptPayload } from './webpush-crypto.ts';

/** The part of fetch used for delivery (tests pass a fake). */
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ ok: boolean; status: number }>;

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  kind: 'todo' | 'blocker' | 'important' | 'done' | 'reply' | 'info';
  title: string;
  body: string;
  conversationId?: string;
  taskId?: string;
  /** The notification's id (notify/service.ts), the same on each of the owner's PCs that pushes it. */
  id?: string;
}

/**
 * Where a notification leads and what it replaces (DEV5A): a tap opens the chat (`#/chat/<id>`) – else a
 * to-do or blocker opens My day (`#/day`, B-041; always for a recipient without chat access – `chat:
 * false`) and anything else Home (`#/home`); the tag makes a newer notification for the same to-do or chat
 * replace the older one on the phone.
 */
export function pushTarget(message: Pick<PushMessage, 'kind' | 'conversationId' | 'taskId'>, options: { chat?: boolean } = {}): { url: string; tag: string } {
  const own = message.kind === 'todo' || message.kind === 'blocker' ? '/#/day' : '/#/home';
  const url = message.conversationId && options.chat !== false ? `/#/chat/${encodeURIComponent(message.conversationId)}` : own;
  const tag = message.taskId ? `todo:${message.taskId}` : message.conversationId ? `chat:${message.conversationId}` : `workforce:${message.kind}`;
  return { url, tag };
}

export function parseSubscription(value: unknown): PushSubscriptionData {
  const sub = value as Partial<PushSubscriptionData>;
  let url: URL;
  try { url = new URL(String(sub?.endpoint ?? '')); } catch { throw new WorkforceError('bad_request', 'Invalid push subscription.'); }
  const p256dh = Buffer.from(String(sub?.keys?.p256dh ?? ''), 'base64url');
  const auth = Buffer.from(String(sub?.keys?.auth ?? ''), 'base64url');
  if (url.protocol !== 'https:' || String(sub.endpoint).length > 2000 || p256dh.length !== 65 || auth.length !== 16) {
    throw new WorkforceError('bad_request', 'Invalid push subscription.');
  }
  return { endpoint: url.toString(), keys: { p256dh: sub.keys!.p256dh!, auth: sub.keys!.auth! } };
}

/** The push services of Chrome/Edge/Opera/Brave (FCM), Firefox, Safari and Windows (WNS). */
const PUSH_HOSTS: ReadonlySet<string> = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];
export const PERSON_SUBSCRIPTIONS_PER_DEVICE = 3;

/** F-52: an https endpoint of a known browser push service on its default port, without credentials. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

interface SubscriptionRow { id: string; endpoint: string; data: string; device_id: string | null; scope: string | null }

/** Kinds pushed with Urgency high (the push service delivers them at once, also to a dozing phone). */
const URGENT: ReadonlySet<PushMessage['kind']> = new Set<PushMessage['kind']>(['important', 'todo', 'blocker']);

/** The owner's subscriptions here: the owner's own and those of devices with a live device token (never people's). */
export function ownerSubscriptions(db: Db, now: number): number {
  return Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM push_subscriptions p WHERE p.device_id IS NULL OR EXISTS (SELECT 1 FROM tokens t WHERE t.device_id = p.device_id
       AND t.kind = 'device' AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?))`, [now],
  )?.n ?? 0);
}

export class PushService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly vapid: () => Promise<VapidKeys>;
  private readonly fetch: FetchFn;

  constructor(deps: { db: Db; clock: Clock; log: Logger; vapid: () => Promise<VapidKeys>; fetch?: FetchFn }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.log = deps.log;
    this.vapid = deps.vapid;
    this.fetch = deps.fetch ?? (globalThis.fetch as unknown as FetchFn);
  }

  subscribe(subscription: unknown, deviceId?: string): void {
    const sub = parseSubscription(subscription);
    this.db.run(
      `INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, data = excluded.data`,
      [newId('tok', this.clock.now()), deviceId ?? null, sub.endpoint, toJson(sub), this.clock.now()],
    );
  }

  /** F-52: stores a device's subscription and keeps only its `keep` newest ones (the oldest go). */
  subscribeKeeping(subscription: unknown, deviceId: string, keep: number): void {
    this.subscribe(subscription, deviceId);
    // A browser subscribing again with the same endpoint is the newest one, not one to drop.
    this.db.run('UPDATE push_subscriptions SET created_at = ? WHERE endpoint = ?', [this.clock.now(), parseSubscription(subscription).endpoint]);
    this.db.run(
      `DELETE FROM push_subscriptions WHERE device_id = ? AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE device_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      [deviceId, deviceId, Math.max(1, keep)],
    );
  }

  removeDevice(deviceId: string): void {
    this.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', [deviceId]);
  }

  /**
   * Removes the caller's own subscription(s): a phone's rows by its device id (optionally just one
   * endpoint); the owner's (no device id) only by endpoint. Never touches another device's rows.
   */
  unsubscribe(deviceId: string | undefined, endpoint?: string): number {
    if (deviceId) {
      return endpoint
        ? this.db.run('DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?', [deviceId, endpoint]).changes
        : this.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', [deviceId]).changes;
    }
    return endpoint ? this.db.run('DELETE FROM push_subscriptions WHERE device_id IS NULL AND endpoint = ?', [endpoint]).changes : 0;
  }

  /** Device ids with at least one stored subscription (per-device notification state for the owner). */
  subscribedDevices(): Set<string> {
    return new Set(this.db.all<{ device_id: string }>('SELECT DISTINCT device_id FROM push_subscriptions WHERE device_id IS NOT NULL').map((row) => row.device_id));
  }

  /** True when the caller (a device, or the owner by endpoint) has a stored subscription. */
  isSubscribed(deviceId: string | undefined, endpoint?: string): boolean {
    if (endpoint) return Boolean(this.db.get('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ? AND device_id IS ?', [endpoint, deviceId ?? null]));
    return deviceId ? this.subscribedDevices().has(deviceId) : false;
  }

  /** The VAPID public key (base64url) a browser subscribes with; created on first use. */
  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions')?.n ?? 0);
  }

  /** Subscriptions that may carry the owner's alerts: the owner's own and those of devices with a live device token (never people's). */
  ownerCount(): number {
    return ownerSubscriptions(this.db, this.clock.now());
  }

  /**
   * Sends to the owner's subscriptions and those of live device tokens; gone ones (404/410)
   * are deleted. `silent`: the owner's Sound off (global or the chat's) – shown without sound or
   * vibration. Returns delivered count.
   */
  async send(message: PushMessage, options: { silent?: boolean } = {}): Promise<number> {
    const targets = this.db.all<SubscriptionRow>(
      `SELECT p.id, p.endpoint, p.data, p.device_id,
         (SELECT t.scope FROM tokens t WHERE t.device_id = p.device_id AND t.kind = 'device' AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > ?) ORDER BY t.created_at DESC LIMIT 1) AS scope
       FROM push_subscriptions p`,
      [this.clock.now()],
    ).flatMap((row) => (row.device_id === null || row.scope !== null ? [{ row, chat: true }] : []));
    return this.post(targets, message, options.silent === true);
  }

  /**
   * F-52 (pwa/person-push.ts decides when): sends to the subscriptions of one person's devices that still
   * hold a live person token – never to the owner's or anyone else's. Returns delivered count.
   */
  async sendToPerson(personId: string, message: PushMessage, options: { silent?: boolean } = {}): Promise<number> {
    const rows = this.db.all<SubscriptionRow>(
      `SELECT p.id, p.endpoint, p.data, p.device_id, NULL AS scope FROM push_subscriptions p
       WHERE p.device_id IS NOT NULL AND EXISTS (SELECT 1 FROM tokens t WHERE t.device_id = p.device_id AND t.kind = 'person'
         AND t.revoked_at IS NULL AND json_extract(t.scope, '$.personId') = ?)`,
      [personId],
    );
    return this.post(rows.map((row) => ({ row, chat: true })), message, options.silent === true);
  }

  /**
   * `silent` (Sound off) makes the service worker show it without sound or vibration. B-050 K4: what the
   * person must see soon (an important message, a to-do, a blocker) goes with Urgency high.
   */
  private async post(targets: Array<{ row: SubscriptionRow; chat: boolean }>, message: PushMessage, silent = false): Promise<number> {
    if (!targets.length) return 0;
    const vapid = await this.vapid();
    const payload = (chat: boolean) => Buffer.from(JSON.stringify({
      kind: message.kind, title: message.title.slice(0, 120), body: message.body.slice(0, 240),
      conversationId: message.conversationId, taskId: message.taskId, id: message.id, ...pushTarget(message, { chat }), ...(silent ? { silent: true } : {}),
    }));
    let delivered = 0;
    await Promise.all(targets.map(async ({ row, chat }) => {
      const sub = json<PushSubscriptionData | undefined>(row.data, undefined);
      if (!sub) return;
      try {
        const body = encryptPayload(payload(chat), Buffer.from(sub.keys.p256dh, 'base64url'), Buffer.from(sub.keys.auth, 'base64url'));
        const response = await this.fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: URGENT.has(message.kind) ? 'high' : 'normal',
            Authorization: vapid.authorization(sub.endpoint, this.clock.now()),
          },
          body,
        });
        if (response.status === 404 || response.status === 410) this.db.run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
        else if (response.ok) delivered++;
        else this.log.warn('push rejected', { status: response.status });
      } catch (error) {
        this.log.warn('push failed', { error: String((error as Error)?.message ?? error) });
      }
    }));
    return delivered;
  }
}
