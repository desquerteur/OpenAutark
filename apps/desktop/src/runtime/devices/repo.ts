// Repository for the `devices` table (this PC, linked PCs, phones and PWA browsers).
// Owns: SQL and row mapping for devices, including the stored raw public key and the link's role, kept in
// the JSON column `allow` of migration 6 as {personId?, joinedAs?}: `personId` for a linked PC that joined
// this one as an employee, `joinedAs` on the PC that joined the other one (devices/sync reads both).
// Never: crypto, networking or pairing decisions.

import { bool, int, json, toJson, type Db } from '../db/database.ts';
import type { Device, DeviceCaps, DeviceKind, DeviceRole } from '../../shared/model/devices.ts';

export interface DeviceRecord extends Device {
  publicKey?: string; // raw Ed25519 public key, base64url (never sent to the UI)
  /** This PC joined that PC – as its CEO (everything the same) or as an employee there (devices/sync/home.ts). */
  joinedAs?: 'ceo' | 'employee';
}

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  role: string;
  fingerprint: string;
  public_key: string | null;
  addresses: string;
  caps: string;
  status: string;
  self: number;
  paired_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  allow?: string; // migration 6: {personId?} of an employee's PC
}

function toRecord(row: DeviceRow): DeviceRecord {
  const record: DeviceRecord = {
    id: row.id,
    name: row.name,
    kind: row.kind as DeviceKind,
    role: row.role as DeviceRole,
    fingerprint: row.fingerprint,
    addresses: json<string[]>(row.addresses, []),
    caps: json<DeviceCaps>(row.caps, {}),
    status: row.status as Device['status'],
    self: bool(row.self),
  };
  if (row.public_key) record.publicKey = row.public_key;
  if (row.paired_at !== null) record.pairedAt = Number(row.paired_at);
  if (row.last_seen_at !== null) record.lastSeenAt = Number(row.last_seen_at);
  if (row.revoked_at !== null) record.revokedAt = Number(row.revoked_at);
  const extra = json<{ personId?: unknown; joinedAs?: unknown }>(row.allow ?? '{}', {});
  if (record.kind === 'pc' && !record.self && typeof extra.personId === 'string' && extra.personId) record.personId = extra.personId;
  if (record.kind === 'pc' && !record.self && (extra.joinedAs === 'ceo' || extra.joinedAs === 'employee')) record.joinedAs = extra.joinedAs;
  return record;
}

/** Strips the key (and the link's role) so the object can be sent to clients. */
export function publicDevice(record: DeviceRecord): Device {
  const { publicKey: _key, joinedAs: _role, ...device } = record;
  return device;
}

export class DevicesRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: string): DeviceRecord | undefined {
    const row = this.db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
    return row ? toRecord(row) : undefined;
  }

  self(): DeviceRecord | undefined {
    const row = this.db.get<DeviceRow>('SELECT * FROM devices WHERE self = 1 LIMIT 1');
    return row ? toRecord(row) : undefined;
  }

  byFingerprint(fingerprint: string): DeviceRecord | undefined {
    const row = this.db.get<DeviceRow>('SELECT * FROM devices WHERE fingerprint = ? AND revoked_at IS NULL', [fingerprint]);
    return row ? toRecord(row) : undefined;
  }

  list(options: { includeRevoked?: boolean; kinds?: DeviceKind[] } = {}): DeviceRecord[] {
    const rows = this.db.all<DeviceRow>(
      options.includeRevoked ? 'SELECT * FROM devices ORDER BY self DESC, name' : 'SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY self DESC, name',
    );
    const records = rows.map(toRecord);
    return options.kinds ? records.filter((record) => options.kinds!.includes(record.kind)) : records;
  }

  upsert(record: DeviceRecord): DeviceRecord {
    this.db.run(
      `INSERT INTO devices (id, name, kind, role, fingerprint, public_key, addresses, caps, status, self, paired_at, last_seen_at, revoked_at, allow)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, role = excluded.role,
         fingerprint = excluded.fingerprint, public_key = excluded.public_key, addresses = excluded.addresses,
         caps = excluded.caps, status = excluded.status, self = excluded.self, paired_at = excluded.paired_at,
         last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at, allow = excluded.allow`,
      [
        record.id, record.name, record.kind, record.role, record.fingerprint, record.publicKey ?? null,
        toJson(record.addresses), toJson(record.caps), record.status, int(record.self),
        record.pairedAt ?? null, record.lastSeenAt ?? null, record.revokedAt ?? null,
        toJson({ ...(record.personId ? { personId: record.personId } : {}), ...(record.joinedAs ? { joinedAs: record.joinedAs } : {}) }),
      ],
    );
    return this.get(record.id)!;
  }

  patch(id: string, patch: Partial<Omit<DeviceRecord, 'id'>>): DeviceRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    return this.upsert({ ...current, ...patch, id });
  }
}
