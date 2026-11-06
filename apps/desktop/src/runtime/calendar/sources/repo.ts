// Connected calendars in the database (B-041 track G; migration 068 calendar_sources): the source rows – a vault id
// (`secret_id`: the ICS address or Google's refresh token, never the value), the Google calendar written to
// (`write_calendar_id`, the own "Workforce" calendar), the incremental sync token, the one PC that writes
// (`pc_device_id`), status, last error (a user-safe sentence) and the last good sync. A source's mirrored
// calendar_events rows are read and written with calendar/repo.ts (track A1: bySource, bySeries, byExternal) through
// sources/apply.ts. A source's per-sync state that has no column (the Google window horizon, the client id used at
// connect) lives in kv namespace 'calendar-sources'.
// Owns: SQL for calendar_sources. Never: a secret value, emits events, or decides a sync.

import { bool, int, type Db } from '../../db/database.ts';
import { nul, opt } from '../../store/rows.ts';
import { KvRepo } from '../../store/kv.ts';
import type { CalendarSource, CalendarSourceKind } from '../../../shared/model/calendar.ts';

type Row = Record<string, unknown>;
/** The stored status ('syncing' is held in memory only: a crash never leaves a source "syncing"). */
export type StoredStatus = 'ok' | 'error' | 'reconnect';

export interface SourceRecord {
  id: string;
  ownerId: string;
  kind: CalendarSourceKind;
  label: string;
  color?: string;
  visible: boolean;
  writable: boolean;
  secretId?: string;
  writeCalendarId?: string;
  syncToken?: string;
  pcDeviceId?: string;
  status: StoredStatus;
  error?: string;
  lastSyncAt?: number;
  createdAt: number;
}

/** kv state of one source (no column for it in 068). */
export interface SourceState {
  /** Google: the end of the window the stored rows cover (a full sync renews it). */
  horizon?: number;
  /** Google: the OAuth client the refresh token belongs to. */
  clientId?: string;
  /** Google: the scopes the person granted (one may be left out on Google's consent page). */
  scopes?: string[];
}

const KV_NS = 'calendar-sources';

function toRecord(row: Row): SourceRecord {
  const record: SourceRecord = {
    id: String(row.id), ownerId: String(row.owner_id), kind: String(row.kind) as CalendarSourceKind, label: String(row.label), visible: bool(row.visible),
    writable: bool(row.writable), status: (['ok', 'error', 'reconnect'].includes(String(row.status)) ? String(row.status) : 'ok') as StoredStatus,
    createdAt: Number(row.created_at),
  };
  const optional = { color: opt<string>(row.color), secretId: opt<string>(row.secret_id), writeCalendarId: opt<string>(row.write_calendar_id),
    syncToken: opt<string>(row.sync_token), pcDeviceId: opt<string>(row.pc_device_id), error: opt<string>(row.error) };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
  if (row.last_sync_at !== null && row.last_sync_at !== undefined) record.lastSyncAt = Number(row.last_sync_at);
  return record;
}

/** The public shape (no vault id, no sync token, no write calendar id). */
export function publicSource(record: SourceRecord, status: CalendarSource['status'] = record.status, writable = record.writable): CalendarSource {
  const source: CalendarSource = { id: record.id, ownerId: record.ownerId, kind: record.kind, label: record.label, visible: record.visible, writable, status };
  if (record.color) source.color = record.color;
  if (record.error && status !== 'ok' && status !== 'syncing') source.error = record.error;
  if (record.lastSyncAt !== undefined) source.lastSyncAt = record.lastSyncAt;
  if (record.pcDeviceId) source.pcDeviceId = record.pcDeviceId;
  return source;
}

const COLUMNS: Readonly<Record<string, string>> = {
  label: 'label', color: 'color', visible: 'visible', writable: 'writable', secretId: 'secret_id', writeCalendarId: 'write_calendar_id',
  syncToken: 'sync_token', pcDeviceId: 'pc_device_id', status: 'status', error: 'error', lastSyncAt: 'last_sync_at',
};

export class SourcesRepo {
  readonly db: Db;
  private readonly kv: KvRepo;
  constructor(db: Db) { this.db = db; this.kv = new KvRepo(db); }

  list(ownerId?: string): SourceRecord[] {
    const rows = ownerId === undefined
      ? this.db.all<Row>('SELECT * FROM calendar_sources ORDER BY created_at, id')
      : this.db.all<Row>('SELECT * FROM calendar_sources WHERE owner_id = ? ORDER BY created_at, id', [ownerId]);
    return rows.map(toRecord);
  }

  get(id: string): SourceRecord | undefined {
    const row = this.db.get<Row>('SELECT * FROM calendar_sources WHERE id = ?', [id]);
    return row ? toRecord(row) : undefined;
  }

  insert(record: SourceRecord): void {
    this.db.run(
      `INSERT INTO calendar_sources (id, owner_id, kind, label, color, visible, writable, secret_id, write_calendar_id, sync_token, pc_device_id, status, error,
         last_sync_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.ownerId, record.kind, record.label, nul(record.color), int(record.visible), int(record.writable), nul(record.secretId),
        nul(record.writeCalendarId), nul(record.syncToken), nul(record.pcDeviceId), record.status, nul(record.error), nul(record.lastSyncAt), record.createdAt],
    );
  }

  /** Writes the named fields (`null` clears an optional one). */
  patch(id: string, fields: { [K in keyof SourceRecord]?: SourceRecord[K] | null }): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(fields)) {
      const column = COLUMNS[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? int(value) : (value as string | number | null));
    }
    if (sets.length) this.db.run(`UPDATE calendar_sources SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM calendar_sources WHERE id = ?', [id]);
    this.kv.delete(KV_NS, id);
  }

  state(id: string): SourceState {
    return this.kv.get<SourceState>(KV_NS, id) ?? {};
  }

  setState(id: string, state: SourceState, at: number): void {
    this.kv.set(KV_NS, id, state, at);
  }
}
