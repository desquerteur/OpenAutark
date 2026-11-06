// Access tokens for phone/browser clients: one-time pairing links (the QR code) and long-lived
// device tokens. Only the sha256 hash of a token is stored (`tokens` table); the plain value is
// shown once. A paired phone is the owner's: every device token carries FULL_ACCESS (one tier –
// older rows with a narrower `scope` are read as full too, except 'permissions': a token issued before B-078 keeps
// what it had, capabilitiesOf). B-078: FULL_ACCESS holds 'permissions' too – it counts only
// on a secure transport (rpc/table.ts), so the phone app's loopback tunnel reaches secrets and plans while a plain LAN
// browser stays without them. A phone paired by Remote ID gets its token directly (issueDevice). People's devices use
// people/tokens.ts.
// Owns: issuing, exchanging, authenticating (→ ClientScope), listing and revoking tokens.
// Never: logs or persists plain tokens, or grants owner scope.

import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { toJson } from '../db/database.ts';
import { newId } from '../../shared/ids.ts';
import type { ClientScope, DeviceCapability } from '../../shared/api/protocol.ts';

export type { DeviceCapability };
/** What a paired phone/browser may do: everything a device scope knows. */
export const FULL_ACCESS: DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'];

export const LINK_TTL_MS = 10 * 60_000;

/**
 * A token's capabilities as issued: a narrower older row reads as full (one tier), but 'permissions' (secrets, plans)
 * counts only when the row was issued with it (B-078 on) – a token from before keeps what it had then.
 */
export function capabilitiesOf(scope: string): DeviceCapability[] {
  let stored: unknown;
  try { stored = JSON.parse(scope); } catch { stored = []; }
  const withPermissions = Array.isArray(stored) && stored.includes('permissions');
  return FULL_ACCESS.filter((capability) => capability !== 'permissions' || withPermissions);
}

interface TokenRow {
  id: string;
  device_id: string | null;
  kind: string;
  hash: string;
  scope: string;
  name: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export class TokenService {
  private readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  /** One-time pairing secret for `pwa.link` (exchanged for a device token). */
  createLink(input: { name?: string } = {}): { secret: string; expiresAt: number } {
    const secret = newToken();
    const now = this.clock.now();
    const expiresAt = now + LINK_TTL_MS;
    this.db.run(
      'INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at, expires_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
      [newId('tok', now), 'pwa-link', hashToken(secret), toJson(FULL_ACCESS), input.name ?? null, now, expiresAt],
    );
    return { secret, expiresAt };
  }

  /** Consumes a pairing secret; returns the new device token (plain, shown once). */
  exchange(secret: string, deviceId: string, name?: string): { token: string; name?: string } | undefined {
    return this.exchangeHash(hashToken(secret), deviceId, name);
  }

  /** The same by the link's hash (B-075: the 6-digit code beside the QR stands for it, pwa/pair-code.ts). */
  exchangeHash(hash: string, deviceId: string, name?: string): { token: string; name?: string } | undefined {
    const now = this.clock.now();
    return this.db.tx(() => {
      const row = this.db.get<TokenRow>(`SELECT * FROM tokens WHERE hash = ? AND kind = 'pwa-link'`, [hash]);
      if (!row || row.revoked_at !== null || (row.expires_at !== null && Number(row.expires_at) <= now)) return undefined;
      // One-time: burn the link before issuing anything.
      this.db.run('UPDATE tokens SET revoked_at = ?, last_used_at = ? WHERE id = ?', [now, now, row.id]);
      const token = newToken();
      // The name the person gave the link wins; the browser's own guess ("Android · Chrome") is the fallback.
      const chosen = row.name ?? name;
      this.db.run(
        'INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newId('tok', now), deviceId, 'device', hashToken(token), toJson(FULL_ACCESS), chosen ?? null, now],
      );
      return { token, name: chosen ?? undefined };
    });
  }

  /** A new device token for a device accepted on this PC (a phone paired by Remote ID and code); plain, shown once. */
  issueDevice(deviceId: string, name?: string): string {
    const now = this.clock.now();
    const token = newToken();
    this.db.run(
      'INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId('tok', now), deviceId, 'device', hashToken(token), toJson(FULL_ACCESS), name ?? null, now],
    );
    return token;
  }

  /** True when `token` is a device token that was revoked (the phone/browser was removed). */
  isRevoked(token: string): boolean {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
    const row = this.db.get<TokenRow>(`SELECT * FROM tokens WHERE hash = ? AND kind = 'device'`, [hashToken(token)]);
    return Boolean(row && row.revoked_at !== null);
  }

  /** Maps a presented device token to its scope (undefined = reject). The transport adds `secure`. */
  authenticate(token: string): ClientScope | undefined {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return undefined;
    const row = this.db.get<TokenRow>(`SELECT * FROM tokens WHERE hash = ? AND kind = 'device'`, [hashToken(token)]);
    const now = this.clock.now();
    if (!row || !row.device_id || row.revoked_at !== null || (row.expires_at !== null && Number(row.expires_at) <= now)) return undefined;
    this.db.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', [now, row.id]);
    return { kind: 'device', deviceId: row.device_id, capabilities: capabilitiesOf(row.scope) };
  }

  /** Device ids whose active tokens were all issued before B-078 (their scope lacks 'permissions'). */
  olderDevices(): string[] {
    const rows = this.db.all<TokenRow>(`SELECT * FROM tokens WHERE kind = 'device' AND revoked_at IS NULL AND device_id IS NOT NULL`);
    const newer = new Set(rows.filter((row) => capabilitiesOf(row.scope).includes('permissions')).map((row) => row.device_id!));
    return [...new Set(rows.map((row) => row.device_id!))].filter((id) => !newer.has(id));
  }

  revokeDevice(deviceId: string): number {
    return this.db.run('UPDATE tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', [this.clock.now(), deviceId]).changes;
  }

  /** Active device tokens (one entry per device). */
  devices(): Array<{ deviceId: string; name?: string; createdAt: number; lastUsedAt?: number }> {
    return this.db
      .all<TokenRow>(`SELECT * FROM tokens WHERE kind = 'device' AND revoked_at IS NULL AND device_id IS NOT NULL ORDER BY created_at`)
      .map((row) => ({
        deviceId: row.device_id!, name: row.name ?? undefined, createdAt: Number(row.created_at),
        lastUsedAt: row.last_used_at === null ? undefined : Number(row.last_used_at),
      }));
  }
}
