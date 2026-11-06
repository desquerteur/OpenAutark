// Tokens of people (F-52) in the one token store (`tokens`): invite tickets (kind 'person-invite',
// one open per person, 72 hours, one use – burned when a join request is made with it) and device
// tokens (kind 'person', one per joined phone/browser). The scope column holds {personId}; only
// the sha256 of a ticket or token is stored, the plain value is handed out once.
// Owns: issuing, checking, listing and revoking those rows. Never: logs or keeps plain tickets or
// tokens, issues anything for the owner, or touches the device tokens of the owner's phones.

import { randomBytes } from 'node:crypto';
import { newId } from '../../shared/ids.ts';
import type { PersonDevice } from '../../shared/model/people.ts';
import type { Clock } from '../contracts.ts';
import { json, toJson, type Db } from '../db/database.ts';
import { hashToken } from '../pwa/tokens.ts';

export const INVITE_TTL_MS = 72 * 60 * 60_000;
const INVITE = 'person-invite';
const DEVICE = 'person';

interface Row {
  id: string; device_id: string | null; kind: string; hash: string; scope: string; name: string | null;
  created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null;
}

const personOf = (row: Row): string => String(json<{ personId?: unknown }>(row.scope, {}).personId ?? '');
const plausible = (value: unknown): value is string => typeof value === 'string' && value.length >= 20 && value.length <= 200;

export class PersonTokens {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  /** A new invite ticket for `personId`; earlier open invites of that person end. */
  createInvite(personId: string): { ticket: string; expiresAt: number } {
    const now = this.clock.now();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + INVITE_TTL_MS;
    this.db.tx(() => {
      this.closeInvites(personId);
      this.db.run('INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at, expires_at) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?)',
        [newId('tok', now), INVITE, hashToken(ticket), toJson({ personId }), now, expiresAt]);
    });
    return { ticket, expiresAt };
  }

  /** Ends the open invites of a person; returns how many. */
  closeInvites(personId: string): number {
    return this.db.run(`UPDATE tokens SET revoked_at = ? WHERE kind = ? AND revoked_at IS NULL AND json_extract(scope, '$.personId') = ?`,
      [this.clock.now(), INVITE, personId]).changes;
  }

  /** The open invite's expiry, if a person has one. */
  openInvite(personId: string): number | undefined {
    const row = this.db.get<Row>(`SELECT * FROM tokens WHERE kind = ? AND revoked_at IS NULL AND expires_at > ? AND json_extract(scope, '$.personId') = ? ORDER BY created_at DESC LIMIT 1`,
      [INVITE, this.clock.now(), personId]);
    return row?.expires_at === null || row?.expires_at === undefined ? undefined : Number(row.expires_at);
  }

  /** Burns a live invite ticket (one use); returns its person, or undefined when it is unknown, used or expired. */
  redeemInvite(ticket: unknown): string | undefined {
    if (!plausible(ticket)) return undefined;
    const now = this.clock.now();
    return this.db.tx(() => {
      const row = this.db.get<Row>('SELECT * FROM tokens WHERE hash = ? AND kind = ?', [hashToken(ticket), INVITE]);
      if (!row || row.revoked_at !== null || (row.expires_at !== null && Number(row.expires_at) <= now)) return undefined;
      this.db.run('UPDATE tokens SET revoked_at = ?, last_used_at = ? WHERE id = ?', [now, now, row.id]);
      return personOf(row) || undefined;
    });
  }

  /** A device token for an accepted join (plain value once). */
  issue(personId: string, name: string): { token: string; tokenId: string; deviceId: string } {
    const now = this.clock.now();
    const token = randomBytes(32).toString('base64url');
    const tokenId = newId('tok', now);
    const deviceId = newId('dev', now);
    this.db.run('INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tokenId, deviceId, DEVICE, hashToken(token), toJson({ personId }), name.slice(0, 60), now]);
    return { token, tokenId, deviceId };
  }

  /** A presented token → its person and device (undefined = not a live person token). */
  authenticate(token: unknown): { personId: string; deviceId: string; tokenId: string } | undefined {
    if (!plausible(token)) return undefined;
    const row = this.db.get<Row>('SELECT * FROM tokens WHERE hash = ? AND kind = ?', [hashToken(token), DEVICE]);
    if (!row || row.revoked_at !== null || !row.device_id) return undefined;
    const personId = personOf(row);
    if (!personId) return undefined;
    this.db.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', [this.clock.now(), row.id]);
    return { personId, deviceId: row.device_id, tokenId: row.id };
  }

  /** True when the token is a person token that was revoked (the page shows "removed"). */
  isRevoked(token: unknown): boolean {
    if (!plausible(token)) return false;
    const row = this.db.get<Row>('SELECT revoked_at FROM tokens WHERE hash = ? AND kind = ?', [hashToken(token), DEVICE]);
    return Boolean(row && row.revoked_at !== null);
  }

  /** Still live: the token row of a connection (checked on every call of a person). */
  live(tokenId: string): boolean {
    return Boolean(this.db.get(`SELECT 1 FROM tokens WHERE id = ? AND kind = ? AND revoked_at IS NULL`, [tokenId, DEVICE]));
  }

  devices(personId: string): PersonDevice[] {
    return this.db.all<Row>(`SELECT * FROM tokens WHERE kind = ? AND revoked_at IS NULL AND json_extract(scope, '$.personId') = ? ORDER BY created_at`, [DEVICE, personId])
      .map((row) => ({
        id: String(row.device_id), name: row.name ?? 'Browser', createdAt: Number(row.created_at),
        ...(row.last_used_at !== null ? { lastSeenAt: Number(row.last_used_at) } : {}),
      }));
  }

  /** Revokes one device of a person; returns how many tokens ended. */
  revokeDevice(personId: string, deviceId: string): number {
    return this.db.run(`UPDATE tokens SET revoked_at = ? WHERE kind = ? AND device_id = ? AND revoked_at IS NULL AND json_extract(scope, '$.personId') = ?`,
      [this.clock.now(), DEVICE, deviceId, personId]).changes;
  }

  /** Every device token and invite of a person ends (revocation). */
  revokeAll(personId: string): number {
    return this.db.run(`UPDATE tokens SET revoked_at = ? WHERE kind IN (?, ?) AND revoked_at IS NULL AND json_extract(scope, '$.personId') = ?`,
      [this.clock.now(), DEVICE, INVITE, personId]).changes;
  }
}
