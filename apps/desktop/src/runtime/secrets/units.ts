// A catalog entry as one unit with its values (owner 04.11.2026): a single secret or a whole group (a login, a card) –
// its metadata and each value decrypted at the moment it is read, a 2FA key as its otpauth link (what the vault takes
// again). The device sync (devices/sync/secrets.ts, between the CEO's own PCs) and the export (export.ts) read units;
// catalogUnits names the entries an export or a delete works on when none are named: every single secret and group,
// of one route when given, but not what the app keeps for itself – createdBy SYSTEM_ID (Settings › Secrets hides it too)
// or an id the app's own features hold (heldByApp: an account's API key, a chat bridge's token, a calendar's or a
// connected app's sign-in, the feedback keys), so "delete all passwords" leaves the company working.
// Owns: reading a unit and that choice. Never: logs or keeps a value; hands one to anything but its caller.

import type { RuntimeServices } from '../contracts.ts';
import { json, type Db } from '../db/database.ts';
import { SYSTEM_ID } from '../../shared/ids.ts';
import type { SecretInfo } from '../../shared/model/security.ts';
import { fieldRows, groupRow, type SecretRow } from './groups.ts';
import { readTotp, toOtpauth } from './totp.ts';

export interface UnitField { id: string; field: string; kind: SecretInfo['kind']; value?: string }

export interface SecretUnit {
  group: boolean; label: string; kind: string; description: string; source?: string; route?: string; tags: string[];
  /** A single secret's value. */
  value?: string;
  /** A group's fields with their values. */
  fields?: UnitField[];
}

export type Decrypt = (cipher: Uint8Array) => Promise<string>;

/** The value as the vault takes it again: a 2FA key as its otpauth link (undefined when nothing is stored). */
export async function unitValue(decrypt: Decrypt, row: SecretRow): Promise<string | undefined> {
  if (!row.cipher) return undefined;
  const plain = await decrypt(row.cipher);
  return row.kind === 'totp' ? toOtpauth(readTotp(plain)) : plain;
}

/** The unit stored under `id` (a group or a single secret; a grouped field's id is no unit); throws when a value cannot be decrypted. */
export async function readUnit(db: Db, decrypt: Decrypt, id: string): Promise<SecretUnit | undefined> {
  const meta = (row: { description?: string | null; source?: string | null; route?: string | null; tags?: string | null }) => ({
    description: row.description ?? '', ...(row.source ? { source: row.source } : {}), ...(row.route ? { route: row.route } : {}), tags: json<string[]>(row.tags ?? '[]', []),
  });
  const group = groupRow(db, id);
  if (group) {
    const fields = await Promise.all(fieldRows(db, id).map(async (row) => ({ id: row.id, field: row.field ?? '', kind: row.kind as SecretInfo['kind'], value: await unitValue(decrypt, row) })));
    return { group: true, label: group.label, kind: group.kind, ...meta(group), fields };
  }
  const row = db.get<SecretRow>('SELECT * FROM secrets WHERE id = ? AND group_id IS NULL', [id]);
  return row ? { group: false, label: row.label, kind: row.kind, ...meta(row), value: await unitValue(decrypt, row) } : undefined;
}

/** One entry of the catalog as a unit: its id, name and route (the vault's, chosen automatically when none is stored). */
export interface CatalogUnit { id: string; name: string; route: string; group: boolean }

/** The feedback inbox's keys (feedback/inbox.ts RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID). */
export const FEEDBACK_SECRET_IDS = ['feedback-receiver-key', 'feedback-service-account'] as const;

type Held = Pick<RuntimeServices, 'db'> & { settings?: Pick<RuntimeServices['settings'], 'get'> };

/**
 * The vault ids the app's own features hold – their working credentials: an account's API key, a chat bridge's token, a
 * calendar's sign-in (their secret_id columns), a connected app's sign-in and registration (kv 'apps', oauth:…),
 * Settings › Calendar's Google client secret and the feedback keys.
 */
export function heldByApp(services: Held): Set<string> {
  const held = new Set<string>(FEEDBACK_SECRET_IDS);
  const add = (id: unknown) => { if (typeof id === 'string' && id) held.add(id); };
  for (const table of ['accounts', 'bridges', 'calendar_sources']) {
    for (const row of services.db.all<{ id: string | null }>(`SELECT secret_id AS id FROM ${table}`)) add(row.id);
  }
  for (const row of services.db.all<{ value: string }>("SELECT value FROM kv WHERE ns = 'apps' AND key LIKE 'oauth:%'")) {
    const record = json<{ secretId?: unknown; clientSecretId?: unknown } | null>(row.value, null);
    add(record?.secretId);
    add(record?.clientSecretId);
  }
  try { add(services.settings?.get().calendar?.googleSecretId); } catch { /* no settings here */ }
  return held;
}

/** Every single secret and group – of `route` when given – but the app's own (see the header), in name order. */
export function catalogUnits(services: Held & { secrets: Pick<RuntimeServices['secrets'], 'list' | 'groups'> }, route?: string): CatalogUnit[] {
  const wanted = route?.trim().toLowerCase();
  const held = heldByApp(services);
  const own = (entry: { id: string; createdBy?: string }) => entry.createdBy === SYSTEM_ID || held.has(entry.id);
  const units: CatalogUnit[] = [
    ...services.secrets.list().filter((info) => !info.group && !own(info)).map((info) => ({ id: info.id, name: info.label, route: info.route ?? 'notes', group: false })),
    ...services.secrets.groups().filter((group) => !own(group)).map((group) => ({ id: group.id, name: group.label, route: group.route ?? 'notes', group: true })),
  ];
  return units.filter((unit) => !wanted || unit.route === wanted).sort((a, b) => a.name.localeCompare(b.name));
}
